// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The networkd component: what replaces the orchestrator's networks. Every
// address range, overlay transport, published-port policy, load-balancing
// mechanism, ingress scope, zone attachment, parent link, tunnel identifier,
// key, endpoint, virtual address, and uplink owner is a decision with the
// source's own values as evidence, never a constant. This module raises those
// decisions, renders the port policy of plain services, and renders the zone
// bridge, the DHCP leases, the uplink the harness owns, and the transport
// between hosts for every service the plan runs as a machine or a virtual
// machine (see the systemd-networkd skill, references/zone-bridge.md,
// references/transports.md, and references/load-balancing.md).
//
// The transports live in transports.ts, the load balancing in publish.ts, and
// the ids, the address arithmetic, and the readers in shared.ts. The public
// surface other components import is re-exported here.

import { basename } from "node:path";
import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import { formId, placementId } from "../../../contract/compose.ts";
import type { DecisionOption } from "../../../contract/plan.ts";
import { splitList } from "../../../contract/plan.ts";
import type { Network, Service } from "../../../contract/types.ts";
import { unitBaseName } from "../../../contract/unit.ts";
import { MULTIPATH_NEXTHOP, MULTIPATH_ROUTE, PROXY_IDLE_DEFAULT, publishedOf, renderPublishing, sortedPorts } from "./publish.ts";
import { type TransportContext, TRANSPORTS, renderTunnel, transportRequires, transportSpec } from "./transports.ts";
import {
  type Cidr,
  INGRESS_EVERY_HOST,
  INGRESS_PLACEMENT,
  type Lease,
  LEASES,
  PROXY_IDLE,
  PUBLISH_DNS_RR,
  PUBLISH_EXTERNAL,
  PUBLISH_HAPROXY,
  PUBLISH_MULTIPATH,
  PUBLISH_PROXY,
  PUBLISH_REUSEPORT,
  PUBLISH_SOCKET,
  type Section,
  VIP_RANGE,
  WIREGUARD_PORT,
  ZONE_HOST,
  applicationNetworks,
  bareudpEtherTypeId,
  domainId,
  endpoint6Id,
  ingressId,
  isAttachedDriver,
  linkName,
  machineMac,
  macsecParentId,
  memberNetworks,
  multipathId,
  numberToIp4,
  parentId,
  parseCidr,
  positionOf,
  publishId,
  renderSections,
  sliceExponent,
  subnetId,
  transportId,
  tunnelKeyId,
  tunnelPortId,
  uplinkBondId,
  uplinkId,
  uplinkOwnerId,
  uplinkVlanId,
  uplinkVlanTagId,
  uplinkVrfId,
  uplinkVrfTableId,
  vipId,
  vniId,
  wireguardEndpointId,
  wireguardSubnetId,
  zoneId,
} from "./shared.ts";

// The surface the other components and the adapters import from here.
export {
  BACKENDS,
  INGRESS_EVERY_HOST,
  INGRESS_PLACEMENT,
  LEASES,
  PROXIES,
  PROXY_IDLE,
  PUBLISH_DNS_RR,
  PUBLISH_EXTERNAL,
  PUBLISH_HAPROXY,
  PUBLISH_MULTIPATH,
  PUBLISH_PROXY,
  PUBLISH_REUSEPORT,
  PUBLISH_SOCKET,
  VIP_RANGE,
  WIREGUARD_PORT,
  ZONE_HOST,
  bareudpEtherTypeId,
  domainId,
  endpoint6Id,
  ingressId,
  linkName,
  machineMac,
  macsecParentId,
  multipathId,
  parentId,
  portKey,
  publishId,
  subnetId,
  transportId,
  tunnelKeyId,
  tunnelPortId,
  uplinkBondId,
  uplinkId,
  uplinkOwnerId,
  uplinkVlanId,
  uplinkVlanTagId,
  uplinkVrfId,
  uplinkVrfTableId,
  vipId,
  vniId,
  wireguardEndpointId,
  wireguardSubnetId,
  zoneId,
} from "./shared.ts";
export type { Backend, Lease, Proxy } from "./shared.ts";
export { MULTIPATH_NEXTHOP, MULTIPATH_ROUTE, PROXY_BINARY, PROXY_TEMPLATE, backendsOf, ingressScope, nextHopBase, vipLink } from "./publish.ts";
export { TRANSPORTS, transportSpec } from "./transports.ts";

/** The choice a service's tap takes when the plan runs it as a virtual machine. */
export function tapId(service: string): string {
  return `networkd.tap.${service}`;
}
const TAP_VMSPAWN = "vmspawn";
const TAP_NETWORKD = "networkd";

/** The transports whose keys come from the WireGuard credentials and whose addresses come from the tunnel range. */
const WIREGUARD_TRANSPORTS = new Set(["wireguard", "vxlan-wireguard"]);
/** The transports that put a VXLAN into the zone bridge. */
const VXLAN_TRANSPORTS = new Set(["vxlan", "vxlan-wireguard"]);
/** The transports whose endpoints are IPv6 addresses. */
const IPV6_TRANSPORTS = new Set(TRANSPORTS.filter((t) => t.ipv6).map((t) => t.value));

/** The base UDP port each encapsulating transport takes by convention; the network's position is added so two never collide. */
const TRANSPORT_PORTS: Record<string, { port: number; why: string }> = {
  geneve: { port: 6081, why: "6081 is the port IANA assigns to GENEVE" },
  l2tp: { port: 1701, why: "1701 is the port IANA assigns to L2TP" },
  fou: { port: 5555, why: "5555 is the port the Foo-over-UDP example in systemd.netdev(5) uses" },
  bareudp: { port: 6635, why: "6635 is the port IANA assigns to MPLS-in-UDP, the encapsulation bare UDP tunnels were added for" },
};

function transportOptions(): DecisionOption[] {
  return TRANSPORTS.map((t) => ({ value: t.value, label: t.label, consequence: t.consequence, ...(t.value === "underlay" ? {} : { requires: transportRequires(t) }) }));
}

/** Where a machine or virtual machine of the estate lands, from the plan's placement, form, and zone decisions. */
interface Attachment {
  network: string;
  host: string;
  base: string;
  service: Service;
  form: "machine" | "vm";
  /** Position among the machines attached to the same network on the same host, sorted by name. */
  index: number;
}

