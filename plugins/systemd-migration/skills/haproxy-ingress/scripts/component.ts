// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The HAProxy adapter target: the load balancer a publish decision can pick
// when the networkd component's own mechanisms (multipath routes, socket
// units spread with ReusePort=, systemd-socket-proxyd) do not fit. For every
// published port whose publish decision is "haproxy" it renders, per host
// in scope, one frontend bound on the host's address or on the service VIP,
// one backend whose servers come from the networkd component's backend
// table (every instance the plan places, on this host and on the others),
// and a hardened haproxy-migration.service that runs HAProxy in
// master-worker mode with sd_notify. HAProxy is not a systemd page, so the
// component claims none and is listed under "adapters" in coverage.json.
//
// The rendered configuration uses the directives HAProxy 2.4 and later
// accept: master-worker with sd_notify (-Ws), "log stdout format raw" so the
// journal takes the log, and the "http-check send" form of the HTTP probe
// rather than the legacy arguments of "option httpchk". The unit assumes the
// same version; skills/haproxy-ingress/SKILL.md records it.
//
// The decisions HAProxy itself needs (the proxy mode, how backends are
// checked, the PROXY protocol, the stats socket) are raised only once a
// port's publish decision has chosen HAProxy, so a plan that never picks it
// carries none of them: choose "haproxy" in review.ts, then re-run plan.ts
// against the plan to refresh it (test/test-container-migration/README.md
// describes the same refresh for every new decision). Until that refresh
// the renderer uses the defaults and lists them under "needs a human
// decision".

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import type { Healthcheck, Port, Service } from "../../../contract/types.ts";
import { durationToSeconds } from "../../../contract/types.ts";
import { shellQuote } from "../../../contract/unit.ts";
import { type Backend, backendsOf, ingressId, publishId, vipId } from "../../systemd-networkd/scripts/component.ts";

/** The value of a publish decision that hands the port to this component. */
export const PUBLISH_OPTION = "haproxy";
/** The unit name: distributions ship haproxy.service, and the two must not clash. */
export const UNIT = "haproxy-migration.service";
export const CONFIG_DIR = "/etc/haproxy";
export const CONFIG = `${CONFIG_DIR}/haproxy.cfg`;
export const RUNTIME_DIR = "haproxy-migration";
export const STATS_SOCKET = `/run/${RUNTIME_DIR}/admin.sock`;
export const PID_FILE = `/run/${RUNTIME_DIR}/haproxy.pid`;
/** Where the unit looks for the haproxy binary; distributions put it in /usr/sbin. */
export const SEARCH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const STATS = "haproxy.stats.estate";
export function modeId(service: string, port: number, protocol: string): string {
  return `haproxy.mode.${service}.${port}-${protocol}`;
}
export function checkId(service: string, port: number, protocol: string): string {
  return `haproxy.check.${service}.${port}-${protocol}`;
}
export function proxyProtocolId(service: string, port: number, protocol: string): string {
  return `haproxy.proxy-protocol.${service}.${port}-${protocol}`;
}

/** The ingress value that renders the frontend on every host the plan renders (PLAN.md 10.2). */
const EVERY_HOST = "every-host";
const PLACEMENT_HOSTS = "placement-hosts";

/**
 * What the source's healthcheck probes when it is an HTTP request: the path
 * becomes HAProxy's HTTP check and the default mode becomes http. Only a
 * plain http:// URL counts; an https:// probe means the backend speaks TLS
 * itself, which HAProxy passes through in tcp mode.
 */
export function httpProbe(hc: Healthcheck | null): { url: string; path: string } | null {
  if (!hc || hc.test.length === 0 || hc.test[0] === "NONE") return null;
  const command = (hc.test[0] === "CMD-SHELL" || hc.test[0] === "CMD" ? hc.test.slice(1) : hc.test).join(" ");
  const m = /http:\/\/[^\s'"]+/.exec(command);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    return { url: m[0], path: (u.pathname || "/") + u.search };
  } catch {
    return null;
  }
}

