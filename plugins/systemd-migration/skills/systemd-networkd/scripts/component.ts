// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The networkd component: what replaces the orchestrator's networks. Every
// address range, overlay transport, published-port policy, zone attachment,
// parent link, VXLAN identifier, WireGuard port, endpoint, and tunnel range
// is a decision with the source's own values as evidence, never a constant.
// This module raises those decisions, renders the port policy of plain
// services, and renders the zone bridge, the DHCP leases, and the transport
// between hosts for every service the plan runs as a machine (see the
// systemd-networkd skill and references/zone-bridge.md).

import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import { formId, placementId } from "../../../contract/compose.ts";
import { splitList } from "../../../contract/plan.ts";
import type { Inventory, Network, Service } from "../../../contract/types.ts";
import { unitBaseName } from "../../../contract/unit.ts";

export function subnetId(net: string): string {
  return `networkd.subnet.${net}`;
}
export function transportId(net: string): string {
  return `networkd.transport.${net}`;
}
export function publishId(service: string, port: number, protocol: string): string {
  return `networkd.publish.${service}.${port}-${protocol}`;
}
export function zoneId(service: string): string {
  return `networkd.zone.${service}`;
}
export function parentId(net: string): string {
  return `networkd.parent.${net}`;
}
export function vniId(net: string): string {
  return `networkd.vni.${net}`;
}
export function domainId(net: string): string {
  return `networkd.domain.${net}`;
}
export function wireguardSubnetId(net: string): string {
  return `networkd.wireguard.subnet.${net}`;
}
export function wireguardEndpointId(host: string): string {
  return `networkd.wireguard.endpoint.${host}`;
}
export function uplinkId(host: string): string {
  return `networkd.uplink.${host}`;
}
export const WIREGUARD_PORT = "networkd.wireguard.port.estate";

/** The zone option that leaves a machine in the host's network namespace. */
export const ZONE_HOST = "host";

/** The key under which this component publishes the estate's static leases for the resolved component. */
export const LEASES = "networkd:leases";

/** One machine's fixed address on a zone bridge, as rendered into [DHCPServerStaticLease]. */
export interface Lease {
  network: string;
  host: string;
  /** `lease`: handed out by the zone bridge's DHCP server; `static`: on a macvlan or ipvlan segment, configured inside the guest. */
  kind: "lease" | "static";
  /** The machine name (`web_app`, `web_app-2`). */
  base: string;
  service: string;
  address: string;
  mac: string;
}

/** The ingress decision of a published port: where the port exists (PLAN.md 10.2). */
export function ingressId(service: string, port: number, protocol: string): string {
  return `networkd.ingress.${service}.${port}-${protocol}`;
}
/** The service's virtual address when a load-balancing option anchors one. */
export function vipId(service: string): string {
  return `networkd.vip.${service}`;
}
/** The range service virtual addresses are taken from. */
export const VIP_RANGE = "networkd.vip.range.estate";
/** The key under which this component publishes the backends of every published port for the adapters (haproxy-ingress). */
export const BACKENDS = "networkd:backends";

/** One instance a published port can be forwarded to, as the load-balancing options and the HAProxy adapter see it. */
export interface Backend {
  service: string;
  /** The instance's unit base (`web_app`, `web_app-2`). */
  base: string;
  host: string;
  /** The address the instance answers on: a machine's lease, or the host's address for a plain service. */
  address: string;
  /** The port the instance itself listens on (offset for numbered instances on one host). */
  port: number;
  protocol: string;
  /** Whether the instance sits on this host (`local`) or is reached over the transport. */
  scope: "local" | "remote";
}

/**
 * The backends of a service's published port as seen from `host`: every
 * instance the plan places, on this host and on the others. Reads the lease
 * table for machines and the plan's host addresses for plain services. The
 * networkd stream refines this (ingress decision, VIPs); adapters call it.
 */
export function backendsOf(ctx: RenderContext, service: Service, port: { target: number; published: number | null; protocol: string }, host: string): Backend[] {
  const leases = ctx.get<Lease[]>(LEASES) ?? [];
  const placed = ctx.plan.decisions.find((d) => d.id === `placement.hosts.${service.name}`);
  const chosen = String(placed?.chosen ?? placed?.default ?? "");
  const hosts = chosen ? chosen.split(",").map((h) => h.trim()).filter(Boolean) : [host];
  const out: Backend[] = [];
  for (const h of hosts) {
    const addr = ctx.plan.hosts[h]?.addresses?.[0] ?? ctx.inventory.nodes.find((n) => n.hostname === h)?.addr ?? null;
    const instances = ctx.instances.filter((i) => i.service.name === service.name && ctx.host === h);
    const count = Math.max(1, instances.length || 1);
    for (let index = 1; index <= count; index++) {
      const base = index === 1 ? service.name : `${service.name}-${index}`;
      const lease = leases.find((l) => l.host === h && l.base === base);
      const address = lease?.address ?? addr;
      if (!address) continue;
      const published = port.published ?? port.target;
      out.push({ service: service.name, base, host: h, address, port: lease ? port.target : count > 1 ? published + (index - 1) : published, protocol: port.protocol, scope: h === host ? "local" : "remote" });
    }
  }
  return out;
}

