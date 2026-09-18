// SPDX-License-Identifier: LGPL-2.1-or-later
//
// What the networkd component's three modules share: the decision ids it
// raises, the state keys it publishes, the address arithmetic every rendered
// address is derived from, and the small readers over the inventory and the
// plan. Nothing here decides anything; every value ultimately comes from a
// decision in plan.yaml (see contract/plan.ts).

import { createHash } from "node:crypto";
import type { RenderContext } from "../../../contract/component.ts";
import { computePlacement } from "../../../contract/compose.ts";
import type { Inventory, Network, Service } from "../../../contract/types.ts";

// The decision ids. They are dotted and stable, so the same estate yields the
// same plan across runs and an operator's answers survive a re-plan.

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

/** Who configures the host's uplink link: the site, or this plan (PLAN.md 10.5). */
export function uplinkOwnerId(host: string): string {
  return `networkd.uplink.owner.${host}`;
}
/** The bonding mode the harness puts the uplink into, or `none`. */
export function uplinkBondId(host: string): string {
  return `networkd.uplink.bond.${host}`;
}
/** Whether the harness tags the uplink, and with which VLAN id. */
export function uplinkVlanId(host: string): string {
  return `networkd.uplink.vlan.${host}`;
}
export function uplinkVlanTagId(host: string): string {
  return `networkd.uplink.vlan.id.${host}`;
}
/** Whether the harness puts the uplink into a VRF, and which routing table it uses. */
export function uplinkVrfId(host: string): string {
  return `networkd.uplink.vrf.${host}`;
}
export function uplinkVrfTableId(host: string): string {
  return `networkd.uplink.vrf.table.${host}`;
}

/** The identifier a transport needs beside its addresses: a GRE key, an L2TP tunnel id, an xfrm interface id, a MACsec port. */
export function tunnelKeyId(net: string): string {
  return `networkd.tunnel.key.${net}`;
}
/** The UDP port an encapsulating transport listens on (GENEVE, L2TP, Foo-over-UDP, bare UDP). */
export function tunnelPortId(net: string): string {
  return `networkd.tunnel.port.${net}`;
}
/** The address the other hosts reach a host at over IPv6, for the transports whose endpoints are IPv6. */
export function endpoint6Id(host: string): string {
  return `networkd.endpoint6.${host}`;
}
/** The host link a MACsec transport protects. */
export function macsecParentId(net: string): string {
  return `networkd.macsec.parent.${net}`;
}
/** The L3 protocol a bare UDP tunnel carries. */
export function bareudpEtherTypeId(net: string): string {
  return `networkd.bareudp.ethertype.${net}`;
}

/** The ingress decision of a published port: where the port exists (PLAN.md 10.2). */
export function ingressId(service: string, port: number, protocol: string): string {
  return `networkd.ingress.${service}.${port}-${protocol}`;
}
/** The service's virtual address when a load-balancing option anchors one. */
export function vipId(service: string): string {
  return `networkd.vip.${service}`;
}
/** Which declarative multipath form carries the VIP's traffic to the backends. */
export function multipathId(service: string): string {
  return `networkd.multipath.${service}`;
}
/** The range service virtual addresses are taken from. */
export const VIP_RANGE = "networkd.vip.range.estate";
/** How long an idle socket-activated proxy stays resident. */
export const PROXY_IDLE = "networkd.proxy.idle.estate";

/** The zone option that leaves a machine in the host's network namespace. */
export const ZONE_HOST = "host";

/** The key under which this component publishes the estate's static leases for the resolved component. */
export const LEASES = "networkd:leases";
/** The key under which this component publishes the backends of every published port for the adapters (haproxy-ingress). */
export const BACKENDS = "networkd:backends";
/** The key under which this component publishes the socket-proxyd instances of a host for the rollout controller. */
export const PROXIES = "networkd:proxies";

/** The publish options this component and its adapters understand, in the order the plan offers them. */
export const PUBLISH_HOST = "host";
export const PUBLISH_SOCKET = "socket";
export const PUBLISH_REUSEPORT = "reuseport";
export const PUBLISH_PROXY = "socket-proxyd";
export const PUBLISH_MULTIPATH = "multipath";
export const PUBLISH_HAPROXY = "haproxy";
export const PUBLISH_EXTERNAL = "external-lb";
export const PUBLISH_DNS_RR = "dns-rr";

/** The ingress scopes of a published port. */
export const INGRESS_PLACEMENT = "placement-hosts";
export const INGRESS_EVERY_HOST = "every-host";

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

/** One systemd-socket-proxyd instance rendered on this host, for the rollout controller's drain and activate verbs. */
export interface Proxy {
  service: string;
  published: number;
  protocol: string;
  /** The .socket unit that owns the published port for this backend. */
  socket: string;
  /** The systemd-socket-proxyd instance the socket activates. */
  unit: string;
  /** The instance unit the proxy forwards to when the backend is on this host. */
  binds: string | null;
  backend: Backend;
}