/** The defaults the decisions take, derived from the healthcheck; render() uses the same when a decision is not in the plan yet. */
export function defaultsFor(svc: Service): { mode: string; check: string; proxyProtocol: string; probe: ReturnType<typeof httpProbe> } {
  const probe = httpProbe(svc.healthcheck);
  return { mode: probe ? "http" : "tcp", check: probe ? "http" : "tcp-connect", proxyProtocol: "no", probe };
}

function publishedOf(p: Port): number {
  return p.published ?? p.target;
}

function sortedServices(services: Service[]): Service[] {
  return [...services].sort((a, b) => a.name.localeCompare(b.name));
}

function sortedPorts(svc: Service): Port[] {
  return [...svc.ports].sort((a, b) => publishedOf(a) - publishedOf(b) || a.protocol.localeCompare(b.protocol));
}

function portEvidence(svc: Service, p: Port): string[] {
  const out = [`services[${svc.name}].ports[${p.target}] mode=${p.mode} published=${p.published ?? "unset"} protocol=${p.protocol}`];
  out.push(`services[${svc.name}].mode=${svc.mode}${svc.replicas != null ? ` replicas=${svc.replicas}` : ""}`);
  out.push(`services[${svc.name}].endpoint_mode=${svc.endpoint_mode}`);
  const hc = svc.healthcheck;
  if (hc && hc.test.length && hc.test[0] !== "NONE") out.push(`services[${svc.name}].healthcheck.test=${JSON.stringify(hc.test)} interval=${hc.interval ?? "unset"} timeout=${hc.timeout ?? "unset"} retries=${hc.retries ?? "unset"}`);
  else out.push(`services[${svc.name}].healthcheck is not set`);
  return out;
}

/** One frontend HAProxy binds on this host, with the backend it forwards to. */
interface Frontend {
  service: Service;
  port: Port;
  published: number;
  /** The stem the frontend and backend names are built from: `fe_web_app_8080_tcp` and `be_web_app_8080_tcp`. */
  name: string;
  bind: string;
  onVip: boolean;
  ingress: string;
  mode: string;
  check: string;
  proxyProtocol: string;
  probe: ReturnType<typeof httpProbe>;
  backends: Backend[];
  stack: string;
}