/** The transports that build an L2 domain across hosts; the others route each host's slice. */
const L2_TRANSPORTS = new Set(["vxlan", "vxlan-wireguard"]);
const WIREGUARD_TRANSPORTS = new Set(["wireguard", "vxlan-wireguard"]);

function isApplicationNetwork(n: Network): boolean {
  return !n.ingress && n.name !== "host" && n.name !== "bridge" && n.name !== "none" && n.driver !== "null" && n.driver !== "host";
}

/** Networks whose members sit on a host link's segment (systemd-nspawn MACVLAN= and IPVLAN=), not on a zone bridge. */
function isAttachedDriver(n: Network): boolean {
  return n.driver === "macvlan" || n.driver === "ipvlan";
}

/** Application networks in a stable order; a network's 1-based position here seeds its VNI and tunnel range. */
function applicationNetworks(inv: Inventory): Network[] {
  return inv.networks.filter(isApplicationNetwork).sort((a, b) => a.name.localeCompare(b.name));
}

function positionOf(inv: Inventory, net: string): number {
  return applicationNetworks(inv).findIndex((n) => n.name === net) + 1;
}

/** The application networks a service is a member of, in the service's own order, resolving ids and names. */
function memberNetworks(inv: Inventory, svc: Service): Network[] {
  const out: Network[] = [];
  for (const ref of svc.networks) {
    const n = inv.networks.find((x) => x.name === ref.name || x.id === ref.name);
    if (n && isApplicationNetwork(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

// IPv4 arithmetic. Every address a bridge, lease, tunnel, or route carries is
// derived from a decided range and a position, so the same plan yields the
// same addresses on every run and on every host.

interface Cidr {
  base: number;
  prefix: number;
  size: number;
}

function ip4ToNumber(a: string): number {
  return a.split(".").reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0) >>> 0;
}

function numberToIp4(n: number): string {
  return [24, 16, 8, 0].map((s) => ((n >>> s) & 0xff).toString()).join(".");
}

/** An IPv4 range, or null when the value is IPv6 or malformed (the caller notes it). */
function parseCidr(value: string): Cidr | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (!m) return null;
  const prefix = Number(m[2]);
  if (prefix > 32) return null;
  const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
  const base = prefix === 0 ? 0 : (ip4ToNumber(m[1]!) & (~0 << (32 - prefix))) >>> 0;
  return { base, prefix, size };
}

/** Smallest exponent e with 2^e >= n, so n hosts fit in 2^e equal slices. */
function sliceExponent(n: number): number {
  let e = 0;
  while (2 ** e < n) e++;
  return e;
}

/**
 * A locally administered unicast MAC derived from the machine name: the first
 * five bytes of SHA-256 over the name, with the first byte's local bit set and
 * its multicast bit cleared. The machine's veth carries it (SYSTEMD_NSPAWN_NETWORK_MAC)
 * so the static lease below matches what the guest's DHCP client presents.
 */
export function machineMac(base: string): string {
  const digest = createHash("sha256").update(base).digest();
  const bytes = [...digest.subarray(0, 6)];
  bytes[0] = (bytes[0]! & 0xfc) | 0x02;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}

/** Render a unit-style file whose sections may repeat ([WireGuardPeer], [DHCPServerStaticLease], [Route]). */
function renderSections(header: string[], sections: Array<[string, Array<[string, string | number | null | undefined]>]>): string {
  const out = header.map((l) => (l ? `# ${l}` : "#"));
  for (const [name, entries] of sections) {
    const lines = entries.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`);
    if (lines.length === 0) continue;
    out.push("", `[${name}]`, ...lines);
  }
  return out.join("\n") + "\n";
}

/** Where a machine of the estate lands, from the plan's placement, form, and zone decisions. */
interface Attachment {
  network: string;
  host: string;
  base: string;
  service: Service;
  /** Position among the machines attached to the same network on the same host, sorted by name. */
  index: number;
}

function attachments(ctx: RenderContext): Attachment[] {
  const inv = ctx.inventory;
  const out: Attachment[] = [];
  for (const svc of inv.services) {
    if (ctx.valueOr(formId(svc.name), "service") !== "machine") continue;
    const zone = ctx.hasDecision(zoneId(svc.name)) ? ctx.valueOr(zoneId(svc.name), "") : "";
    if (!zone || zone === ZONE_HOST) continue;
    if (!memberNetworks(inv, svc).some((n) => n.name === zone)) continue;
    const counts = new Map<string, number>();
    for (const h of splitList(ctx.valueOr(placementId(svc.name), ""))) counts.set(h, (counts.get(h) ?? 0) + 1);
    for (const [host, count] of counts) for (let i = 1; i <= count; i++) out.push({ network: zone, host, base: unitBaseName(svc.name, i, count), service: svc, index: 0 });
  }
  out.sort((a, b) => a.network.localeCompare(b.network) || a.host.localeCompare(b.host) || a.base.localeCompare(b.base));
  let key = "";
  let i = 0;
  for (const a of out) {
    const k = `${a.network}\0${a.host}`;
    if (k !== key) {
      key = k;
      i = 0;
    }
    a.index = i++;
  }
  return out;
}

export const networkdComponent: Component = {
  id: "networkd",
  title: "Networking (systemd.network, systemd.netdev, systemd.link, systemd.socket)",
  covers: ["systemd-networkd.service", "systemd.network", "systemd.netdev", "systemd.link", "networkd.conf", "networkctl", "systemd.socket", "systemd-socket-activate", "systemd-socket-proxyd", "systemd.net-naming-scheme", "systemd-networkd-wait-online.service", "systemd-network-generator.service"],
  after: ["service", "machined"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    const inv = ctx.inventory;
    const overlayHosts = new Set<string>();
    let anyTransport = false;
    for (const n of applicationNetworks(inv)) {
      const hosts = ctx.hostsOfNetwork(n);
      const position = positionOf(inv, n.name);
      const source = n.ipam.config.map((c) => c.subnet).filter(Boolean) as string[];
      const attached = isAttachedDriver(n);
      const range = attached ? (n.ipam.config.map((c) => c.ip_range).filter(Boolean) as string[]) : [];
      const evidence = [`networks[${n.name}].driver=${n.driver}`, `networks[${n.name}].ipam.config=${JSON.stringify(n.ipam.config)}`, `members: ${n.used_by.join(", ") || "none"}`, `hosts: ${hosts.join(", ") || "none"}`];
      out.push({
        id: subnetId(n.name),
        kind: "value",
        format: "cidr",
        subject: { kind: "network", name: n.name },
        hosts,
        question: attached
          ? `Which range of the ${n.driver} segment of ${n.name} do the systemd hosts and their machines take addresses from? The source allocated from ${range[0] ?? source[0] ?? "an assigned range"}${source[0] ? ` inside ${source[0]}` : ""}.`
          : `Which address range does network ${n.name} use on the systemd hosts? The source used ${source.join(", ") || "an assigned range"}.`,
        default: range[0] ?? source[0] ?? null,
        evidence,
      });
      out.push({
        id: domainId(n.name),
        kind: "value",
        format: "name",
        subject: { kind: "network", name: n.name },
        hosts,
        question: `Under which local domain does the host resolve the DHCP leases of the machines on ${n.name} (LocalLeaseDomain= of the zone bridge)?`,
        default: "_dhcp",
        evidence: [`networks[${n.name}].name=${n.name}`, "the shipped 80-container-vz.network uses _dhcp"],
      });
      if (n.driver === "overlay" && hosts.length > 1) {
        anyTransport = true;
        for (const h of hosts) overlayHosts.add(h);
        out.push({
          id: transportId(n.name),
          kind: "choice",
          subject: { kind: "network", name: n.name },
          hosts,
          question: `Network ${n.name} spans ${hosts.join(", ")}${n.encrypted ? " and was encrypted" : ""}. What carries it between the hosts?`,
          options: [
            { value: "vxlan-wireguard", label: "VXLAN over a WireGuard mesh", consequence: "a wg netdev per host with keys as credentials, the VXLAN rides inside it; encrypted like the source", requires: { daemons: ["networkd"] } },
            { value: "vxlan", label: "VXLAN over the underlay", consequence: "plain VXLAN between the hosts' addresses; unencrypted", requires: { daemons: ["networkd"] } },
            { value: "wireguard", label: "WireGuard only, routed", consequence: "each host's zone bridge subnet is routed over WireGuard; no L2 between hosts, aliases resolve per host", requires: { daemons: ["networkd"] } },
            { value: "underlay", label: "route over the existing network", consequence: "no overlay; each host's bridge subnet must be reachable through the site's routers" },
          ],
          default: n.encrypted ? "vxlan-wireguard" : null,
          evidence: [`networks[${n.name}].encrypted=${n.encrypted}`, `networks[${n.name}].scope=${n.scope}`, `members on ${hosts.length} hosts`],
        });
        out.push({
          id: vniId(n.name),
          kind: "value",
          format: "port",
          subject: { kind: "network", name: n.name },
          hosts,
          question: `Which VXLAN network identifier (VNI) does ${n.name} use when its transport is VXLAN? The default is its position among the application networks sorted by name.`,
          default: String(position),
          evidence: [`networks[${n.name}] is application network ${position} of ${applicationNetworks(inv).length} (sorted by name)`, `networks[${n.name}].id=${n.id}`],
        });
        out.push({
          id: wireguardSubnetId(n.name),
          kind: "value",
          format: "cidr",
          subject: { kind: "network", name: n.name },
          hosts,
          question: `Which range do the WireGuard tunnel addresses of ${n.name} come from (one address per host, when the transport uses WireGuard)? The default is a /24 of the RFC 6598 shared address space chosen by the network's position.`,
          default: position <= 255 ? `100.64.${position}.0/24` : null,
          evidence: [`networks[${n.name}] is application network ${position} (sorted by name)`, `hosts: ${hosts.join(", ")}`],
        });
      }
      if (n.driver === "macvlan" || n.driver === "ipvlan") {
        const parent = n.options["parent"] ?? null;
        out.push({
          id: parentId(n.name),
          kind: "value",
          format: "name",
          subject: { kind: "network", name: n.name },
          hosts,
          question: `Which host link do the ${n.driver} interfaces of ${n.name} attach to on the systemd hosts?${parent ? ` The source used ${parent}.` : " The source recorded no parent."}`,
          default: parent,
          evidence: [`networks[${n.name}].driver=${n.driver}`, `networks[${n.name}].options.parent=${parent ?? "unset"}`, ...(parent ? [`the default is the source's parent link; confirm it exists on ${hosts.join(", ") || "the target hosts"}`] : [])],
        });
      }
    }
    if (anyTransport) {
      out.push({
        id: WIREGUARD_PORT,
        kind: "value",
        format: "port",
        subject: { kind: "estate", name: "estate" },
        question: "Which UDP port do the WireGuard tunnels listen on? The first network sorted by name takes this port and each following one the next port up.",
        default: "51820",
        evidence: [`overlays span hosts: ${[...overlayHosts].sort().join(", ")}`, "51820 is the port WireGuard tooling uses by convention"],
      });
      for (const h of [...overlayHosts].sort()) {
        const probed = ctx.hosts[h]?.addresses?.[0] ?? null;
        const node = inv.nodes.find((n) => n.hostname === h)?.addr ?? null;
        out.push({
          id: wireguardEndpointId(h),
          kind: "value",
          format: "ipv4",
          subject: { kind: "host", name: h },
          hosts: [h],
          question: `Which address do the other hosts reach ${h} at for overlay traffic (the WireGuard endpoint, or the VXLAN underlay address)?`,
          default: probed ?? node,
          evidence: [probed ? `hosts[${h}].addresses[0]=${probed}` : `hosts[${h}] not probed or without addresses`, node ? `nodes[${h}].addr=${node}` : `nodes[${h}] has no addr`],
        });
        if (applicationNetworks(inv).some((n) => ctx.previous(transportId(n.name)) === "underlay")) {
          out.push({
            id: uplinkId(h),
            kind: "value",
            format: "path",
            subject: { kind: "host", name: h },
            hosts: [h],
            question: `Which .network file configures the uplink of ${h} (networkctl status shows it)? The routes to the other hosts' bridge slices are rendered as a drop-in for it.`,
            default: null,
            evidence: [`a transport chose underlay; routes need the link that reaches the other hosts`, ...(probed ? [`hosts[${h}].addresses[0]=${probed}`] : [])],
          });
        }
      }
    }
    for (const svc of inv.services) {
      const nets = memberNetworks(inv, svc);
      if (nets.length === 0) continue;
      out.push({
        id: zoneId(svc.name),
        kind: "choice",
        subject: { kind: "service", name: svc.name },
        question: `When ${svc.name} runs as a machine, which network zone does it attach to?`,
        options: [
          ...nets.map((n) =>
            isAttachedDriver(n)
              ? { value: n.name, label: `${n.driver} on the parent link of ${n.name}`, consequence: `a ${n.driver} interface on the decided parent link inside the machine, with an address the guest configures from the decided range` }
              : { value: n.name, label: `zone bridge vz-${n.name}`, consequence: `a veth into the bridge of ${n.driver} network ${n.name}, an address from its decided range, and its transport between hosts` },
          ),
          { value: ZONE_HOST, label: "the host's network namespace", consequence: "no zone and no private network; the machine binds the host's addresses like a plain service" },
        ],
        default: nets[0]!.name,
        evidence: nets.map((n) => `services[${svc.name}].networks[${n.name}] aliases=${svc.networks.find((r) => r.name === n.name || r.name === n.id)?.aliases.join(",") || "none"}`),
      });
    }
    for (const svc of inv.services) {
      for (const p of svc.ports) {
        const published = p.published ?? p.target;
        out.push({
          id: publishId(svc.name, published, p.protocol),
          kind: "choice",
          subject: { kind: "port", name: `${svc.name}:${published}/${p.protocol}` },
          question: `Port ${published}/${p.protocol} of ${svc.name} was published in ${p.mode} mode${p.mode === "ingress" ? " through the routing mesh" : ""}. How do clients reach it now?`,
          options: [
            { value: "host", label: "on each host that runs it", consequence: "the service binds the port on its host; SocketBindAllow= restricts it to that port; clients use the host's address" },
            { value: "socket", label: "socket activation", consequence: "a .socket unit owns the port and passes it in; the process must accept an inherited socket", requires: { systemd: 250 } },
            { value: "external-lb", label: "behind an external load balancer", consequence: "same as host, and the plan lists the hosts as backends for the balancer you operate" },
            { value: "dns-rr", label: "DNS round robin", consequence: "same as host, plus one resolved/dnssd record per host announcing the port" },
          ],
          default: p.mode === "host" ? "host" : null,
          evidence: [`services[${svc.name}].ports[${p.target}] mode=${p.mode} published=${p.published ?? "unset"}`],
        });
      }
    }
    return out;
  },

  render(ctx: RenderContext): void {
    renderServices(ctx);
    renderMachines(ctx);
  },
};