/** The rendered pieces of a published port, keyed by `<service>.<published>-<protocol>` in the backend table. */
export function portKey(service: string, published: number, protocol: string): string {
  return `${service}.${published}-${protocol}`;
}

export function isApplicationNetwork(n: Network): boolean {
  return !n.ingress && n.name !== "host" && n.name !== "bridge" && n.name !== "none" && n.driver !== "null" && n.driver !== "host";
}

/** Networks whose members sit on a host link's segment (systemd-nspawn MACVLAN= and IPVLAN=), not on a zone bridge. */
export function isAttachedDriver(n: Network): boolean {
  return n.driver === "macvlan" || n.driver === "ipvlan";
}

/** Application networks in a stable order; a network's 1-based position here seeds its VNI and tunnel range. */
export function applicationNetworks(inv: Inventory): Network[] {
  return inv.networks.filter(isApplicationNetwork).sort((a, b) => a.name.localeCompare(b.name));
}

export function positionOf(inv: Inventory, net: string): number {
  return applicationNetworks(inv).findIndex((n) => n.name === net) + 1;
}

/** The application networks a service is a member of, in the service's own order, resolving ids and names. */
export function memberNetworks(inv: Inventory, svc: Service): Network[] {
  const out: Network[] = [];
  for (const ref of svc.networks) {
    const n = inv.networks.find((x) => x.name === ref.name || x.id === ref.name);
    if (n && isApplicationNetwork(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The address a host answers on outside any zone: the probe's first address, else the inventory node's. */
export function hostAddress(ctx: RenderContext, host: string): string | null {
  return ctx.plan.hosts[host]?.addresses?.[0] ?? ctx.inventory.nodes.find((n) => n.hostname === host)?.addr ?? null;
}

/** The placement the plan implies, for every service: host to instance count. */
export function placementOf(ctx: RenderContext): Map<string, Map<string, number>> {
  const hosts = Object.keys(ctx.plan.hosts).length ? Object.keys(ctx.plan.hosts) : ctx.inventory.nodes.map((n) => n.hostname);
  return computePlacement(ctx.inventory, ctx.plan, hosts, ctx.acceptDefaults);
}

/** Every host the plan renders a tree for: the union of the placements, which is the widest an ingress can reach. */
export function renderedHosts(ctx: RenderContext): string[] {
  const out = new Set<string>();
  for (const per of placementOf(ctx).values()) for (const h of per.keys()) out.add(h);
  return [...out].sort();
}

// IPv4 arithmetic. Every address a bridge, lease, tunnel, VIP, or route
// carries is derived from a decided range and a position, so the same plan
// yields the same addresses on every run and on every host.

export interface Cidr {
  base: number;
  prefix: number;
  size: number;
}

export function ip4ToNumber(a: string): number {
  return a.split(".").reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0) >>> 0;
}

export function numberToIp4(n: number): string {
  return [24, 16, 8, 0].map((s) => ((n >>> s) & 0xff).toString()).join(".");
}

/** An IPv4 range, or null when the value is IPv6 or malformed (the caller notes it). */
export function parseCidr(value: string): Cidr | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (!m) return null;
  const prefix = Number(m[2]);
  if (prefix > 32) return null;
  const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
  const base = prefix === 0 ? 0 : (ip4ToNumber(m[1]!) & (~0 << (32 - prefix))) >>> 0;
  return { base, prefix, size };
}

/** Smallest exponent e with 2^e >= n, so n hosts fit in 2^e equal slices. */
export function sliceExponent(n: number): number {
  let e = 0;
  while (2 ** e < n) e++;
  return e;
}

/**
 * A network interface name the kernel accepts: at most IFNAMSIZ - 1 = 15
 * characters. A longer one keeps its first ten characters and takes a
 * four-character digest of the whole name, the way systemd-nspawn shortens
 * the names of long machines, so the name stays stable and unique.
 */
export function linkName(prefix: string, ...parts: string[]): string {
  const raw = [prefix, ...parts].join("-");
  if (raw.length <= 15) return raw;
  return `${raw.slice(0, 10)}-${createHash("sha256").update(raw).digest("hex").slice(0, 4)}`;
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

export type SectionEntries = Array<[string, string | number | null | undefined]>;
export type Section = [string, SectionEntries];

/** Render a unit-style file whose sections may repeat ([WireGuardPeer], [DHCPServerStaticLease], [Route]). */
export function renderSections(header: string[], sections: Section[]): string {
  const out = header.map((l) => (l ? `# ${l}` : "#"));
  for (const [name, entries] of sections) {
    const lines = entries.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`);
    if (lines.length === 0) continue;
    out.push("", `[${name}]`, ...lines);
  }
  return out.join("\n") + "\n";
}