function attachments(ctx: RenderContext): Attachment[] {
  const inv = ctx.inventory;
  const out: Attachment[] = [];
  for (const svc of inv.services) {
    const form = ctx.valueOr(formId(svc.name), "service");
    if (form !== "machine" && form !== "vm") continue;
    const zone = ctx.hasDecision(zoneId(svc.name)) ? ctx.valueOr(zoneId(svc.name), "") : "";
    if (!zone || zone === ZONE_HOST) continue;
    if (!memberNetworks(inv, svc).some((n) => n.name === zone)) continue;
    const counts = new Map<string, number>();
    for (const h of splitList(ctx.valueOr(placementId(svc.name), ""))) counts.set(h, (counts.get(h) ?? 0) + 1);
    for (const [host, count] of counts) for (let i = 1; i <= count; i++) out.push({ network: zone, host, base: unitBaseName(svc.name, i, count), service: svc, form, index: 0 });
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
        const chosen = ctx.previous(transportId(n.name));
        const spec = chosen ? transportSpec(chosen) : undefined;
        out.push({
          id: transportId(n.name),
          kind: "choice",
          subject: { kind: "network", name: n.name },
          hosts,
          question: `Network ${n.name} spans ${hosts.join(", ")}${n.encrypted ? " and was encrypted" : ""}. What carries it between the hosts?`,
          options: transportOptions(),
          default: n.encrypted ? "vxlan-wireguard" : null,
          evidence: [`networks[${n.name}].encrypted=${n.encrypted}`, `networks[${n.name}].scope=${n.scope}`, `members on ${hosts.length} hosts`],
        });
        out.push({
          id: vniId(n.name),
          kind: "value",
          format: "port",
          subject: { kind: "network", name: n.name },
          hosts,
          question: `Which network identifier (VNI) does ${n.name} use when its transport is VXLAN or GENEVE? The default is its position among the application networks sorted by name.`,
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
        // What the chosen transport needs beyond its endpoints. Raised once the
        // transport is chosen, so a plan that keeps VXLAN carries none of them.
        if (spec?.needs.includes("key")) {
          out.push({
            id: tunnelKeyId(n.name),
            kind: "value",
            format: "port",
            subject: { kind: "network", name: n.name },
            hosts,
            question: `Which identifier does the ${spec.label} of ${n.name} carry (the GRE key, the L2TP tunnel id, the xfrm interface id, or the MACsec port, depending on the kind)? The default is the network's position among the application networks sorted by name.`,
            default: String(position),
            evidence: [`networks[${n.name}] chose transport ${spec.value}`, `networks[${n.name}] is application network ${position} (sorted by name)`, "the identifier has to match on every host of the network"],
          });
        }
        if (spec?.needs.includes("port")) {
          const base = TRANSPORT_PORTS[spec.value];
          out.push({
            id: tunnelPortId(n.name),
            kind: "value",
            format: "port",
            subject: { kind: "network", name: n.name },
            hosts,
            question: `Which UDP port does the ${spec.label} of ${n.name} use? The default is the conventional port for the kind plus the network's position, so two networks on one host never collide.`,
            default: base ? String(base.port + position - 1) : null,
            evidence: [`networks[${n.name}] chose transport ${spec.value}`, ...(base ? [base.why] : []), `networks[${n.name}] is application network ${position} (sorted by name)`],
          });
        }
        if (spec?.needs.includes("ethertype")) {
          out.push({
            id: bareudpEtherTypeId(n.name),
            kind: "choice",
            subject: { kind: "network", name: n.name },
            hosts,
            question: `Which L3 protocol does the bare UDP tunnel of ${n.name} carry (EtherType= of the netdev)?`,
            options: [
              { value: "ipv4", label: "IPv4", consequence: "the tunnel carries IPv4 packets, which is what the rendered slices are" },
              { value: "ipv6", label: "IPv6", consequence: "the tunnel carries IPv6 packets; the rendered IPv4 slices do not travel over it" },
              { value: "mpls-uc", label: "MPLS unicast", consequence: "the tunnel carries MPLS unicast labels; the routes need an MPLS stack the plan does not render" },
              { value: "mpls-mc", label: "MPLS multicast", consequence: "the tunnel carries MPLS multicast labels; the routes need an MPLS stack the plan does not render" },
            ],
            default: "ipv4",
            evidence: [`networks[${n.name}] chose transport bareudp`, `networks[${n.name}].ipam.config=${JSON.stringify(n.ipam.config)} is IPv4`],
          });
        }
        if (spec?.needs.includes("parent")) {
          out.push({
            id: macsecParentId(n.name),
            kind: "value",
            format: "name",
            subject: { kind: "network", name: n.name },
            hosts,
            question: `Which host link does the MACsec interface of ${n.name} protect? MACsec secures one Ethernet segment, so every host of ${n.name} has to sit on it.`,
            default: null,
            evidence: [`networks[${n.name}] chose transport macsec`, `hosts on the segment: ${hosts.join(", ")}`, "the inventory records no host link, because the source's overlay hid it"],
          });
        }
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
      const chosen = applicationNetworks(inv).map((n) => ctx.previous(transportId(n.name)));
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
        if (chosen.some((t) => t && IPV6_TRANSPORTS.has(t))) {
          const probed6 = ctx.hosts[h]?.addresses?.find((a) => a.includes(":")) ?? null;
          out.push({
            id: endpoint6Id(h),
            kind: "value",
            format: "text",
            subject: { kind: "host", name: h },
            hosts: [h],
            question: `Which IPv6 address do the other hosts reach ${h} at? A transport chose a kind whose endpoints are IPv6 (ip6gre, ip6gretap, ip6tnl, or vti6).`,
            default: probed6,
            evidence: [`transports in use: ${chosen.filter((t) => t && IPV6_TRANSPORTS.has(t)).join(", ")}`, probed6 ? `hosts[${h}].addresses contains ${probed6}` : `hosts[${h}] has no probed IPv6 address`],
          });
        }
        if (chosen.includes("underlay")) {
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
          out.push({
            id: uplinkOwnerId(h),
            kind: "choice",
            subject: { kind: "host", name: h },
            hosts: [h],
            question: `Who configures the uplink of ${h}: the site, or this plan?`,
            options: [
              { value: "site", label: "the site keeps it", consequence: "only a [Route] drop-in for the uplink's own .network is rendered; nothing else about the link is touched" },
              { value: "harness", label: "this plan owns it", consequence: "the bond, VLAN, and VRF decisions below are raised and rendered on top of the uplink, and the peer routes move onto the topmost interface" },
            ],
            default: "site",
            evidence: [`hosts[${h}] answered ${uplinkId(h)}`, "a link that carries the site's own traffic is not this plan's to reshape unless you say so"],
          });
        }
        if (ctx.previous(uplinkId(h)) && ctx.previous(uplinkOwnerId(h)) === "harness") {
          const index = [...overlayHosts].sort().indexOf(h);
          out.push({
            id: uplinkBondId(h),
            kind: "choice",
            subject: { kind: "host", name: h },
            hosts: [h],
            question: `Does this plan aggregate the uplink of ${h} into a bond, and in which mode ([Bond] Mode= of systemd.netdev(5))?`,
            options: [
              { value: "none", label: "no bond", consequence: "the uplink stays a single link" },
              { value: "active-backup", label: "active-backup", consequence: "one link carries the traffic and the others stand by; needs no switch configuration" },
              { value: "balance-xor", label: "balance-xor", consequence: "traffic is hashed over the links; the switch has to put the ports in a static aggregate" },
              { value: "802.3ad", label: "802.3ad (LACP)", consequence: "the links negotiate an aggregate with the switch; the switch has to run LACP on the ports" },
            ],
            default: "none",
            evidence: [`hosts[${h}] answered ${uplinkOwnerId(h)}=harness`, `the uplink's own file is ${ctx.previous(uplinkId(h))}`],
          });
          out.push({
            id: uplinkVlanId(h),
            kind: "choice",
            subject: { kind: "host", name: h },
            hosts: [h],
            question: `Does the overlay traffic of ${h} travel on a tagged VLAN of the uplink?`,
            options: [
              { value: "no", label: "untagged", consequence: "the transports use the uplink itself" },
              { value: "yes", label: "tagged", consequence: "a vlan netdev is stacked on the uplink and the peer routes move onto it; the tag is the decision below" },
            ],
            default: "no",
            evidence: [`hosts[${h}] answered ${uplinkOwnerId(h)}=harness`],
          });
          if (ctx.previous(uplinkVlanId(h)) === "yes") {
            out.push({
              id: uplinkVlanTagId(h),
              kind: "value",
              format: "port",
              subject: { kind: "host", name: h },
              hosts: [h],
              question: `Which VLAN id does the overlay traffic of ${h} carry (1 to 4094)? The switch port has to trunk it.`,
              default: null,
              evidence: [`hosts[${h}] answered ${uplinkVlanId(h)}=yes`, "the inventory carries no VLAN, because the source's overlay hid the site's network"],
            });
          }
          out.push({
            id: uplinkVrfId(h),
            kind: "choice",
            subject: { kind: "host", name: h },
            hosts: [h],
            question: `Does this plan put the uplink of ${h} into a VRF, so the estate's routes live in their own table?`,
            options: [
              { value: "no", label: "the main table", consequence: "the peer routes land in the main routing table beside the host's own" },
              { value: "yes", label: "a VRF", consequence: "a vrf netdev takes the topmost uplink interface and the peer routes carry Table= of the VRF; a service reaches them only inside the VRF" },
            ],
            default: "no",
            evidence: [`hosts[${h}] answered ${uplinkOwnerId(h)}=harness`],
          });
          if (ctx.previous(uplinkVrfId(h)) === "yes") {
            out.push({
              id: uplinkVrfTableId(h),
              kind: "value",
              format: "port",
              subject: { kind: "host", name: h },
              hosts: [h],
              question: `Which routing table does the VRF of ${h} use ([VRF] Table=)? Any table the host does not already use will do; the default is derived from the host's position so two rendered trees can be diffed.`,
              default: String(100 + index),
              evidence: [`hosts[${h}] answered ${uplinkVrfId(h)}=yes`, `${h} is host ${index + 1} of the overlay hosts sorted by name`],
            });
          }
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
      if (ctx.previous(formId(svc.name)) === "vm") {
        out.push({
          id: tapId(svc.name),
          kind: "choice",
          subject: { kind: "service", name: svc.name },
          question: `The plan runs ${svc.name} as a virtual machine. Who creates the tap that joins it to the zone bridge?`,
          options: [
            { value: TAP_VMSPAWN, label: "systemd-vmspawn", consequence: "only the .network that enslaves vt-<machine> into the zone bridge is rendered; systemd-vmspawn --network-tap creates the interface when the machine starts" },
            { value: TAP_NETWORKD, label: "systemd-networkd", consequence: "a tap netdev is rendered too, so the interface exists before the machine starts; systemd-vmspawn --network-tap then finds the name taken, so the machine has to be given the existing tap instead" },
          ],
          default: TAP_VMSPAWN,
          evidence: [`form.service.${svc.name}=vm`, "systemd-vmspawn(1) --network-tap creates vt-<machine> and points at /usr/lib/systemd/network/80-vm-vt.network for the host side"],
        });
      }
    }
    const multipath: string[] = [];
    for (const svc of inv.services) {
      for (const p of sortedPorts(svc)) {
        const published = publishedOf(p);
        out.push({
          id: publishId(svc.name, published, p.protocol),
          kind: "choice",
          subject: { kind: "port", name: `${svc.name}:${published}/${p.protocol}` },
          question: `Port ${published}/${p.protocol} of ${svc.name} was published in ${p.mode} mode${p.mode === "ingress" ? " through the routing mesh" : ""}. How do clients reach it now?`,
          options: [
            { value: "host", label: "on each host that runs it", consequence: "the service binds the port on its host; SocketBindAllow= restricts it to that port; clients use the host's address; it cannot honour an every-host ingress" },
            { value: PUBLISH_SOCKET, label: "socket activation", consequence: "a .socket unit owns the port and passes it in; the process must accept an inherited socket; it cannot honour an every-host ingress", requires: { systemd: 250 } },
            { value: PUBLISH_REUSEPORT, label: "socket activation with ReusePort=", consequence: "one .socket per instance on this host with ReusePort=yes, so the kernel spreads connections over the instances that share the host; the process must accept an inherited socket, and it cannot honour an every-host ingress", requires: { systemd: 250 } },
            { value: PUBLISH_PROXY, label: "systemd-socket-proxyd per backend", consequence: "one .socket with ReusePort=yes per backend, each activating a systemd-socket-proxyd instance forwarding to that backend; spreads over every instance of the estate, local or remote, and honours the ingress scope", requires: { systemd: 250 } },
            { value: PUBLISH_MULTIPATH, label: "a virtual address with multipath routes", consequence: "the service gets an address of its own on a dummy netdev and the hosts that run no instance route it over the backends; layer 3, per flow, not health aware, and honours the ingress scope", requires: { systemd: 245 } },
            { value: PUBLISH_HAPROXY, label: "HAProxy", consequence: "the haproxy-ingress component renders a hardened haproxy unit with one backend per instance and health checks from the source healthcheck; honours the ingress scope and needs the haproxy binary on the host", requires: { tools: ["haproxy"] } },
            { value: PUBLISH_EXTERNAL, label: "behind an external load balancer", consequence: "same as host, and the plan lists the hosts as backends for the balancer you operate" },
            { value: PUBLISH_DNS_RR, label: "DNS round robin", consequence: "same as host, plus one resolved/dnssd record per host announcing the port" },
          ],
          default: p.mode === "host" ? "host" : null,
          evidence: [`services[${svc.name}].ports[${p.target}] mode=${p.mode} published=${p.published ?? "unset"}`, `services[${svc.name}].endpoint_mode=${svc.endpoint_mode}`, `services[${svc.name}].mode=${svc.mode}${svc.replicas != null ? ` replicas=${svc.replicas}` : ""}`],
        });
        out.push({
          id: ingressId(svc.name, published, p.protocol),
          kind: "choice",
          subject: { kind: "port", name: `${svc.name}:${published}/${p.protocol}` },
          question: `Where does port ${published}/${p.protocol} of ${svc.name} exist: only where the service runs, or on every host of the plan?`,
          options: [
            { value: INGRESS_PLACEMENT, label: "the hosts that run it", consequence: "the port is bound where an instance lands; clients have to know which hosts those are" },
            { value: INGRESS_EVERY_HOST, label: "every host of the plan", consequence: "the routing mesh of the source: every host accepts the port and forwards to an instance; only socket-proxyd, multipath, and haproxy can honour it" },
          ],
          default: INGRESS_PLACEMENT,
          evidence: [`services[${svc.name}].ports[${p.target}] mode=${p.mode}`, p.mode === "ingress" ? "the source accepted this port on every node through the routing mesh" : "the source bound this port only on the nodes that ran the task"],
        });
        if (ctx.previous(publishId(svc.name, published, p.protocol)) === PUBLISH_MULTIPATH && !multipath.includes(svc.name)) multipath.push(svc.name);
      }
    }
    if (multipath.length) {
      const range = ctx.previous(VIP_RANGE) ?? "100.65.0.0/24";
      const cidr = parseCidr(range);
      out.push({
        id: VIP_RANGE,
        kind: "value",
        format: "cidr",
        subject: { kind: "estate", name: "estate" },
        question: "Which range do the services' virtual addresses come from? One address per service with a multipath port is taken from it, in the order of the service names.",
        default: "100.65.0.0/24",
        evidence: [`services with a multipath port: ${multipath.sort().join(", ")}`, "RFC 6598 sets aside 100.64.0.0/10 for addresses that are neither public nor site-local; the WireGuard tunnel ranges take 100.64.0.0/16, so the virtual addresses take the next /24 by default"],
      });
      for (const [i, name] of multipath.sort().entries()) {
        out.push({
          id: vipId(name),
          kind: "value",
          format: "ipv4",
          subject: { kind: "service", name },
          question: `Which address does ${name} answer on when its published port is reached through a multipath route? The default is the ${i + 1}th address of the range in ${VIP_RANGE}.`,
          default: cidr ? numberToIp4(cidr.base + 1 + i) : null,
          evidence: [`services[${name}] has a port whose publish decision chose ${PUBLISH_MULTIPATH}`, `${VIP_RANGE}=${range}`, `${name} is service ${i + 1} of ${multipath.length} with a virtual address, sorted by name`],
        });
        out.push({
          id: multipathId(name),
          kind: "choice",
          subject: { kind: "service", name },
          question: `Which form carries the virtual address of ${name} to its backends?`,
          options: [
            { value: MULTIPATH_ROUTE, label: "MultiPathRoute= in [Route]", consequence: "one [Route] with a MultiPathRoute= line per backend; the kernel hashes each flow onto one of them, and networkd needs no nexthop ids" },
            { value: MULTIPATH_NEXTHOP, label: "a nexthop group in [NextHop]", consequence: "one [NextHop] per backend plus a group that weights them, referenced by the route; the ids are derived from the service name and must not collide with the host's own nexthops" },
          ],
          default: MULTIPATH_ROUTE,
          evidence: [`services[${name}] has a port whose publish decision chose ${PUBLISH_MULTIPATH}`, "both forms are documented in systemd.network(5); MultiPathRoute= is the older and simpler of the two"],
        });
      }
    }
    if (inv.services.some((s) => s.ports.some((p) => ctx.previous(publishId(s.name, publishedOf(p), p.protocol)) === PUBLISH_PROXY))) {
      out.push({
        id: PROXY_IDLE,
        kind: "value",
        format: "text",
        subject: { kind: "estate", name: "estate" },
        question: "How long does an idle socket proxy stay resident before it exits and leaves the socket to re-activate it (--exit-idle-time of systemd-socket-proxyd)?",
        default: PROXY_IDLE_DEFAULT,
        evidence: [`ports publishing through ${PUBLISH_PROXY}: ${inv.services.flatMap((s) => s.ports.filter((p) => ctx.previous(publishId(s.name, publishedOf(p), p.protocol)) === PUBLISH_PROXY).map((p) => `${s.name}:${publishedOf(p)}/${p.protocol}`)).join(", ")}`, "systemd-socket-proxyd(8) defaults to infinity, which keeps one process per backend resident for ever"],
      });
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const uplink = renderUplink(ctx);
    renderServices(ctx);
    renderMachines(ctx, uplink);
    renderPublishing(ctx);
  },
};

/** Where the peer routes of an underlay transport land on this host, and in which table. */
interface UplinkPlan {
  /** The .network file the routes drop into, by basename; null when the uplink is not decided. */
  base: string | null;
  table: string | null;
}

/**
 * The links the harness owns on this host: a bond over the uplink, a tagged
 * VLAN on top of it, and a VRF around the result, each rendered only when the
 * uplink decision is answered and its owner decision says so.
 */
function renderUplink(ctx: RenderContext): UplinkPlan {
  const id = uplinkId(ctx.host);
  if (!ctx.hasDecision(id) || !ctx.resolvable(id)) return { base: null, table: null };
  const site = basename(ctx.value(id));
  if (ctx.valueOr(uplinkOwnerId(ctx.host), "site") !== "harness") return { base: site, table: null };
  const bond = ctx.valueOr(uplinkBondId(ctx.host), "none");
  const vlan = ctx.valueOr(uplinkVlanId(ctx.host), "no") === "yes";
  const vrf = ctx.valueOr(uplinkVrfId(ctx.host), "no") === "yes";
  const tag = vlan && ctx.resolvable(uplinkVlanTagId(ctx.host)) ? ctx.value(uplinkVlanTagId(ctx.host)) : null;
  const table = vrf ? ctx.valueOr(uplinkVrfTableId(ctx.host), "") : null;
  if (vlan && !tag) ctx.note(`${ctx.host}: the uplink was to carry a tagged VLAN but ${uplinkVlanTagId(ctx.host)} is unanswered, so no vlan netdev is rendered`, "decision");
  if (vrf && !table) ctx.note(`${ctx.host}: the uplink was to sit in a VRF but ${uplinkVrfTableId(ctx.host)} is unanswered, so no vrf netdev is rendered`, "decision");
  const bondName = linkName("bond", "mig");
  const vlanName = tag ? linkName("vl", tag) : null;
  const vrfName = table ? linkName("vrf", "mig") : null;
  const file = (name: string, header: string, sections: Section[]) => {
    ctx.file(`etc/systemd/network/${name}`, renderSections([header], sections));
    ctx.expect("networks", name);
  };
  // The topmost interface the estate's traffic leaves through, and the file that configures it.
  const top = vlanName ?? (bond !== "none" ? bondName : null);
  let base = site;
  if (bond !== "none") {
    file(`25-migration-bond.netdev`, `Rendered by ${ctx.rendererName}: the bond this plan owns on ${ctx.host} (decision ${uplinkBondId(ctx.host)}=${bond}); the uplink named by ${uplinkId(ctx.host)} is enslaved into it`, [
      ["NetDev", [["Name", bondName], ["Kind", "bond"], ["Description", `uplink bond of ${ctx.host}`]]],
      ["Bond", [["Mode", bond]]],
    ]);
    base = "25-migration-bond.network";
    file(base, `Rendered by ${ctx.rendererName}: the bond's own configuration on ${ctx.host}; a bonded link carries the addressing the uplink used to carry, so move Address=, Gateway=, and DHCP= here from ${site}`, [
      ["Match", [["Name", bondName]]],
      ["Link", [["RequiredForOnline", "yes"]]],
      ["Network", [["VLAN", vlanName], ["VRF", vlanName ? null : vrfName]]],
    ]);
    ctx.note(`${ctx.host}: the uplink ${site} is enslaved into ${bondName}; an enslaved link cannot carry addresses, so move its Address=, Gateway=, and DHCP= lines into 25-migration-bond.network before installing`, "decision");
  }
  if (vlanName) {
    file(`25-migration-vlan.netdev`, `Rendered by ${ctx.rendererName}: the tagged VLAN ${tag} this plan owns on ${ctx.host} (decision ${uplinkVlanTagId(ctx.host)})`, [
      ["NetDev", [["Name", vlanName], ["Kind", "vlan"], ["Description", `VLAN ${tag} of the uplink of ${ctx.host}`]]],
      ["VLAN", [["Id", tag]]],
    ]);
    base = "25-migration-uplink.network";
    file(base, `Rendered by ${ctx.rendererName}: the tagged uplink of ${ctx.host}; the estate's peer routes drop into this file's .d directory`, [
      ["Match", [["Name", vlanName]]],
      ["Link", [["RequiredForOnline", "yes"]]],
      ["Network", [["VRF", vrfName], ["IPv4Forwarding", "yes"]]],
    ]);
  }
  if (vrfName) {
    file(`25-migration-vrf.netdev`, `Rendered by ${ctx.rendererName}: the VRF this plan owns on ${ctx.host}, routing table ${table} (decision ${uplinkVrfTableId(ctx.host)})`, [
      ["NetDev", [["Name", vrfName], ["Kind", "vrf"], ["Description", `estate VRF of ${ctx.host}`]]],
      ["VRF", [["Table", table]]],
    ]);
    ctx.note(`${ctx.host}: the estate's peer routes live in routing table ${table} inside ${vrfName}; a process reaches them only when it runs inside the VRF (systemd.exec(5) NetworkNamespacePath= or ip vrf exec)`, "decision");
  }
  // What the site's uplink file has to gain for the stack above to attach to it.
  const stack = bond !== "none" ? ["Bond", bondName] : vlanName ? ["VLAN", vlanName] : vrfName ? ["VRF", vrfName] : null;
  if (stack) {
    file(`${site}.d/25-migration-uplink.conf`, `Rendered by ${ctx.rendererName}: stacks the links this plan owns on the uplink of ${ctx.host} (decision ${uplinkOwnerId(ctx.host)}=harness)`, [["Network", [[stack[0]!, stack[1]!]]]]);
  }
  if (top) ctx.note(`${ctx.host}: this plan owns the uplink, so the estate leaves through ${top} and the peer routes are rendered into ${base}.d/ instead of ${site}.d/`);
  return { base, table };
}

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
      const offset = inst.count > 1 ? published + (inst.index - 1) : published;
      const how = ctx.value(publishId(svc.name, published, p.protocol));
      // A socket the kernel spreads keeps the published port on every instance; the others take their own.
      const port = how === PUBLISH_REUSEPORT ? published : offset;
      const inherited = how === PUBLISH_SOCKET || how === PUBLISH_REUSEPORT;
      if (port !== p.target) ctx.note(`${svc.name}: published port ${port} differs from the container port ${p.target}; a native service listens on the port the process opens, so configure the process to listen on ${port} or front it`, "decision");
      if (inherited) {
        const reuse = how === PUBLISH_REUSEPORT;
        const s = ctx.unit(`${inst.base}-${port}.socket`, [
          `Rendered by ${ctx.rendererName}: socket activation for ${svc.name} port ${port}/${p.protocol}`,
          ...(reuse ? [`One socket per instance on ${ctx.host}, all bound to the same port with ReusePort=yes so the kernel spreads connections over them.`] : []),
        ]);
        s.add("Unit", "Description", `${inst.base} port ${port}/${p.protocol}`);
        s.add("Socket", p.protocol === "udp" ? "ListenDatagram" : "ListenStream", port);
        if (reuse) s.add("Socket", "ReusePort", "yes");
        s.add("Socket", "Service", shape.unit);
        s.add("Install", "WantedBy", "sockets.target");
        ctx.expect("sockets", `${inst.base}-${port}.socket`);
        ctx.wantedByStack(inst.stack, `${inst.base}-${port}.socket`);
        ctx.note(`${svc.name}: port ${port} is socket-activated; the process must accept the inherited listening socket (sd_listen_fds)`, "decision");
        if (reuse) ctx.note(`${svc.name}: the ${inst.count} instance(s) on ${ctx.host} each own a socket bound to ${port} with ReusePort=yes; the kernel picks one per connection, so every instance has to be started for its share to be served, and a dead instance keeps taking the connections hashed to it until its socket is stopped`);
      } else {
        u.add("Service", "SocketBindAllow", `${p.protocol}:${port}`);
      }
      // Three of the options bind the port where the service runs and nowhere else.
      if ((how === "host" || inherited) && ctx.valueOr(ingressId(svc.name, published, p.protocol), INGRESS_PLACEMENT) === INGRESS_EVERY_HOST) {
        ctx.note(`${svc.name}: port ${published}/${p.protocol} asked for an every-host ingress, which "${how}" cannot give: the port exists only on the hosts that run the service; choose ${PUBLISH_PROXY}, ${PUBLISH_MULTIPATH}, or ${PUBLISH_HAPROXY} for the mesh`, "decision");
      }
      ctx.expectPort(port, p.protocol);
      if (how === PUBLISH_EXTERNAL) ctx.note(`${svc.name}: port ${port} is a backend of your external load balancer on ${ctx.host}`);
      if (how === PUBLISH_DNS_RR) ctx.note(`${svc.name}: port ${port} on ${ctx.host} is announced for DNS round robin by the resolved component`);
      if (how === PUBLISH_HAPROXY) ctx.note(`${svc.name}: port ${port} on ${ctx.host} is fronted by the haproxy-ingress component, which reads the backend table this component publishes`);
      if (inst.count > 1 && how !== PUBLISH_REUSEPORT) ctx.note(`${svc.name}: instance ${inst.index} publishes ${port} instead of ${published} because several instances share ${ctx.host}`);
    }
    if (svc.ports.some((p) => !isInherited(ctx.value(publishId(svc.name, p.published ?? p.target, p.protocol))))) u.add("Service", "SocketBindDeny", "any");
    const nets = memberNetworks(inv, svc);
    for (const n of nets) {
      const subnet = ctx.valueOr(subnetId(n.name), "");
      const transport = ctx.hasDecision(transportId(n.name)) ? ctx.valueOr(transportId(n.name), "") : "local";
      ctx.expect("networks", n.name);
      ctx.note(`${svc.name}: member of ${n.driver} network ${n.name} (${subnet || "range undecided"}, ${transport || "transport undecided"}); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it`);
    }
    if (svc.endpoint_mode === "vip" && nets.length && !ctx.resolvable(vipId(svc.name))) {
      ctx.note(`${svc.name}: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides, unless a published port chooses ${PUBLISH_MULTIPATH} and the plan gives it an address of its own`);
    }
  }
}