function sectionName(service: string, published: number, protocol: string): string {
  return `${service}_${published}_${protocol}`.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

/** The address a frontend binds on when no VIP is decided: the probed address first, else the inventory's node address. */
function hostAddress(ctx: RenderContext): string | null {
  return ctx.capabilities?.addresses?.[0] ?? ctx.inventory.nodes.find((n) => n.hostname === ctx.host)?.addr ?? null;
}

/** Server names: the instance base, suffixed with the host only when the same base sits on several hosts. */
function serverNames(backends: Backend[]): Map<Backend, string> {
  const count = new Map<string, number>();
  for (const b of backends) count.set(b.base, (count.get(b.base) ?? 0) + 1);
  const out = new Map<Backend, string>();
  for (const b of backends) out.set(b, (count.get(b.base) ?? 0) > 1 ? `${b.base}_${b.host}` : b.base);
  return out;
}

function seconds(d: string | null | undefined): number | null {
  const s = durationToSeconds(d);
  return s == null ? null : Math.max(1, Math.round(s));
}

/** haproxy.cfg for the host: global, defaults, one frontend and one backend per published port, in a fixed order. */
export function renderConfig(ctx: RenderContext, frontends: Frontend[], stats: string): string {
  const lines: string[] = [];
  lines.push(`# Rendered by ${ctx.rendererName} for ${ctx.host}: HAProxy fronting the published ports that chose it.`);
  lines.push("# Re-render from the plan instead of editing; haproxy-migration.service checks the file before every start and reload.");
  for (const f of frontends) lines.push(`# ${f.service.name} ${f.published}/${f.port.protocol}: ingress ${f.ingress}, mode ${f.mode}, check ${f.check}, ${f.backends.length} backend(s)`);
  lines.push("");
  lines.push("global");
  lines.push("    log stdout format raw local0");
  if (stats === "socket") {
    lines.push(`    stats socket ${STATS_SOCKET} mode 660 level admin`);
    lines.push("    stats timeout 30s");
  }
  lines.push("");
  lines.push("defaults");
  lines.push("    log global");
  lines.push("    option dontlognull");
  lines.push("    retries 3");
  lines.push("    timeout connect 5s");
  lines.push("    timeout client 30s");
  lines.push("    timeout server 30s");
  for (const f of frontends) {
    const names = serverNames(f.backends);
    lines.push("");
    lines.push(`frontend fe_${f.name}`);
    lines.push(`    mode ${f.mode}`);
    lines.push(`    option ${f.mode === "http" ? "httplog" : "tcplog"}`);
    lines.push(`    bind ${f.bind}:${f.published}`);
    lines.push(`    default_backend be_${f.name}`);
    lines.push("");
    lines.push(`backend be_${f.name}`);
    lines.push(`    mode ${f.mode}`);
    lines.push("    balance roundrobin");
    if (f.check === "http" && f.probe) {
      lines.push("    option httpchk");
      lines.push(`    http-check send meth GET uri ${f.probe.path}`);
      lines.push("    http-check expect status 200-399");
    }
    if (f.check !== "none") {
      const hc = f.service.healthcheck;
      const inter = seconds(hc?.interval);
      const fall = hc?.retries ?? null;
      const timeout = seconds(hc?.timeout);
      if (inter != null || fall != null) lines.push(`    default-server${inter != null ? ` inter ${inter}s` : ""}${fall != null ? ` fall ${fall}` : ""} rise 2`);
      if (timeout != null) lines.push(`    timeout check ${timeout}s`);
    }
    for (const b of f.backends) {
      lines.push(`    # ${b.scope === "local" ? "on this host" : `on ${b.host}, reached over the transport`}: instance ${b.base} of ${b.service}`);
      lines.push(`    server ${names.get(b)} ${b.address}:${b.port}${f.check !== "none" ? " check" : ""}${f.proxyProtocol === "send" ? " send-proxy-v2" : ""}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export const haproxyComponent: Component = {
  id: "haproxy",
  title: "HAProxy (adapter target for published ports)",
  covers: [],
  after: ["service", "machined", "networkd"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    const chosen: string[] = [];
    for (const svc of sortedServices(ctx.inventory.services)) {
      for (const p of sortedPorts(svc)) {
        const published = publishedOf(p);
        if (ctx.previous(publishId(svc.name, published, p.protocol)) !== PUBLISH_OPTION) continue;
        if (p.protocol !== "tcp") continue;
        chosen.push(`${svc.name}:${published}/${p.protocol}`);
        const subject = { kind: "port" as const, name: `${svc.name}:${published}/${p.protocol}` };
        const d = defaultsFor(svc);
        const evidence = portEvidence(svc, p);
        const probeEvidence = d.probe ? [`the healthcheck probes ${d.probe.url}, an HTTP endpoint`] : ["the healthcheck is not an HTTP probe, so nothing says the port speaks HTTP"];
        out.push({
          id: modeId(svc.name, published, p.protocol),
          kind: "choice",
          subject,
          question: `HAProxy fronts port ${published}/${p.protocol} of ${svc.name}. Does it proxy at layer 4 (tcp) or parse HTTP (http)?`,
          options: [
            { value: "tcp", label: "tcp: pass connections through", consequence: "any protocol, TLS included, is forwarded unchanged; no HTTP logging, headers, or routing" },
            { value: "http", label: "http: parse requests", consequence: "HTTP logging, keep-alive handling, and header rules become possible; the backend must speak plain HTTP" },
          ],
          default: d.mode,
          evidence: [...evidence, ...probeEvidence],
        });
        out.push({
          id: checkId(svc.name, published, p.protocol),
          kind: "choice",
          subject,
          question: `How does HAProxy decide an instance of ${svc.name} on ${published}/${p.protocol} is healthy?`,
          options: [
            { value: "tcp-connect", label: "TCP connect", consequence: "an instance is up when the port accepts a connection; interval and failure count come from the source healthcheck when it has them" },
            { value: "http", label: `HTTP GET${d.probe ? ` ${d.probe.path}` : ""}`, consequence: d.probe ? `http-check send meth GET uri ${d.probe.path}, taken from the source healthcheck; statuses 200 to 399 count as healthy` : "needs an HTTP path; the source healthcheck gives none, so choose this only after adding one by hand" },
            { value: "none", label: "no check", consequence: "every instance stays in rotation whatever its state; failed connections surface to the clients" },
          ],
          default: d.check,
          evidence: [...evidence, ...probeEvidence],
        });
        out.push({
          id: proxyProtocolId(svc.name, published, p.protocol),
          kind: "choice",
          subject,
          question: `Should HAProxy send the PROXY protocol header to the instances of ${svc.name} on ${published}/${p.protocol}, so they see the client's address?`,
          options: [
            { value: "no", label: "no header", consequence: "the instance sees HAProxy's address as the client; in http mode X-Forwarded-For is not added either" },
            { value: "send", label: "send PROXY protocol v2", consequence: "send-proxy-v2 on every server line; the instance must accept the header (accept-proxy, proxy_protocol on, or equivalent) or every connection fails" },
          ],
          default: d.proxyProtocol,
          evidence,
        });
      }
    }
    if (chosen.length) {
      out.push({
        id: STATS,
        kind: "choice",
        subject: { kind: "estate", name: "estate" },
        question: "Expose HAProxy's runtime API on a stats socket so the rollout controller and operators can drain and inspect servers?",
        options: [
          { value: "socket", label: "admin socket under the runtime directory", consequence: `stats socket ${STATS_SOCKET} mode 660 level admin, owned by the unit's user; "set server <backend>/<server> state drain" takes an instance out of rotation without a re-render` },
          { value: "no", label: "no runtime API", consequence: "servers can only be drained by re-rendering the configuration and reloading" },
        ],
        default: "socket",
        evidence: chosen.map((c) => `${c} publishes through HAProxy`),
      });
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const frontends: Frontend[] = [];
    const missing: string[] = [];
    for (const svc of sortedServices(ctx.inventory.services)) {
      for (const p of sortedPorts(svc)) {
        const published = publishedOf(p);
        if (ctx.valueOr(publishId(svc.name, published, p.protocol), "host") !== PUBLISH_OPTION) continue;
        if (p.protocol !== "tcp") {
          ctx.note(`${svc.name}: port ${published}/${p.protocol} chose HAProxy, which proxies TCP only; the port is not fronted, choose another publish option for it`, "decision");
          continue;
        }
        const ingress = ctx.valueOr(ingressId(svc.name, published, p.protocol), PLACEMENT_HOSTS);
        const local = ctx.instances.some((i) => i.service.name === svc.name);
        if (ingress !== EVERY_HOST && !local) continue;
        const d = defaultsFor(svc);
        const read = (id: string, fallback: string): string => {
          if (!ctx.hasDecision(id)) missing.push(`${id} (used ${fallback})`);
          return ctx.valueOr(id, fallback);
        };
        const mode = read(modeId(svc.name, published, p.protocol), d.mode);
        let check = read(checkId(svc.name, published, p.protocol), d.check);
        if (check === "http" && !d.probe) {
          ctx.note(`${svc.name}: the HTTP check for port ${published}/${p.protocol} has no path because the source healthcheck is not an HTTP probe; a TCP connect check is rendered instead, add the path to haproxy.cfg by hand or change ${checkId(svc.name, published, p.protocol)}`, "decision");
          check = "tcp-connect";
        }
        const proxyProtocol = read(proxyProtocolId(svc.name, published, p.protocol), d.proxyProtocol);
        const onVip = ctx.resolvable(vipId(svc.name));
        const bind = onVip ? ctx.value(vipId(svc.name)) : hostAddress(ctx);
        if (!bind) ctx.note(`${svc.name}: ${ctx.host} has no probed address and no address in the inventory, so the frontend for port ${published} binds every address (*)`, "decision");
        const backends = [...backendsOf(ctx, svc, p, ctx.host)].sort((a, b) => a.host.localeCompare(b.host) || a.base.localeCompare(b.base));
        if (backends.length === 0) ctx.note(`${svc.name}: no backend is known for port ${published}/${p.protocol} on ${ctx.host}; the plan places no instance the backend table can resolve`, "decision");
        frontends.push({ service: svc, port: p, published, name: sectionName(svc.name, published, p.protocol), bind: bind ?? "*", onVip, ingress, mode, check, proxyProtocol, probe: d.probe, backends, stack: svc.stack ?? "nostack" });
      }
    }
    if (frontends.length === 0) return;

    if (!ctx.hasDecision(STATS)) missing.push(`${STATS} (used socket)`);
    const stats = ctx.valueOr(STATS, "socket");
    for (const m of new Set(missing)) ctx.note(`haproxy: decision ${m} is not in the plan yet; re-run plan.ts against this plan to review it`, "decision");

    // A plain service on this host binds the published port itself; the frontend cannot share it.
    for (const f of frontends) {
      for (const b of f.backends) {
        if (b.scope !== "local" || b.port !== f.published) continue;
        if (f.bind === "*" || b.address === f.bind) ctx.note(`${f.service.name}: instance ${b.base} on ${ctx.host} listens on ${b.address}:${b.port}, the same address and port the HAProxy frontend binds; give the service a VIP (networkd.vip.${f.service.name}), run it as a machine on a lease, or move the instance to another port`, "decision");
      }
    }

    ctx.file(CONFIG.replace(/^\//, ""), renderConfig(ctx, frontends, stats));

    const stacks = [...new Set(frontends.map((f) => f.stack))].sort();
    const u = ctx.unit(UNIT, [
      `Rendered by ${ctx.rendererName}: HAProxy fronting ${frontends.map((f) => `${f.service.name} ${f.published}/${f.port.protocol}`).join(", ")} on ${ctx.host}`,
      `Master-worker mode with sd_notify (haproxy -Ws); the configuration is ${CONFIG}. Named apart from a distribution's haproxy.service.`,
      "HAProxy 2.4 or later is assumed; see the haproxy-ingress skill for the directives that fixes.",
    ]);
    u.add("Unit", "Description", `HAProxy ingress for ${frontends.map((f) => `${f.service.name}:${f.published}`).join(", ")} (migrated from Docker Swarm)`);
    u.add("Unit", "Documentation", "man:haproxy(1)");
    u.addAll("Unit", "PartOf", stacks.map((s) => `${s}.target`));
    u.add("Unit", "After", "network-online.target");
    u.add("Unit", "Wants", "network-online.target");
    u.add("Unit", "ConditionHost", ctx.host);
    if (stacks.length > 1) ctx.note(`haproxy: ${ctx.host} fronts ports of stacks ${stacks.join(", ")} in one HAProxy; the unit is PartOf= each of their targets, so stopping any one of them takes every frontend on this host down. Split the stacks over separate hosts, or accept that the frontends share a lifetime.`, "decision");

    u.add("Service", "Type", "notify");
    u.add("Service", "ExecSearchPath", SEARCH_PATH);
    u.add("Service", "ExecStartPre", `haproxy -c -q -f ${CONFIG}`);
    u.add("Service", "ExecStart", `haproxy -Ws -f ${CONFIG} -p ${PID_FILE}`);
    u.add("Service", "ExecReload", `haproxy -c -q -f ${CONFIG}`);
    u.add("Service", "ExecReload", "kill -USR2 $MAINPID");
    u.add("Service", "KillMode", "mixed");
    u.add("Service", "KillSignal", "SIGUSR1");
    u.add("Service", "SuccessExitStatus", "143");
    u.add("Service", "Restart", "on-failure");
    u.add("Service", "RestartSec", "2");
    u.add("Service", "TimeoutStopSec", "30");
    u.add("Service", "DynamicUser", "yes");
    u.add("Service", "RuntimeDirectory", RUNTIME_DIR);
    u.add("Service", "RuntimeDirectoryMode", "0750");
    u.add("Service", "ProtectSystem", "strict");
    u.add("Service", "ProtectHome", "yes");
    u.add("Service", "PrivateTmp", "yes");
    u.add("Service", "PrivateDevices", "yes");
    u.add("Service", "ProtectKernelTunables", "yes");
    u.add("Service", "ProtectKernelModules", "yes");
    u.add("Service", "ProtectKernelLogs", "yes");
    u.add("Service", "ProtectControlGroups", "yes");
    u.add("Service", "ProtectClock", "yes");
    u.add("Service", "ProtectHostname", "yes");
    u.add("Service", "ProtectProc", "invisible");
    u.add("Service", "RestrictAddressFamilies", "AF_INET AF_INET6 AF_UNIX");
    u.add("Service", "RestrictNamespaces", "yes");
    u.add("Service", "RestrictRealtime", "yes");
    u.add("Service", "RestrictSUIDSGID", "yes");
    u.add("Service", "LockPersonality", "yes");
    u.add("Service", "NoNewPrivileges", "yes");
    u.add("Service", "CapabilityBoundingSet", "CAP_NET_BIND_SERVICE");
    u.add("Service", "AmbientCapabilities", "CAP_NET_BIND_SERVICE");
    u.add("Service", "SystemCallArchitectures", "native");
    u.add("Service", "SystemCallFilter", "@system-service");
    for (const port of [...new Set(frontends.map((f) => f.published))].sort((a, b) => a - b)) u.add("Service", "SocketBindAllow", `tcp:${port}`);
    u.add("Service", "SocketBindDeny", "any");
    u.add("Service", "SyslogIdentifier", "haproxy-migration");
    u.addAll("Install", "WantedBy", stacks.map((s) => `${s}.target`));
    u.add("X-Migration", "Source", "docker-swarm");
    u.add("X-Migration", "Renderer", ctx.rendererName);
    u.add("X-Migration", "Form", "haproxy");
    u.add("X-Migration", "Stacks", stacks.join(" "));
    u.add("X-Migration", "Ports", frontends.map((f) => `${f.service.name}:${f.published}/${f.port.protocol}`).join(" "));
    u.add("X-Migration", "HAProxyVersion", "2.4");

    ctx.expect("units", UNIT);
    for (const s of stacks) ctx.wantedByStack(s, UNIT);
    for (const f of frontends) ctx.expectPort(f.published, f.port.protocol);
    ctx.install("post", `systemctl try-reload-or-restart ${shellQuote(UNIT)}`);

    for (const f of frontends) {
      ctx.note(`${f.service.name}: port ${f.published}/${f.port.protocol} is fronted by HAProxy on ${ctx.host} (${f.onVip ? `VIP ${f.bind}` : `host address ${f.bind}`}, ingress ${f.ingress}); ${f.backends.length} backend(s): ${f.backends.map((b) => `${b.base}@${b.host}`).join(", ") || "none"}`);
    }
    if (stats === "socket") ctx.note(`haproxy: the runtime API is at ${STATS_SOCKET}, mode 660 under the unit's dynamic user, so only root reaches it; that is the socket the rollout controller drains a server through`);
    ctx.note(`haproxy: the unit assumes HAProxy 2.4 or later (master-worker with sd_notify, "log stdout", and the "http-check send" form of the HTTP probe); check the host's haproxy -v before installing`);
    ctx.note(`haproxy: TLS termination is not rendered; a certificate and key would be credentials (LoadCredentialEncrypted= on ${UNIT}, read from $CREDENTIALS_DIRECTORY by a bind ... ssl crt line) and the frontend's mode would need reviewing; decide it before a fronted port is exposed beyond the estate`, "decision");
  },
};
