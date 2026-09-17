// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Load balancing for published ports (PLAN.md 10.2): the backend table every
// option and every adapter reads, and the three mechanisms systemd itself
// provides. `reuseport` lets the kernel spread connections over the instances
// on one host; `socket-proxyd` puts one socket-activated
// systemd-socket-proxyd(8) in front of every backend, local or remote;
// `multipath` gives the service an address of its own on a dummy netdev and
// routes it over the backends with MultiPathRoute= or a nexthop group.
// `haproxy` is a label here and an adapter component elsewhere.
//
// None of the three is health aware. The rollout controller stops the sockets
// of a drained host (PLAN.md 10.4), which is what takes a backend out.

import { createHash } from "node:crypto";
import type { RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import type { Port, Service } from "../../../contract/types.ts";
import { shellQuote, unitBaseName } from "../../../contract/unit.ts";
import {
  BACKENDS,
  type Backend,
  INGRESS_EVERY_HOST,
  INGRESS_PLACEMENT,
  type Lease,
  LEASES,
  PROXIES,
  PROXY_IDLE,
  PUBLISH_MULTIPATH,
  PUBLISH_PROXY,
  type Proxy,
  type Section,
  type SectionEntries,
  hostAddress,
  ingressId,
  linkName,
  multipathId,
  placementOf,
  portKey,
  publishId,
  renderSections,
  renderedHosts,
  vipId,
} from "./shared.ts";

/** The template the socket units activate; named apart from anything a distribution ships. */
export const PROXY_TEMPLATE = "migration-socket-proxy@.service";
/** Where systemd installs systemd-socket-proxyd(8). */
export const PROXY_BINARY = "/usr/lib/systemd/systemd-socket-proxyd";
/** The default time an idle proxy stays resident; the estate decision overrides it. */
export const PROXY_IDLE_DEFAULT = "5min";

/** The multipath forms the plan offers. */
export const MULTIPATH_ROUTE = "multipath-route";
export const MULTIPATH_NEXTHOP = "nexthop-group";

export function publishedOf(p: Port): number {
  return p.published ?? p.target;
}

export function sortedServices(services: Service[]): Service[] {
  return [...services].sort((a, b) => a.name.localeCompare(b.name));
}

export function sortedPorts(svc: Service): Port[] {
  return [...svc.ports].sort((a, b) => publishedOf(a) - publishedOf(b) || a.protocol.localeCompare(b.protocol));
}

/**
 * The backends of a service's published port as seen from `host`: every
 * instance the plan places, on this host and on the others. A machine answers
 * on its lease at the port the container opened; a plain service answers on
 * its host's address at the published port, offset for the second and further
 * instances that share a host. Adapters (haproxy-ingress) call this.
 */
export function backendsOf(ctx: RenderContext, service: Service, port: { target: number; published: number | null; protocol: string }, host: string): Backend[] {
  const leases = ctx.get<Lease[]>(LEASES) ?? [];
  const placed = placementOf(ctx).get(service.name) ?? new Map<string, number>();
  const published = port.published ?? port.target;
  const out: Backend[] = [];
  for (const h of [...placed.keys()].sort()) {
    const count = placed.get(h)!;
    const addr = hostAddress(ctx, h);
    for (let index = 1; index <= count; index++) {
      const base = unitBaseName(service.name, index, count);
      const lease = leases.find((l) => l.host === h && l.base === base && l.service === service.name);
      const address = lease?.address ?? addr;
      if (!address) continue;
      out.push({
        service: service.name,
        base,
        host: h,
        address,
        port: lease ? port.target : count > 1 ? published + (index - 1) : published,
        protocol: port.protocol,
        scope: h === host ? "local" : "remote",
      });
    }
  }
  return out;
}

/** The hosts a published port exists on: the placement, or every host the plan renders. */
export function ingressScope(ctx: RenderContext, svc: Service, published: number, protocol: string): string[] {
  const mode = ctx.valueOr(ingressId(svc.name, published, protocol), INGRESS_PLACEMENT);
  if (mode === INGRESS_EVERY_HOST) return renderedHosts(ctx);
  return [...(placementOf(ctx).get(svc.name)?.keys() ?? [])].sort();
}

/** Server-side names for the backends of one port: the instance base, suffixed with the host when several hosts share it. */
function backendNames(backends: Backend[]): Map<Backend, string> {
  const count = new Map<string, number>();
  for (const b of backends) count.set(b.base, (count.get(b.base) ?? 0) + 1);
  const out = new Map<Backend, string>();
  for (const b of backends) out.set(b, (count.get(b.base) ?? 0) > 1 ? `${b.base}-${b.host}` : b.base);
  return out;
}

/**
 * The first nexthop id of a service's group. networkd picks unused ids by
 * itself, but a Group= has to name them, so they are derived from the service
 * name and stay the same on every host and every run.
 */
export function nextHopBase(service: string): number {
  return (createHash("sha256").update(service).digest().readUInt32BE(0) % 1_000_000) + 1;
}

/** The dummy interface that anchors a service's VIP. */
export function vipLink(service: string): string {
  return linkName("vip", service);
}

/**
 * Everything a published port needs beyond the instance's own bind: the
 * sockets of `reuseport` are rendered with the instances in component.ts, the
 * rest here. Runs after the zone bridges, so the lease table is complete.
 */
export function renderPublishing(ctx: RenderContext): void {
  const backends: Record<string, Backend[]> = {};
  const proxies: Proxy[] = [];
  for (const svc of sortedServices(ctx.inventory.services)) {
    for (const p of sortedPorts(svc)) {
      const published = publishedOf(p);
      const table = backendsOf(ctx, svc, p, ctx.host);
      backends[portKey(svc.name, published, p.protocol)] = table;
      const how = ctx.valueOr(publishId(svc.name, published, p.protocol), "host");
      const scope = ingressScope(ctx, svc, published, p.protocol);
      if (!scope.includes(ctx.host)) continue;
      if (how === PUBLISH_PROXY) renderProxies(ctx, svc, p, published, table, proxies);
      if (how === PUBLISH_MULTIPATH) renderMultipath(ctx, svc, p, published, table, scope);
    }
  }
  ctx.set(BACKENDS, backends);
  ctx.set(PROXIES, proxies);
  if (proxies.length) renderProxyTemplate(ctx, proxies);
}

/** One .socket per backend on the published port, each activating a proxy to that backend. */
function renderProxies(ctx: RenderContext, svc: Service, p: Port, published: number, table: Backend[], proxies: Proxy[]): void {
  if (p.protocol !== "tcp") {
    ctx.note(`${svc.name}: port ${published}/${p.protocol} chose systemd-socket-proxyd, which forwards stream sockets only; choose another option for a datagram port`, "decision");
    return;
  }
  if (table.length === 0) {
    ctx.note(`${svc.name}: port ${published}/${p.protocol} chose systemd-socket-proxyd but the plan places no instance whose address is known, so no proxy is rendered on ${ctx.host}`, "decision");
    return;
  }
  const vip = ctx.resolvable(vipId(svc.name)) ? ctx.value(vipId(svc.name)) : null;
  const listen = vip ? `${vip}:${published}` : String(published);
  const names = backendNames(table);
  for (const b of table) {
    const label = names.get(b)!;
    const socket = `${svc.name}-${published}-${label}.socket`;
    const instance = `${b.address}:${b.port}`;
    const unit = `migration-socket-proxy@${instance}.service`;
    const s = ctx.unit(socket, [
      `Rendered by ${ctx.rendererName}: one of ${table.length} sockets sharing port ${published}/${p.protocol} of ${svc.name} on ${ctx.host} with ReusePort=yes`,
      `Connections the kernel hands this socket are forwarded to ${instance} (${b.scope === "local" ? "on this host" : `on ${b.host}, over the transport`}) by systemd-socket-proxyd(8).`,
    ]);
    s.add("Unit", "Description", `${svc.name} port ${published}/${p.protocol} to ${label}`);
    s.add("Unit", "Documentation", "man:systemd-socket-proxyd(8)");
    s.add("Socket", "ListenStream", listen);
    s.add("Socket", "ReusePort", "yes");
    s.add("Socket", "Service", unit);
    s.add("Install", "WantedBy", "sockets.target");
    ctx.expect("sockets", socket);
    ctx.wantedByStack(svc.stack ?? "nostack", socket);
    let binds: string | null = null;
    if (b.scope === "local") {
      const shape = ctx.get<ServiceShape>(instanceKey(b.base));
      binds = shape?.unit ?? ctx.instances.find((i) => i.base === b.base)?.unit ?? null;
      if (binds) {
        const drop = ctx.unitAt(`etc/systemd/system/migration-socket-proxy@${instance}.service.d/10-migration.conf`, [
          `Rendered by ${ctx.rendererName}: this proxy exists only while ${binds} runs on ${ctx.host}`,
        ]);
        drop.add("Unit", "BindsTo", binds);
        drop.add("Unit", "After", binds);
      }
    }
    proxies.push({ service: svc.name, published, protocol: p.protocol, socket, unit, binds, backend: b });
  }
  ctx.expectPort(published, p.protocol);
  const collisions = table.filter((b) => b.scope === "local" && b.port === published && (!vip || b.address === vip));
  for (const b of collisions) {
    ctx.note(`${svc.name}: instance ${b.base} listens on ${b.address}:${b.port} on ${ctx.host}, the same address and port the proxy sockets bind; give the service a VIP (${vipId(svc.name)}), run it as a machine on a lease, or move the instance to another port`, "decision");
  }
  ctx.note(`${svc.name}: port ${published}/${p.protocol} is spread over ${table.length} systemd-socket-proxyd instance(s) on ${ctx.host} (${table.map((b) => `${names.get(b)}@${b.address}:${b.port}`).join(", ")}); the kernel picks a socket per connection and does not know whether the backend behind it answers, so stop the socket of a drained backend`);
}

/** The template every proxy socket activates, once per host. */
function renderProxyTemplate(ctx: RenderContext, proxies: Proxy[]): void {
  const idle = ctx.valueOr(PROXY_IDLE, PROXY_IDLE_DEFAULT);
  const u = ctx.unit(PROXY_TEMPLATE, [
    `Rendered by ${ctx.rendererName}: forwards an inherited listening socket to the instance named by the unit's instance (address:port).`,
    `Activated by the sockets of ${[...new Set(proxies.map((p) => `${p.service}:${p.published}`))].join(", ")} on ${ctx.host}.`,
  ]);
  u.add("Unit", "Description", "Socket proxy to %I for a migrated published port");
  u.add("Unit", "Documentation", "man:systemd-socket-proxyd(8)");
  u.add("Unit", "StopWhenUnneeded", "yes");
  u.add("Service", "Type", "notify");
  u.add("Service", "ExecStart", `${PROXY_BINARY} --exit-idle-time=${idle} %I`);
  u.add("Service", "Restart", "on-failure");
  u.add("Service", "RestartSec", "1");
  u.add("Service", "DynamicUser", "yes");
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
  u.addEmpty("Service", "CapabilityBoundingSet");
  u.add("Service", "SystemCallArchitectures", "native");
  u.add("Service", "SystemCallFilter", "@system-service");
  u.add("Service", "SyslogIdentifier", "migration-socket-proxy");
  u.add("X-Migration", "Renderer", ctx.rendererName);
  u.add("X-Migration", "Form", "socket-proxyd");
  ctx.expect("units", PROXY_TEMPLATE);
  ctx.install("post", `systemctl try-restart ${shellQuote(PROXY_TEMPLATE)} || true`);
  ctx.note(`socket proxies on ${ctx.host} run ${PROXY_BINARY}; on a host whose root prefix is not /usr, correct the path in ${PROXY_TEMPLATE} (decision ${PROXY_IDLE} sets the idle timeout, currently ${idle})`);
}

/** The service's VIP on a dummy netdev, and the multipath route that carries it to the backends. */
function renderMultipath(ctx: RenderContext, svc: Service, p: Port, published: number, table: Backend[], scope: string[]): void {
  if (!ctx.resolvable(vipId(svc.name))) {
    ctx.note(`${svc.name}: port ${published}/${p.protocol} chose multipath, which needs an address of its own; re-run plan.ts against this plan and answer ${vipId(svc.name)} (its default comes from the range in networkd.vip.range.estate)`, "decision");
    return;
  }
  const vip = ctx.value(vipId(svc.name));
  const form = ctx.valueOr(multipathId(svc.name), MULTIPATH_ROUTE);
  const dev = vipLink(svc.name);
  const base = `25-migration-vip-${svc.name}`;
  const local = table.some((b) => b.scope === "local");
  if (!ctx.expected.networks.includes(`${base}.netdev`)) {
    ctx.file(
      `etc/systemd/network/${base}.netdev`,
      renderSections([`Rendered by ${ctx.rendererName}: the dummy link that anchors the virtual address of ${svc.name} on ${ctx.host}`], [["NetDev", [["Name", dev], ["Kind", "dummy"], ["Description", `virtual address of ${svc.name}`]]]]),
    );
    ctx.expect("networks", `${base}.netdev`);
  }
  const sections: Section[] = [
    ["Match", [["Name", dev]]],
    ["Link", [["RequiredForOnline", "no"]]],
  ];
  if (local) {
    sections.push(["Network", [["Address", `${vip}/32`], ["LinkLocalAddressing", "no"], ["IPv6AcceptRA", "no"]]]);
  } else {
    sections.push(["Network", [["LinkLocalAddressing", "no"], ["IPv6AcceptRA", "no"], ["IPv4Forwarding", "yes"]]]);
    if (form === MULTIPATH_NEXTHOP) {
      const first = nextHopBase(svc.name);
      const ids = table.map((_, i) => first + i);
      const group = first + table.length;
      for (const [i, b] of table.entries()) sections.push(["NextHop", [["Id", ids[i]!], ["Gateway", b.address]]]);
      sections.push(["NextHop", [["Id", group], ["Group", ids.map((id) => `${id}:1`).join(" ")]]]);
      sections.push(["Route", [["Destination", `${vip}/32`], ["NextHop", group]]]);
    } else {
      const entries: SectionEntries = [["Destination", `${vip}/32`]];
      for (const b of table) entries.push(["MultiPathRoute", `${b.address} 1`]);
      sections.push(["Route", entries]);
    }
  }
  ctx.file(
    `etc/systemd/network/${base}.network`,
    renderSections(
      [
        `Rendered by ${ctx.rendererName}: the virtual address ${vip} of ${svc.name} on ${ctx.host}`,
        local
          ? `This host runs ${table.filter((b) => b.scope === "local").length} instance(s), so it holds the address itself and answers locally.`
          : `This host runs no instance, so ${vip} is routed over ${table.length} backend(s) with ${form === MULTIPATH_NEXTHOP ? "a nexthop group" : "MultiPathRoute="}: ${table.map((b) => `${b.address}:${b.port}`).join(", ")}.`,
      ],
      sections,
    ),
  );
  ctx.expect("networks", `${base}.network`);
  ctx.expectPort(published, p.protocol);
  ctx.note(
    `${svc.name}: port ${published}/${p.protocol} is published on the virtual address ${vip} across ${scope.join(", ")}; the spread is per flow and not health aware, so a backend that stops answering keeps taking the flows hashed to it until its route is withdrawn (the rollout controller does that when it drains a host)`,
  );
  if (local) ctx.note(`${svc.name}: ${ctx.host} holds ${vip} on ${dev} because it runs the service; a local address is delivered locally, so the multipath route is rendered on the hosts in the ingress scope that run no instance`);
}