/** The port policy of plain services, and their membership notes. */
function renderServices(ctx: RenderContext): void {
  const inv = ctx.inventory;
  for (const inst of ctx.instances) {
    if (inst.form !== "service") continue;
    const shape = ctx.get<ServiceShape>(instanceKey(inst.base));
    if (!shape) continue;
    const svc = inst.service;
    const u = ctx.unit(shape.unit);
    for (const p of svc.ports) {
      const published = p.published ?? p.target;
      const port = inst.count > 1 ? published + (inst.index - 1) : published;
      const how = ctx.value(publishId(svc.name, published, p.protocol));
      if (port !== p.target) ctx.note(`${svc.name}: published port ${port} differs from the container port ${p.target}; a native service listens on the port the process opens, so configure the process to listen on ${port} or front it`, "decision");
      if (how === "socket") {
        const s = ctx.unit(`${inst.base}-${port}.socket`, [`Rendered by ${ctx.rendererName}: socket activation for ${svc.name} port ${port}/${p.protocol}`]);
        s.add("Unit", "Description", `${inst.base} port ${port}/${p.protocol}`);
        s.add("Socket", p.protocol === "udp" ? "ListenDatagram" : "ListenStream", port);
        s.add("Socket", "Service", shape.unit);
        s.add("Install", "WantedBy", "sockets.target");
        ctx.expect("sockets", `${inst.base}-${port}.socket`);
        ctx.wantedByStack(inst.stack, `${inst.base}-${port}.socket`);
        ctx.note(`${svc.name}: port ${port} is socket-activated; the process must accept the inherited listening socket (sd_listen_fds)`, "decision");
      } else {
        u.add("Service", "SocketBindAllow", `${p.protocol}:${port}`);
      }
      ctx.expectPort(port, p.protocol);
      if (how === "external-lb") ctx.note(`${svc.name}: port ${port} is a backend of your external load balancer on ${ctx.host}`);
      if (how === "dns-rr") ctx.note(`${svc.name}: port ${port} on ${ctx.host} is announced for DNS round robin by the resolved component`);
      if (inst.count > 1) ctx.note(`${svc.name}: instance ${inst.index} publishes ${port} instead of ${published} because several instances share ${ctx.host}`);
    }
    if (svc.ports.some((p) => ctx.value(publishId(svc.name, p.published ?? p.target, p.protocol)) !== "socket")) u.add("Service", "SocketBindDeny", "any");
    const nets = memberNetworks(inv, svc);
    for (const n of nets) {
      const subnet = ctx.valueOr(subnetId(n.name), "");
      const transport = ctx.hasDecision(transportId(n.name)) ? ctx.valueOr(transportId(n.name), "") : "local";
      ctx.expect("networks", n.name);
      ctx.note(`${svc.name}: member of ${n.driver} network ${n.name} (${subnet || "range undecided"}, ${transport || "transport undecided"}); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it`);
    }
    if (svc.endpoint_mode === "vip" && nets.length) ctx.note(`${svc.name}: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides`);
  }
}