function isInherited(how: string): boolean {
  return how === PUBLISH_SOCKET || how === PUBLISH_REUSEPORT;
}

/** Zone bridges, leases, transports, taps, and port forwards for the machines of the estate that land on this host. */
function renderMachines(ctx: RenderContext, uplink: UplinkPlan): void {
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
    const spec = transportSpec(transport);
    const routed = spec ? spec.layer === "l3" : false;
    const sliceSize = p.cidr.size >> p.exponent;
    const slicePrefix = p.cidr.prefix + p.exponent;
    const mine = sliceBase(p, i);
    const machines = all.filter((a) => a.network === name && a.host === ctx.host);
    if (isAttachedDriver(net)) {
      renderAttached(ctx, net, ctx.value(parentId(name)), `${numberToIp4(mine + 1)}/${p.cidr.prefix}`, machines.map((m) => ({ base: m.base, service: m.service.name, form: m.form, address: leases.find((l) => l.network === name && l.host === ctx.host && l.base === m.base)!.address })));
      rendered = true;
      continue;
    }
    const leaseHosts = spec?.layer === "l2" ? p.hosts : [ctx.host];
    const domain = ctx.value(domainId(name));
    const reserved = 2 + machines.length;
    const pool = sliceSize - reserved - 1;
    // The bridge systemd-nspawn creates for Zone=; this file replaces the shipped 80-container-vz.network for it.
    const bridge = `25-migration-vz-${name}.network`;
    const leaseSections: Section[] = leases
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
    if (`vz-${name}`.length > 15) ctx.note(`${name}: systemd-nspawn builds the zone bridge's name as vz-${name}, which is longer than an interface name may be, so it refuses Zone=${name} altogether; rename the network in the source or run its members in the host's namespace`, "decision");
    if (pool <= 0) ctx.note(`${name}: this host's slice ${numberToIp4(mine)}/${slicePrefix} has no room for a DHCP pool after ${machines.length} leases; the bridge serves the static leases only`, "decision");
    for (const m of machines) {
      const lease = leases.find((l) => l.network === name && l.host === ctx.host && l.base === m.base)!;
      if (m.form === "vm") {
        renderTap(ctx, m, name, lease);
        continue;
      }
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
      const wgDev = linkName("wg", name);
      const privateCred = `network.wireguard.private.${wg}`;
      ctx.file(
        `etc/systemd/network/${wg}.netdev`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: WireGuard tunnel of network ${name} on ${ctx.host}; the private key is the credential ${privateCred}, each peer's public key the credential named on its line`],
          [
            ["NetDev", [["Name", wgDev], ["Kind", "wireguard"], ["Description", `WireGuard mesh of ${name}`]]],
            ["WireGuard", [["ListenPort", port], ["PrivateKey", `@${privateCred}`]]],
            ...peers.map((h): Section => ["WireGuardPeer", [["PublicKey", `@network.wireguard.public.${h}`], ["Endpoint", `${endpoint(h)}:${port}`], ["AllowedIPs", `${tunnel!.of(h)}/32`], ["AllowedIPs", transport === "wireguard" ? peerSlice(h) : null], ["PersistentKeepalive", 25]]]),
          ],
        ),
      );
      ctx.file(
        `etc/systemd/network/${wg}.network`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: tunnel address of ${ctx.host} on the WireGuard mesh of ${name}`],
          [
            ["Match", [["Name", wgDev]]],
            ["Link", [["RequiredForOnline", "no"]]],
            ["Network", [["Address", `${tunnel.of(ctx.host)}/${cidr.prefix}`], ["IPv4Forwarding", transport === "wireguard" ? "yes" : null]]],
            ...(transport === "wireguard" ? peers.map((h): Section => ["Route", [["Destination", peerSlice(h)], ["Gateway", tunnel!.of(h)]]]) : []),
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
    if (VXLAN_TRANSPORTS.has(transport)) {
      const vni = ctx.value(vniId(name));
      const local = tunnel ? tunnel.of(ctx.host) : endpoint(ctx.host);
      const remote = (h: string) => (tunnel ? tunnel.of(h) : endpoint(h));
      const vx = `25-migration-vx-${name}`;
      const vxDev = linkName("vx", name);
      ctx.file(
        `etc/systemd/network/${vx}.netdev`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: VXLAN of network ${name} on ${ctx.host}, VNI ${vni}, ${tunnel ? "inside the WireGuard mesh" : "over the underlay"}`],
          [
            ["NetDev", [["Name", vxDev], ["Kind", "vxlan"], ["Description", `VXLAN of ${name}`]]],
            ["VXLAN", [["VNI", vni], ["Local", local], ["Remote", peers.length === 1 ? remote(peers[0]!) : null], ["MacLearning", "yes"]]],
          ],
        ),
      );
      ctx.file(
        `etc/systemd/network/${vx}.network`,
        renderSections(
          [`Rendered by ${ctx.rendererName}: enslaves the VXLAN of ${name} into the zone bridge vz-${name}${peers.length > 1 ? "; one flood entry per peer (head-end replication)" : ""}`],
          [
            ["Match", [["Name", vxDev]]],
            ["Link", [["RequiredForOnline", "no"]]],
            ["Network", [["Bridge", `vz-${name}`]]],
            ...(peers.length > 1 ? peers.map((h): Section => ["BridgeFDB", [["MACAddress", "00:00:00:00:00:00"], ["Destination", remote(h)]]]) : []),
          ],
        ),
      );
      ctx.expect("networks", `${vx}.netdev`);
      ctx.expect("networks", `${vx}.network`);
    }
    if (transport === "underlay") {
      forwarding = true;
      if (uplink.base) {
        const drop = `${uplink.base}.d/25-migration-${name}.conf`;
        ctx.file(
          `etc/systemd/network/${drop}`,
          renderSections(
            [`Rendered by ${ctx.rendererName}: routes from ${ctx.host} to the bridge slices of ${name} on the other hosts, through their underlay addresses`],
            peers.map((h): Section => ["Route", [["Destination", peerSlice(h)], ["Gateway", endpoint(h)], ["Table", uplink.table]]]),
          ),
        );
        ctx.expect("networks", drop);
      } else {
        ctx.note(`${name}: routed over the underlay; either the site's routers carry ${peers.map((h) => `${peerSlice(h)} via ${endpoint(h)}`).join(", ")}, or re-run plan.ts and answer ${uplinkId(ctx.host)} so the routes are rendered as a drop-in for the uplink's .network`, "decision");
      }
    }
    const tunnelled = renderTunnel({
      ctx,
      net,
      transport,
      hosts: p.hosts,
      peers,
      bridge: `vz-${name}`,
      sliceOf: peerSlice,
      endpoint,
      endpoint6: (h: string) => ctx.value(endpoint6Id(h)),
      key: () => ctx.value(tunnelKeyId(name)),
      vni: () => ctx.value(vniId(name)),
      port: () => ctx.value(tunnelPortId(name)),
      parent: () => ctx.value(macsecParentId(name)),
      etherType: () => ctx.valueOr(bareudpEtherTypeId(name), "ipv4"),
      table: uplink.table,
    } satisfies TransportContext);
    if (tunnelled) forwarding = true;
  }
  if (forwarding) {
    ctx.file("etc/sysctl.d/80-migration-forwarding.conf", [`# Rendered by ${ctx.rendererName}: a routed transport forwards between the zone bridges and the tunnel or uplink`, "net.ipv4.ip_forward = 1", ""].join("\n"));
    ctx.install("pre", "sysctl --system >/dev/null || true");
  }
  if (rendered) ctx.install("post", "networkctl reload");

  // Published ports of machines: forwarded from the host into the zone by systemd-nspawn.
  for (const inst of ctx.instances) {
    if (inst.form !== "machine" && inst.form !== "vm") continue;
    const svc = inst.service;
    const zone = ctx.hasDecision(zoneId(svc.name)) ? ctx.valueOr(zoneId(svc.name), "") : "";
    const attached = all.some((a) => a.host === ctx.host && a.base === inst.base);
    for (const p of svc.ports) {
      const published = p.published ?? p.target;
      const port = inst.count > 1 ? published + (inst.index - 1) : published;
      const how = ctx.value(publishId(svc.name, published, p.protocol));
      if (isInherited(how)) ctx.note(`${svc.name}: ${how} was chosen for port ${port}, which a machine cannot inherit; the port is forwarded into the machine instead`, "decision");
      if (attached && inst.form === "machine") {
        ctx.unitAt(`etc/systemd/nspawn/${inst.base}.nspawn`).add("Network", "Port", `${p.protocol}:${port}:${p.target}`);
        ctx.expectPort(port, p.protocol);
      } else if (attached) {
        ctx.expectPort(port, p.protocol);
        ctx.note(`${svc.name}: virtual machine ${inst.base} answers on its lease inside zone vz-${zone}; systemd-vmspawn forwards no ports, so reach it at the lease or publish the port with socket-proxyd, multipath, or haproxy`, "decision");
      } else if (zone === ZONE_HOST) {
        ctx.expectPort(p.target, p.protocol);
        if (port !== p.target) ctx.note(`${svc.name}: machine ${inst.base} shares the host's network namespace and binds the container port ${p.target}, not ${port}`, "decision");
      } else {
        ctx.note(`${svc.name}: machine ${inst.base} has no zone bridge on ${ctx.host} (zone ${zone || "undecided"}), so port ${port} is not forwarded`, "decision");
      }
      if (how === PUBLISH_EXTERNAL) ctx.note(`${svc.name}: port ${port} is a backend of your external load balancer on ${ctx.host}`);
      if (how === PUBLISH_DNS_RR) ctx.note(`${svc.name}: port ${port} on ${ctx.host} is announced for DNS round robin by the resolved component`);
    }
    for (const n of memberNetworks(inv, svc)) {
      ctx.expect("networks", n.name);
      if (n.name !== zone) ctx.note(`${svc.name}: also a member of ${n.name} in the source, but a machine attaches to one zone (${zone || "undecided"}); it reaches ${n.name} through the host`);
    }
    if (zone === ZONE_HOST) ctx.note(`${svc.name}: zone "host" leaves machine ${inst.base} in the host's network namespace (Private=no); it binds the host's addresses like a plain service`);
  }
}

