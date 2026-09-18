// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The HAProxy adapter: nothing at all until a published port's publish
// decision chooses "haproxy", and then, per host in the ingress scope, a
// deterministic /etc/haproxy/haproxy.cfg and a hardened
// haproxy-migration.service whose every directive the catalogue knows. The
// fixture estate publishes web_app on 8080 through the Swarm routing mesh,
// which is the port these tests hand to HAProxy.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkUnitText } from "../../contract/catalog.ts";
import { composePlan, composeRender } from "../../contract/compose.ts";
import type { Plan } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { CONFIG, STATS, STATS_SOCKET, UNIT, checkId, defaultsFor, haproxyComponent, httpProbe, modeId, proxyProtocolId } from "../../skills/haproxy-ingress/scripts/component.ts";
import { ingressId, publishId, vipId } from "../../skills/systemd-networkd/scripts/component.ts";
import { planFor } from "../../skills/systemd-service/scripts/render.ts";

const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const inv: Inventory = normalize(capture);

const PORT = 8080;
const PUBLISH = publishId("web_app", PORT, "tcp");
const CFG = `etc/haproxy/haproxy.cfg`;
const MGR = "hosts/swarm-mgr-1";
const WRK = "hosts/swarm-wrk-1";

/**
 * Set a decision in a plan whether or not a component raised it yet: the
 * networkd stream owns the publish, ingress, and VIP decisions, and this
 * component's own decisions only appear once a publish decision has chosen
 * it, so the render tests inject what they want to exercise.
 */
function decide(plan: Plan, id: string, value: string): Plan {
  const d = plan.decisions.find((x) => x.id === id);
  if (d) d.chosen = value;
  else plan.decisions.push({ id, component: "haproxy", kind: "value", subject: { kind: "estate", name: "estate" }, question: `test fixture for ${id}`, chosen: value });
  return plan;
}

/** A plan for the fixture with web_app's published port handed to HAProxy, plus whatever else the case needs. */
function haproxyPlan(extra: Record<string, string> = {}): Plan {
  const plan = decide(planFor(inv), PUBLISH, "haproxy");
  for (const [id, value] of Object.entries(extra)) decide(plan, id, value);
  return plan;
}