/** Zone bridges, leases, transports, and port forwards for the machines of the estate that land on this host. */
function renderMachines(ctx: RenderContext): void {
  const inv = ctx.inventory;
  const all = attachments(ctx);
  const leases: Lease[] = [];
  const plans = new Map<string, { net: Network; cidr: Cidr; hosts: string[]; exponent: number }>();
  // The address plan of every attached network, estate-wide, so the leases of machines on other hosts are known here.
  for (const name of new Set(all.map((a) => a.network))) {
    const net = inv.networks.find((n) => n.name === name)!;
    const range = ctx.value(subnetId(name));
    const cidr = parseCidr(range);
    if (!cidr) {
      ctx.note(`${name}: range ${range} is not an IPv4 prefix; the zone bridge is not rendered (IPv6 ranges are not supported yet)`, "decision");
      continue;
    }
    const hosts = [...new Set(all.filter((a) => a.network === name).map((a) => a.host))].sort();
    const exponent = sliceExponent(hosts.length);
    plans.set(name, { net, cidr, hosts, exponent });
    if (cidr.prefix + exponent > 30) ctx.note(`${name}: ${range} is too small to give each of ${hosts.length} hosts a slice with a gateway, leases, and a pool; choose a larger range in ${subnetId(name)}`, "decision");
  }
  const sliceBase = (p: { cidr: Cidr; exponent: number }, i: number) => (p.cidr.base + i * (p.cidr.size >> p.exponent)) >>> 0;
  for (const a of all) {
    const p = plans.get(a.network);
    if (!p) continue;
    leases.push({ network: a.network, host: a.host, kind: isAttachedDriver(p.net) ? "static" : "lease", base: a.base, service: a.service.name, address: numberToIp4(sliceBase(p, p.hosts.indexOf(a.host)) + 2 + a.index), mac: machineMac(a.base) });
  }
  ctx.set(LEASES, leases);

  let rendered = false;
  let forwarding = false;
  for (const [name, p] of [...plans].sort()) {
    const i = p.hosts.indexOf(ctx.host);
    if (i < 0) continue;
    const net = p.net;
    const transport = p.hosts.length > 1 ? (ctx.hasDecision(transportId(name)) ? ctx.value(transportId(name)) : null) : "local";
    if (transport === null) {
      ctx.note(`${name}: machines attached to it land on ${p.hosts.join(", ")} but the inventory placed its members on one host, so no transport was decided; re-run plan.ts against this placement`, "decision");
      continue;
    }
    const routed = transport === "wireguard" || transport === "underlay";
    const sliceSize = p.cidr.size >> p.exponent;
    const slicePrefix = p.cidr.prefix + p.exponent;
    const mine = sliceBase(p, i);
    const machines = all.filter((a) => a.network === name && a.host === ctx.host);
    if (isAttachedDriver(net)) {
      renderAttached(ctx, net, ctx.value(parentId(name)), `${numberToIp4(mine + 1)}/${p.cidr.prefix}`, machines.map((m) => ({ base: m.base, service: m.service.name, address: leases.find((l) => l.network === name && l.host === ctx.host && l.base === m.base)!.address })));
      rendered = true;
      continue;
    }
    const leaseHosts = L2_TRANSPORTS.has(transport) ? p.hosts : [ctx.host];
    const domain = ctx.value(domainId(name));
    const reserved = 2 + machines.length;
    const pool = sliceSize - reserved - 1;
    // The bridge systemd-nspawn creates for Zone=; this file replaces the shipped 80-container-vz.network for it.
    const bridge = `25-migration-vz-${name}.network`;
    const leaseSections: Array<[string, Array<[string, string | number | null | undefined]>]> = leases
      .filter((l) => l.network === name && leaseHosts.includes(l.host))
      .map((l) => ["DHCPServerStaticLease", [["MACAddress", l.mac], ["Address", l.address], ["Hostname", l.base]]]);
    ctx.file(
      `etc/systemd/network/${bridge}`,
      renderSections(
        [`Rendered by ${ctx.rendererName}: zone bridge of ${net.driver} network ${name} on ${ctx.host} (${transport}); range ${numberToIp4(p.cidr.base)}/${p.cidr.prefix}, this host's slice ${numberToIp4(mine)}/${slicePrefix}`],
        [
          ["Match", [["Kind", "bridge"], ["Name", `vz-${name}`]]],
          ["Link", [["RequiredForOnline", "no"]]],
          ["Network", [["Address", `${numberToIp4(mine + 1)}/${routed ? slicePrefix : p.cidr.prefix}`], ["LinkLocalAddressing", "yes"], ["DHCPServer", "yes"], ["IPMasquerade", net.internal ? "no" : "ipv4"], ["IPv4Forwarding", routed ? "yes" : null], ["IPv6AcceptRA", "no"]]],
          ["DHCPServer", [["PoolOffset", pool > 0 ? (routed ? 0 : mine - p.cidr.base) + reserved : null], ["PoolSize", pool > 0 ? pool : null], ["PersistLeases", "runtime"], ["LocalLeaseDomain", domain]]],
          ...leaseSections,
        ],
      ),
    );
    ctx.expect("networks", bridge);
    rendered = true;
    if (pool <= 0) ctx.note(`${name}: this host's slice ${numberToIp4(mine)}/${slicePrefix} has no room for a DHCP pool after ${machines.length} leases; the bridge serves the static leases only`, "decision");
    for (const m of machines) {
      const lease = leases.find((l) => l.network === name && l.host === ctx.host && l.base === m.base)!;
      const drop = ctx.unitAt(`etc/systemd/system/systemd-nspawn@${m.base}.service.d/10-migration.conf`);
      drop.add("Service", "Environment", `SYSTEMD_NSPAWN_NETWORK_MAC=${lease.mac}`);
      ctx.note(`${m.service.name}: machine ${m.base} joins zone vz-${name} with MAC ${lease.mac} and static lease ${lease.address}; the guest must run a DHCP client on host0 (systemd-networkd with the shipped 80-container-host0.network) to take the lease`);
    }
    if (net.internal) ctx.note(`${name}: internal in the source, so the bridge does not masquerade; the machines on it reach only each other and the host`);

    const peers = p.hosts.filter((h) => h !== ctx.host);
    const peerSlice = (h: string) => `${numberToIp4(sliceBase(p, p.hosts.indexOf(h)))}/${slicePrefix}`;
    if (transport === "local") continue;
    const endpoint = (h: string) => ctx.value(wireguardEndpointId(h));
    let tunnel: { cidr: Cidr; of: (h: string) => string } | null = null;
    if (WIREGUARD_TRANSPORTS.has(transport)) {
      const range = ctx.value(wireguardSubnetId(name));
      const cidr = parseCidr(range);
      if (!cidr) {
        ctx.note(`${name}: WireGuard tunnel range ${range} is not an IPv4 prefix; the tunnel is not rendered`, "decision");
        continue;
      }
      tunnel = { cidr, of: (h: string) => numberToIp4(cidr.base + 1 + p.hosts.indexOf(h)) };
      const port = Number(ctx.value(WIREGUARD_PORT)) + positionOf(inv, name) - 1;
      const wg = `25-migration-wg-${name}`;
      const privateCred = `network.wireguard.private.${wg}`;
      ctx.file(
        `etc/systemd/network/${wg}.netdev`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: WireGuard tunnel of network ${name} on ${ctx.host}; the private key is the credential ${privateCred}, each peer's public key the credential named on its line`],
          [
            ["NetDev", [["Name", `wg-${name}`], ["Kind", "wireguard"], ["Description", `WireGuard mesh of ${name}`]]],
            ["WireGuard", [["ListenPort", port], ["PrivateKey", `@${privateCred}`]]],
            ...peers.map((h): [string, Array<[string, string | number | null | undefined]>] => ["WireGuardPeer", [["PublicKey", `@network.wireguard.public.${h}`], ["Endpoint", `${endpoint(h)}:${port}`], ["AllowedIPs", `${tunnel!.of(h)}/32`], ["AllowedIPs", transport === "wireguard" ? peerSlice(h) : null], ["PersistentKeepalive", 25]]]),
          ],
        ),
      );
      ctx.file(
        `etc/systemd/network/${wg}.network`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: tunnel address of ${ctx.host} on the WireGuard mesh of ${name}`],
          [
            ["Match", [["Name", `wg-${name}`]]],
            ["Link", [["RequiredForOnline", "no"]]],
            ["Network", [["Address", `${tunnel.of(ctx.host)}/${cidr.prefix}`], ["IPv4Forwarding", transport === "wireguard" ? "yes" : null]]],
            ...(transport === "wireguard" ? peers.map((h): [string, Array<[string, string | number | null | undefined]>] => ["Route", [["Destination", peerSlice(h)], ["Gateway", tunnel!.of(h)]]]) : []),
          ],
        ),
      );
      ctx.expect("networks", `${wg}.netdev`);
      ctx.expect("networks", `${wg}.network`);
      ctx.expect("credentials", privateCred);
      for (const h of peers) ctx.expect("credentials", `network.wireguard.public.${h}`);
      ctx.note(`${name}: supply ${privateCred} (this host's WireGuard private key) and network.wireguard.public.<host> for ${peers.join(", ")} as system credentials (systemd-creds encrypt --name=... into /etc/credstore.encrypted/); networkd imports network.wireguard.* itself`, "decision");
      if (transport === "wireguard") forwarding = true;
    }
    if (L2_TRANSPORTS.has(transport)) {
      const vni = ctx.value(vniId(name));
      const local = tunnel ? tunnel.of(ctx.host) : endpoint(ctx.host);
      const remote = (h: string) => (tunnel ? tunnel.of(h) : endpoint(h));
      const vx = `25-migration-vx-${name}`;
      ctx.file(
        `etc/systemd/network/${vx}.netdev`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: VXLAN of network ${name} on ${ctx.host}, VNI ${vni}, ${tunnel ? "inside the WireGuard mesh" : "over the underlay"}`],
          [
            ["NetDev", [["Name", `vx-${name}`], ["Kind", "vxlan"], ["Description", `VXLAN of ${name}`]]],
            ["VXLAN", [["VNI", vni], ["Local", local], ["Remote", peers.length === 1 ? remote(peers[0]!) : null], ["MacLearning", "yes"]]],
          ],
        ),
      );
      ctx.file(
        `etc/systemd/network/${vx}.network`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: enslaves the VXLAN of ${name} into the zone bridge vz-${name}${peers.length > 1 ? "; one flood entry per peer (head-end replication)" : ""}`],
          [
            ["Match", [["Name", `vx-${name}`]]],
            ["Link", [["RequiredForOnline", "no"]]],
            ["Network", [["Bridge", `vz-${name}`]]],
            ...(peers.length > 1 ? peers.map((h): [string, Array<[string, string | number | null | undefined]>] => ["BridgeFDB", [["MACAddress", "00:00:00:00:00:00"], ["Destination", remote(h)]]]) : []),
          ],
        ),
      );
      ctx.expect("networks", `${vx}.netdev`);
      ctx.expect("networks", `${vx}.network`);
    }
    if (transport === "underlay") {
      forwarding = true;
      if (ctx.hasDecision(uplinkId(ctx.host)) && ctx.resolvable(uplinkId(ctx.host))) {
        const uplink = basename(ctx.value(uplinkId(ctx.host)));
        const drop = `${uplink}.d/25-migration-${name}.conf`;
        ctx.file(
          `etc/systemd/network/${drop}`,
          renderSections(
            [`Rendered by ${ctx.rendererName}: routes from ${ctx.host} to the bridge slices of ${name} on the other hosts, through their underlay addresses`],
            peers.map((h): [string, Array<[string, string | number | null | undefined]>] => ["Route", [["Destination", peerSlice(h)], ["Gateway", endpoint(h)]]]),
          ),
        );
        ctx.expect("networks", drop);
      } else {
        ctx.note(`${name}: routed over the underlay; either the site's routers carry ${peers.map((h) => `${peerSlice(h)} via ${endpoint(h)}`).join(", ")}, or re-run plan.ts and answer ${uplinkId(ctx.host)} so the routes are rendered as a drop-in for the uplink's .network`, "decision");
      }
    }
  }
  if (forwarding) {
    ctx.file("etc/sysctl.d/80-migration-forwarding.conf", [`# Rendered by ${ctx.rendererName}: a routed transport forwards between the zone bridges and the tunnel or uplink`, "net.ipv4.ip_forward = 1", ""].join("\n"));
    ctx.install("pre", "sysctl --system >/dev/null || true");
  }
  if (rendered) ctx.install("post", "networkctl reload");

  // Published ports of machines: forwarded from the host into the zone by systemd-nspawn.
  for (const inst of ctx.instances) {
    if (inst.form !== "machine") continue;
    const svc = inst.service;
    const zone = ctx.hasDecision(zoneId(svc.name)) ? ctx.valueOr(zoneId(svc.name), "") : "";
    const attached = all.some((a) => a.host === ctx.host && a.base === inst.base);
    for (const p of svc.ports) {
      const published = p.published ?? p.target;
      const port = inst.count > 1 ? published + (inst.index - 1) : published;
      const how = ctx.value(publishId(svc.name, published, p.protocol));
      if (how === "socket") ctx.note(`${svc.name}: socket activation was chosen for port ${port}, which a machine cannot inherit; the port is forwarded into the machine instead`, "decision");
      if (attached) {
        ctx.unitAt(`etc/systemd/nspawn/${inst.base}.nspawn`).add("Network", "Port", `${p.protocol}:${port}:${p.target}`);
        ctx.expectPort(port, p.protocol);
      } else if (zone === ZONE_HOST) {
        ctx.expectPort(p.target, p.protocol);
        if (port !== p.target) ctx.note(`${svc.name}: machine ${inst.base} shares the host's network namespace and binds the container port ${p.target}, not ${port}`, "decision");
      } else {
        ctx.note(`${svc.name}: machine ${inst.base} has no zone bridge on ${ctx.host} (zone ${zone || "undecided"}), so port ${port} is not forwarded`, "decision");
      }
      if (how === "external-lb") ctx.note(`${svc.name}: port ${port} is a backend of your external load balancer on ${ctx.host}`);
      if (how === "dns-rr") ctx.note(`${svc.name}: port ${port} on ${ctx.host} is announced for DNS round robin by the resolved component`);
    }
    for (const n of memberNetworks(inv, svc)) {
      ctx.expect("networks", n.name);
      if (n.name !== zone) ctx.note(`${svc.name}: also a member of ${n.name} in the source, but a machine attaches to one zone (${zone || "undecided"}); it reaches ${n.name} through the host`);
    }
    if (zone === ZONE_HOST) ctx.note(`${svc.name}: zone "host" leaves machine ${inst.base} in the host's network namespace (Private=no); it binds the host's addresses like a plain service`);
  }
}