/**
 * A virtual machine joins the zone through a tap on the zone bridge.
 * systemd-vmspawn(1) creates `vt-<machine>` itself with --network-tap and
 * points at the shipped 80-vm-vt.network for the host side; the file below
 * sorts before it and enslaves the tap into the zone bridge instead, so the
 * machine takes its lease from the same DHCP server as the containers.
 */
function renderTap(ctx: RenderContext, m: Attachment, network: string, lease: Lease): void {
  const dev = linkName("vt", m.base);
  const base = `25-migration-vt-${m.base}`;
  const owner = ctx.hasDecision(tapId(m.service.name)) ? ctx.valueOr(tapId(m.service.name), TAP_VMSPAWN) : TAP_VMSPAWN;
  if (owner === TAP_NETWORKD) {
    ctx.file(
      `etc/systemd/network/${base}.netdev`,
      renderSections([`Rendered by ${ctx.rendererName}: the tap of virtual machine ${m.base} on ${ctx.host} (decision ${tapId(m.service.name)}=${TAP_NETWORKD}); systemd-networkd creates it, so it exists before the machine starts`], [
        ["NetDev", [["Name", dev], ["Kind", "tap"], ["Description", `tap of ${m.base} on zone vz-${network}`]]],
        ["Tap", [["PacketInfo", "no"], ["VNetHeader", "no"]]],
      ]),
    );
    ctx.expect("networks", `${base}.netdev`);
    ctx.note(`${m.service.name}: ${dev} is created by systemd-networkd, so systemd-vmspawn --network-tap cannot create it again; start the machine against the existing tap or answer ${tapId(m.service.name)} with ${TAP_VMSPAWN}`, "decision");
  }
  ctx.file(
    `etc/systemd/network/${base}.network`,
    renderSections([`Rendered by ${ctx.rendererName}: enslaves the tap of virtual machine ${m.base} into the zone bridge vz-${network}; sorts before the shipped 80-vm-vt.network, which would otherwise give it its own subnet`], [
      ["Match", [["Name", dev]]],
      ["Link", [["RequiredForOnline", "no"]]],
      ["Network", [["Bridge", `vz-${network}`]]],
    ]),
  );
  ctx.expect("networks", `${base}.network`);
  const drop = ctx.unitAt(`etc/systemd/system/systemd-vmspawn@${m.base}.service.d/10-migration.conf`);
  drop.add("Service", "Environment", `SYSTEMD_VMSPAWN_NETWORK_MAC=${lease.mac}`);
  ctx.note(`${m.service.name}: virtual machine ${m.base} joins zone vz-${network} through ${dev} with MAC ${lease.mac} and static lease ${lease.address}; SYSTEMD_VMSPAWN_NETWORK_MAC (docs/ENVIRONMENT.md) is what makes the guest present that MAC, and the guest still has to run a DHCP client`);
}