/** One section of a rendered configuration, up to the blank line before the next one. */
function section(cfg: string, header: string): string {
  const start = cfg.indexOf(`\n${header}\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = cfg.slice(start + 1);
  const end = rest.indexOf("\n\n");
  return end < 0 ? rest : rest.slice(0, end);
}

function renderWith(extra: Record<string, string> = {}) {
  return composeRender(inv, haproxyPlan(extra), COMPONENTS, { acceptDefaults: true });
}

describe("the haproxy component in the registry", () => {
  test("is registered as an adapter that claims no page and renders after the components it reads", () => {
    expect(COMPONENTS).toContain(haproxyComponent);
    expect(haproxyComponent.covers).toEqual([]);
    expect(haproxyComponent.after).toEqual(["service", "machined", "networkd"]);
  });

  test("reads an HTTP probe out of the source healthcheck and leaves the others alone", () => {
    expect(httpProbe({ test: ["CMD-SHELL", "curl -fsS http://localhost:8080/healthz || exit 1"], interval: null, timeout: null, retries: null, start_period: null })).toEqual({ url: "http://localhost:8080/healthz", path: "/healthz" });
    expect(httpProbe({ test: ["CMD-SHELL", "pg_isready -U app"], interval: null, timeout: null, retries: null, start_period: null })).toBeNull();
    expect(httpProbe({ test: ["CMD", "curl", "-f", "https://localhost:8443/"], interval: null, timeout: null, retries: null, start_period: null })).toBeNull();
    expect(httpProbe(null)).toBeNull();
    const web = inv.services.find((s) => s.name === "web_app")!;
    expect(defaultsFor(web)).toMatchObject({ mode: "http", check: "http", proxyProtocol: "no" });
    const db = inv.services.find((s) => s.name === "data_postgres")!;
    expect(defaultsFor(db)).toMatchObject({ mode: "tcp", check: "tcp-connect" });
  });
});

describe("the decisions HAProxy raises", () => {
  test("a plan where no port chose HAProxy carries none of them", () => {
    const { plan } = composePlan(inv, COMPONENTS);
    expect(plan.decisions.filter((d) => d.id.startsWith("haproxy."))).toEqual([]);
  });

  test("once the publish decision chose haproxy, the mode, check, PROXY protocol, and stats decisions appear with evidence", () => {
    const { plan } = composePlan(inv, COMPONENTS, { existing: haproxyPlan() });
    const byId = (id: string) => plan.decisions.find((d) => d.id === id);
    const mode = byId(modeId("web_app", PORT, "tcp"))!;
    expect(mode.component).toBe("haproxy");
    expect(mode.options!.map((o) => o.value)).toEqual(["tcp", "http"]);
    expect(mode.default).toBe("http");
    expect(mode.evidence).toContain("services[web_app].ports[8080] mode=ingress published=8080 protocol=tcp");
    expect(mode.evidence!.some((e) => e.includes("http://localhost:8080/healthz"))).toBe(true);

    const check = byId(checkId("web_app", PORT, "tcp"))!;
    expect(check.options!.map((o) => o.value)).toEqual(["tcp-connect", "http", "none"]);
    expect(check.default).toBe("http");
    expect(check.options!.find((o) => o.value === "http")!.consequence).toContain("/healthz");

    const proxy = byId(proxyProtocolId("web_app", PORT, "tcp"))!;
    expect(proxy.options!.map((o) => o.value)).toEqual(["no", "send"]);
    expect(proxy.default).toBe("no");

    const stats = byId(STATS)!;
    expect(stats.subject).toEqual({ kind: "estate", name: "estate" });
    expect(stats.options!.map((o) => o.value)).toEqual(["socket", "no"]);
    expect(stats.default).toBe("socket");
    expect(stats.evidence).toContain("web_app:8080/tcp publishes through HAProxy");

    // The ports that kept their own publish decision raise nothing.
    expect(plan.decisions.filter((d) => d.id.startsWith("haproxy.")).map((d) => d.id).sort()).toEqual([checkId("web_app", PORT, "tcp"), modeId("web_app", PORT, "tcp"), proxyProtocolId("web_app", PORT, "tcp"), STATS].sort());
  });
});

describe("rendering the fronted port", () => {
  const r = renderWith();
  const cfg = r.files[`${WRK}/${CFG}`] as string;
  const unit = r.files[`${WRK}/etc/systemd/system/${UNIT}`] as string;

  test("the configuration is written where the unit reads it, on the placement host only", () => {
    expect(CONFIG).toBe("/etc/haproxy/haproxy.cfg");
    expect(cfg).toBeDefined();
    expect(r.files[`${MGR}/${CFG}`]).toBeUndefined();
    expect(r.files[`${MGR}/etc/systemd/system/${UNIT}`]).toBeUndefined();
  });

  test("global carries the stats socket, defaults the timeouts, and the frontend binds the host address", () => {
    expect(cfg).toContain(`    stats socket ${STATS_SOCKET} mode 660 level admin`);
    expect(cfg).toContain("    log stdout format raw local0");
    expect(cfg).toContain("    timeout connect 5s");
    expect(cfg).toContain("frontend fe_web_app_8080_tcp");
    expect(cfg).toContain("    bind 10.0.0.12:8080");
    expect(cfg).toContain("    default_backend be_web_app_8080_tcp");
  });

  test("the backend balances round robin over the servers the backend table gives, named by instance base", () => {
    expect(cfg).toContain("backend be_web_app_8080_tcp");
    expect(cfg).toContain("    balance roundrobin");
    expect(cfg).toContain("    server web_app 10.0.0.12:8080 check");
    expect(cfg).not.toContain("send-proxy-v2");
  });

  test("the HTTP check comes from the source healthcheck, with its interval, retries, and timeout", () => {
    expect(cfg).toContain("    option httpchk");
    expect(cfg).toContain("    http-check send meth GET uri /healthz");
    expect(cfg).toContain("    http-check expect status 200-399");
    expect(cfg).toContain("    default-server inter 15s fall 3 rise 2");
    expect(cfg).toContain("    timeout check 5s");
  });

  test("the configuration is deterministic: the same plan renders the same bytes", () => {
    expect((renderWith().files[`${WRK}/${CFG}`] as string)).toBe(cfg);
  });

  test("the unit runs HAProxy in master-worker mode under sd_notify and validates before it starts or reloads", () => {
    expect(unit).toContain("Type=notify");
    expect(unit).toContain("ExecStartPre=haproxy -c -q -f /etc/haproxy/haproxy.cfg");
    expect(unit).toContain("ExecStart=haproxy -Ws -f /etc/haproxy/haproxy.cfg -p /run/haproxy-migration/haproxy.pid");
    expect(unit).toContain("ExecReload=haproxy -c -q -f /etc/haproxy/haproxy.cfg");
    expect(unit).toContain("ExecReload=kill -USR2 $MAINPID");
    expect(unit).toContain("ExecSearchPath=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    // Named apart from the distribution's own unit.
    expect(UNIT).toBe("haproxy-migration.service");
  });

  test("the unit is hardened: a dynamic user, no new privileges, and only the capability that binds a low port", () => {
    expect(unit).toContain("DynamicUser=yes");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("RuntimeDirectory=haproxy-migration");
    expect(unit).toContain("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX");
    expect(unit).toContain("SocketBindAllow=tcp:8080");
    expect(unit).toContain("SocketBindDeny=any");
  });

  test("the unit belongs to the stack it fronts and the stack target wants it", () => {
    expect(unit).toContain("PartOf=web.target");
    expect(unit).toContain("WantedBy=web.target");
    expect(unit).toContain("ConditionHost=swarm-wrk-1");
    expect(r.files[`${WRK}/etc/systemd/system/web.target`]).toContain(`Wants=${UNIT}`);
  });

  test("every directive of the unit is one the catalogue documents", () => {
    const check = checkUnitText(unit, "service");
    expect(check.unknown).toEqual([]);
    expect(check.skipped_sections).toEqual(["X-Migration"]);
    expect(check.minimum_version).not.toBeNull();
  });

  test("the expectations name the unit and the port, and install.sh reloads it after daemon-reload", () => {
    expect(r.hosts["swarm-wrk-1"]!.units).toContain(UNIT);
    expect(r.hosts["swarm-wrk-1"]!.ports).toContainEqual({ port: 8080, protocol: "tcp" });
    expect(r.hosts["swarm-mgr-1"]!.units).not.toContain(UNIT);
    expect(r.files[`${WRK}/install.sh`]).toContain(`systemctl try-reload-or-restart '${UNIT}'`);
  });

  test("the notes name the decisions the plan has not seen, the version assumed, and that TLS is out of scope", () => {
    expect(r.decisions.some((n) => n.includes(`decision ${modeId("web_app", PORT, "tcp")} (used http) is not in the plan yet`))).toBe(true);
    expect(r.decisions.some((n) => n.includes(`decision ${STATS} (used socket) is not in the plan yet`))).toBe(true);
    expect(r.decisions.some((n) => n.includes("TLS termination is not rendered") && n.includes("credentials"))).toBe(true);
    expect(r.notes.some((n) => n.includes("HAProxy 2.4 or later"))).toBe(true);
    // The instance on this host already owns 10.0.0.12:8080, which the frontend wants.
    expect(r.decisions.some((n) => n.includes("the same address and port the HAProxy frontend binds"))).toBe(true);
  });
});

describe("the ingress scope and the service VIP", () => {
  test("every-host renders the frontend on a host that runs no instance, reaching the placement host over the transport", () => {
    const r = renderWith({ [ingressId("web_app", PORT, "tcp")]: "every-host" });
    const mgr = r.files[`${MGR}/${CFG}`] as string;
    expect(mgr).toBeDefined();
    expect(mgr).toContain("# web_app 8080/tcp: ingress every-host");
    expect(mgr).toContain("    bind 10.0.0.11:8080");
    expect(mgr).toContain("    # on swarm-wrk-1, reached over the transport: instance web_app of web_app");
    expect(mgr).toContain("    server web_app 10.0.0.12:8080 check");
    expect(r.files[`${MGR}/etc/systemd/system/${UNIT}`]).toContain("ConditionHost=swarm-mgr-1");
    expect(r.hosts["swarm-mgr-1"]!.units).toContain(UNIT);
    expect(r.hosts["swarm-mgr-1"]!.ports).toContainEqual({ port: 8080, protocol: "tcp" });
  });

  test("a decided VIP is what the frontend binds, on every host in scope", () => {
    const r = renderWith({ [ingressId("web_app", PORT, "tcp")]: "every-host", [vipId("web_app")]: "10.100.0.7" });
    expect(r.files[`${MGR}/${CFG}`]).toContain("    bind 10.100.0.7:8080");
    expect(r.files[`${WRK}/${CFG}`]).toContain("    bind 10.100.0.7:8080");
    expect(r.files[`${WRK}/${CFG}`]).not.toContain("    bind 10.0.0.12:8080");
    expect(r.notes.some((n) => n.includes("VIP 10.100.0.7"))).toBe(true);
    // Binding the VIP takes the frontend off the address the instance holds.
    expect(r.decisions.some((n) => n.includes("the same address and port the HAProxy frontend binds"))).toBe(false);
  });
});

describe("the mode, check, and PROXY protocol decisions", () => {
  test("tcp mode with a TCP connect check drops the HTTP probe and logs at layer 4", () => {
    const cfg = renderWith({ [modeId("web_app", PORT, "tcp")]: "tcp", [checkId("web_app", PORT, "tcp")]: "tcp-connect" }).files[`${WRK}/${CFG}`] as string;
    expect(cfg).toContain("    mode tcp");
    expect(cfg).toContain("    option tcplog");
    expect(cfg).not.toContain("httpchk");
    expect(cfg).toContain("    server web_app 10.0.0.12:8080 check");
    expect(cfg).toContain("    default-server inter 15s fall 3 rise 2");
  });

  test("http mode with an HTTP check parses requests and probes the healthcheck's path", () => {
    const cfg = renderWith({ [modeId("web_app", PORT, "tcp")]: "http", [checkId("web_app", PORT, "tcp")]: "http" }).files[`${WRK}/${CFG}`] as string;
    expect(cfg).toContain("    mode http");
    expect(cfg).toContain("    option httplog");
    expect(cfg).toContain("    http-check send meth GET uri /healthz");
  });

  test("no check leaves every server in rotation and drops the check keyword", () => {
    const cfg = renderWith({ [checkId("web_app", PORT, "tcp")]: "none" }).files[`${WRK}/${CFG}`] as string;
    expect(cfg).toContain("    server web_app 10.0.0.12:8080\n");
    expect(cfg).not.toContain("10.0.0.12:8080 check");
    expect(cfg).not.toContain("default-server");
    expect(cfg).not.toContain("timeout check");
    expect(cfg).not.toContain("httpchk");
  });

  test("an HTTP check for a service with no HTTP probe falls back to a TCP connect and says so", () => {
    const plan = haproxyPlan();
    decide(plan, publishId("data_exporter", 9187, "tcp"), "haproxy");
    decide(plan, checkId("data_exporter", 9187, "tcp"), "http");
    const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
    const cfg = r.files[`${WRK}/${CFG}`] as string;
    const backend = section(cfg, "backend be_data_exporter_9187_tcp");
    expect(backend).toContain("    server data_exporter 10.0.0.12:9187 check");
    expect(backend).not.toContain("http-check send");
    expect(backend).not.toContain("httpchk");
    expect(r.decisions.some((n) => n.includes("data_exporter") && n.includes("a TCP connect check is rendered instead"))).toBe(true);
  });

  test("sending the PROXY protocol adds send-proxy-v2 to every server line", () => {
    const cfg = renderWith({ [proxyProtocolId("web_app", PORT, "tcp")]: "send" }).files[`${WRK}/${CFG}`] as string;
    expect(cfg).toContain("    server web_app 10.0.0.12:8080 check send-proxy-v2");
  });

  test("turning the stats socket off leaves the runtime API out of global", () => {
    const cfg = renderWith({ [STATS]: "no" }).files[`${WRK}/${CFG}`] as string;
    expect(cfg).not.toContain("stats socket");
    expect(cfg).toContain("global\n    log stdout format raw local0\n\ndefaults");
  });
});

describe("two stacks on one host", () => {
  const plan = haproxyPlan();
  decide(plan, publishId("data_exporter", 9187, "tcp"), "haproxy");
  const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
  const unit = r.files[`${WRK}/etc/systemd/system/${UNIT}`] as string;

  test("one unit fronts both, is part of each stack's target, and says what that couples", () => {
    expect(unit).toContain("PartOf=web.target");
    expect(unit).toContain("PartOf=data.target");
    expect(unit).toContain("WantedBy=data.target");
    expect(unit).toContain("WantedBy=web.target");
    expect(unit).toContain("SocketBindAllow=tcp:8080");
    expect(unit).toContain("SocketBindAllow=tcp:9187");
    expect(checkUnitText(unit, "service").unknown).toEqual([]);
    expect(r.decisions.some((n) => n.includes("stopping any one of them takes every frontend on this host down"))).toBe(true);
    expect(r.files[`${WRK}/etc/systemd/system/data.target`]).toContain(`Wants=${UNIT}`);
  });

  test("the frontends are ordered by service and port, so the file does not move between runs", () => {
    const cfg = r.files[`${WRK}/${CFG}`] as string;
    expect(cfg.indexOf("frontend fe_data_exporter_9187_tcp")).toBeLessThan(cfg.indexOf("frontend fe_web_app_8080_tcp"));
    expect(r.hosts["swarm-wrk-1"]!.ports).toContainEqual({ port: 9187, protocol: "tcp" });
  });
});

describe("no port chose HAProxy", () => {
  const r = composeRender(inv, planFor(inv), COMPONENTS, { acceptDefaults: true });

  test("nothing is rendered, expected, or noted", () => {
    expect(Object.keys(r.files).filter((f) => f.includes("haproxy"))).toEqual([]);
    for (const h of Object.values(r.hosts)) expect(h.units).not.toContain(UNIT);
    expect(r.notes.some((n) => n.startsWith("haproxy:"))).toBe(false);
  });
});