/**
 * A macvlan or ipvlan network: the machines sit on the parent link's segment
 * with their own interface (systemd-nspawn's MACVLAN= or IPVLAN=), and the
 * host gets a sibling interface on the same parent so it can reach them,
 * which the parent link itself cannot. No DHCP server runs here: the segment
 * is the site's, so each machine's address is derived for the guest to configure.
 */
function renderAttached(ctx: RenderContext, net: Network, parent: string, hostAddress: string, machines: Array<{ base: string; service: string; address: string }>): void {
  const kind = net.driver === "ipvlan" ? "ipvlan" : "macvlan";
  const key = kind === "ipvlan" ? "IPVLAN" : "MACVLAN";
  const mv = `25-migration-mv-${net.name}`;
  const gateway = net.ipam.config.map((c) => c.gateway).find(Boolean) ?? null;
  ctx.file(
    `etc/systemd/network/${mv}.netdev`,
    renderSections([`Rendered by ${ctx.rendererName}: the host's ${kind} interface on ${parent}, the parent link of ${net.driver} network ${net.name}, so the host can reach the machines on the segment`], [
      ["NetDev", [["Name", `mv-${net.name}`], ["Kind", kind], ["Description", `${kind} of ${net.name} on ${parent}`]]],
      [key, [["Mode", kind === "ipvlan" ? "L2" : "bridge"]]],
    ]),
  );
  ctx.file(
    `etc/systemd/network/${mv}.network`,
    renderSections([`Rendered by ${ctx.rendererName}: the host's address on the segment of ${net.name}`], [
      ["Match", [["Name", `mv-${net.name}`]]],
      ["Link", [["RequiredForOnline", "no"]]],
      ["Network", [["Address", hostAddress], ["LinkLocalAddressing", "no"], ["IPv6AcceptRA", "no"]]],
    ]),
  );
  ctx.file(
    `etc/systemd/network/25-migration-parent-${net.name}.network`,
    renderSections([`Rendered by ${ctx.rendererName}: stacks mv-${net.name} on the parent link ${parent} (decision ${parentId(net.name)}); a .network that already configures ${parent} takes precedence over this one only when it sorts first, so merge this line into it and delete this file if one exists`], [
      ["Match", [["Name", parent]]],
      ["Link", [["RequiredForOnline", "no"]]],
      ["Network", [[key, `mv-${net.name}`]]],
    ]),
  );
  for (const f of [`${mv}.netdev`, `${mv}.network`, `25-migration-parent-${net.name}.network`]) ctx.expect("networks", f);
  ctx.note(`${net.name}: 25-migration-parent-${net.name}.network matches ${parent} by name; if ${parent} already has a .network on ${ctx.host}, move ${key}=mv-${net.name} into it and delete the rendered file, or the first file in sort order configures the link alone`, "decision");
  for (const m of machines) {
    ctx.unitAt(`etc/systemd/nspawn/${m.base}.nspawn`).add("Network", key, parent);
    ctx.note(`${m.service}: machine ${m.base} gets a ${kind} interface on ${parent} (${key}=${parent}); the guest must configure ${m.address} on it itself${gateway ? ` with the segment's gateway ${gateway}` : ""}, as the host runs no DHCP server on the site's segment; the machined component still writes Zone=${net.name}, which also attaches an unused zone bridge, until it omits Zone= for ${net.driver} networks`, "decision");
  }
}