/**
 * A macvlan or ipvlan network: the machines sit on the parent link's segment
 * with their own interface (systemd-nspawn's MACVLAN= or IPVLAN=), and the
 * host gets a sibling interface on the same parent so it can reach them,
 * which the parent link itself cannot. No DHCP server runs here: the segment
 * is the site's, so each machine's address is derived for the guest to configure.
 */
function renderAttached(ctx: RenderContext, net: Network, parent: string, hostAddress: string, machines: Array<{ base: string; service: string; form: "machine" | "vm"; address: string }>): void {
  const kind = net.driver === "ipvlan" ? "ipvlan" : "macvlan";
  const key = kind === "ipvlan" ? "IPVLAN" : "MACVLAN";
  const mv = `25-migration-mv-${net.name}`;
  const dev = linkName("mv", net.name);
  const gateway = net.ipam.config.map((c) => c.gateway).find(Boolean) ?? null;
  ctx.file(
    `etc/systemd/network/${mv}.netdev`,
    renderSections([`Rendered by ${ctx.rendererName}: the host's ${kind} interface on ${parent}, the parent link of ${net.driver} network ${net.name}, so the host can reach the machines on the segment`], [
      ["NetDev", [["Name", dev], ["Kind", kind], ["Description", `${kind} of ${net.name} on ${parent}`]]],
      [key, [["Mode", kind === "ipvlan" ? "L2" : "bridge"]]],
    ]),
  );
  ctx.file(
    `etc/systemd/network/${mv}.network`,
    renderSections([`Rendered by ${ctx.rendererName}: the host's address on the segment of ${net.name}`], [
      ["Match", [["Name", dev]]],
      ["Link", [["RequiredForOnline", "no"]]],
      ["Network", [["Address", hostAddress], ["LinkLocalAddressing", "no"], ["IPv6AcceptRA", "no"]]],
    ]),
  );
  ctx.file(
    `etc/systemd/network/25-migration-parent-${net.name}.network`,
    renderSections([`Rendered by ${ctx.rendererName}: stacks ${dev} on the parent link ${parent} (decision ${parentId(net.name)}); a .network that already configures ${parent} takes precedence over this one only when it sorts first, so merge this line into it and delete this file if one exists`], [
      ["Match", [["Name", parent]]],
      ["Link", [["RequiredForOnline", "no"]]],
      ["Network", [[key, dev]]],
    ]),
  );
  for (const f of [`${mv}.netdev`, `${mv}.network`, `25-migration-parent-${net.name}.network`]) ctx.expect("networks", f);
  ctx.note(`${net.name}: 25-migration-parent-${net.name}.network matches ${parent} by name; if ${parent} already has a .network on ${ctx.host}, move ${key}=${dev} into it and delete the rendered file, or the first file in sort order configures the link alone`, "decision");
  for (const m of machines) {
    if (m.form === "vm") {
      ctx.note(`${m.service}: virtual machine ${m.base} is attached to ${net.driver} network ${net.name}, which systemd-vmspawn cannot express; give it a tap on a zone bridge instead, or run it as a machine`, "decision");
      continue;
    }
    ctx.unitAt(`etc/systemd/nspawn/${m.base}.nspawn`).add("Network", key, parent);
    ctx.note(`${m.service}: machine ${m.base} gets a ${kind} interface on ${parent} (${key}=${parent}); the guest must configure ${m.address} on it itself${gateway ? ` with the segment's gateway ${gateway}` : ""}, as the host runs no DHCP server on the site's segment; the machined component still writes Zone=${net.name}, which also attaches an unused zone bridge, until it omits Zone= for ${net.driver} networks`, "decision");
  }
}
