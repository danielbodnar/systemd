// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Every tunnel kind systemd.netdev(5) documents that can carry a network
// between hosts (PLAN.md 10.5). One table describes them: the layer each one
// works at, whether one device per peer is needed, whether its endpoints are
// IPv4 or IPv6, the identifiers and ports it asks for, and the directives it
// renders. The version requirement of each option comes from the directive
// catalogue, so an option is never offered to a host that predates the
// directives it needs.
//
// An L2 transport is enslaved into the zone bridge, so every host's machines
// share one broadcast domain and the bridges hand out addresses from one
// range. An L3 transport routes each host's slice of the range to its peers.
// Nothing here invents an address, a key, or an identifier: all of them come
// from decisions the component raises in component.ts.

import { directive, loadCatalog } from "../../../contract/catalog.ts";
import type { RenderContext } from "../../../contract/component.ts";
import type { Requirements } from "../../../contract/plan.ts";
import type { Network } from "../../../contract/types.ts";
import { type Section, type SectionEntries, linkName, renderSections } from "./shared.ts";

export type Layer = "l2" | "l3";

export interface TransportSpec {
  value: string;
  label: string;
  consequence: string;
  layer: Layer;
  /** The netdev Kind= that carries the traffic; null when nothing is created (the underlay). */
  kind: string | null;
  /** The interface name prefix; the network name follows, shortened when the pair exceeds IFNAMSIZ. */
  prefix: string;
  /** One device per peer, because the kind carries a single Remote=. */
  perPeer: boolean;
  /** The endpoints are IPv6 addresses, so the IPv6 endpoint decision is needed instead of the IPv4 one. */
  ipv6: boolean;
  /** The extra decisions the kind needs beside the endpoints. */
  needs: Array<"key" | "vni" | "port" | "parent" | "ethertype" | "wireguard">;
  /** The directives the rendered files use, for the catalogue's version requirement. */
  directives: Array<[string, string]>;
  /** What the operator has to do beyond the rendered files for the transport to carry traffic. */
  caveat?: string;
}

/** Every transport option, in the order the decision offers them. */
export const TRANSPORTS: TransportSpec[] = [
  {
    value: "vxlan-wireguard",
    label: "VXLAN over a WireGuard mesh",
    consequence: "a wg netdev per host with keys as credentials, the VXLAN rides inside it; encrypted like the source",
    layer: "l2",
    kind: "vxlan",
    prefix: "vx",
    perPeer: false,
    ipv6: false,
    needs: ["vni", "wireguard"],
    directives: [["VXLAN", "VNI="], ["VXLAN", "Local="], ["VXLAN", "Remote="], ["WireGuard", "PrivateKey="], ["WireGuardPeer", "PublicKey="], ["WireGuardPeer", "Endpoint="]],
  },
  {
    value: "vxlan",
    label: "VXLAN over the underlay",
    consequence: "plain VXLAN between the hosts' addresses; unencrypted",
    layer: "l2",
    kind: "vxlan",
    prefix: "vx",
    perPeer: false,
    ipv6: false,
    needs: ["vni"],
    directives: [["VXLAN", "VNI="], ["VXLAN", "Local="], ["VXLAN", "Remote="]],
  },
  {
    value: "geneve",
    label: "GENEVE over the underlay",
    consequence: "one geneve device per peer, each enslaved into the zone bridge; the same L2 domain as VXLAN with a header that carries options; unencrypted",
    layer: "l2",
    kind: "geneve",
    prefix: "gn",
    perPeer: true,
    ipv6: false,
    needs: ["vni", "port"],
    directives: [["GENEVE", "Id="], ["GENEVE", "Remote="], ["GENEVE", "DestinationPort="]],
  },
  {
    value: "gretap",
    label: "GRE tap (L2 GRE over IPv4)",
    consequence: "one gretap device per peer enslaved into the zone bridge; frames are carried in GRE with the decided key, unencrypted, and the site's network must pass IP protocol 47",
    layer: "l2",
    kind: "gretap",
    prefix: "gt",
    perPeer: true,
    ipv6: false,
    needs: ["key"],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Key="]],
  },
  {
    value: "ip6gretap",
    label: "GRE tap over IPv6",
    consequence: "the same L2 GRE with IPv6 endpoints; every host needs an IPv6 address the others reach it at",
    layer: "l2",
    kind: "ip6gretap",
    prefix: "g6t",
    perPeer: true,
    ipv6: true,
    needs: ["key"],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Key="]],
  },
  {
    value: "erspan",
    label: "ERSPAN (mirrored frames in GRE)",
    consequence: "one erspan device per peer enslaved into the zone bridge; ERSPAN encapsulates mirrored traffic, so it suits a monitoring zone and not a zone whose machines answer",
    layer: "l2",
    kind: "erspan",
    prefix: "er",
    perPeer: true,
    ipv6: false,
    needs: ["key"],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Key="], ["Tunnel", "ERSPANVersion="], ["Tunnel", "ERSPANIndex="]],
    caveat: "ERSPAN carries mirrored frames in one direction; a zone whose machines have to answer needs gretap or VXLAN instead",
  },
  {
    value: "l2tp",
    label: "L2TPv3 pseudowire",
    consequence: "one l2tp tunnel per peer with a session interface enslaved into the zone bridge; L2 over UDP, unencrypted, and the decided UDP port must be open between the hosts",
    layer: "l2",
    kind: "l2tp",
    prefix: "l2",
    perPeer: true,
    ipv6: false,
    needs: ["key", "port"],
    directives: [["L2TP", "TunnelId="], ["L2TP", "PeerTunnelId="], ["L2TP", "Local="], ["L2TP", "Remote="], ["L2TP", "EncapsulationType="], ["L2TP", "UDPSourcePort="], ["L2TP", "UDPDestinationPort="], ["L2TPSession", "SessionId="], ["L2TPSession", "PeerSessionId="], ["L2TPSession", "Name="]],
  },
  {
    value: "macsec",
    label: "MACsec on a shared segment",
    consequence: "the hosts already share one L2 segment; a macsec device on the decided parent link encrypts it and is enslaved into the zone bridge, with the key as a credential",
    layer: "l2",
    kind: "macsec",
    prefix: "ms",
    perPeer: false,
    ipv6: false,
    needs: ["key", "parent"],
    directives: [["MACsec", "Port="], ["MACsec", "Encrypt="], ["MACsecTransmitAssociation", "KeyId="], ["MACsecTransmitAssociation", "KeyFile="], ["MACsecTransmitAssociation", "PacketNumber="], ["MACsecTransmitAssociation", "UseForEncoding="]],
    caveat: "a receive channel and association per peer, each naming that peer's MAC address on the segment, is what the inventory cannot supply; add a [MACsecReceiveChannel] and [MACsecReceiveAssociation] per peer, or run a MKA daemon that negotiates them",
  },
  {
    value: "gre",
    label: "GRE (L3 GRE over IPv4)",
    consequence: "one gre device per peer, each host's slice routed over it; no L2 between hosts, so aliases resolve per host; unencrypted",
    layer: "l3",
    kind: "gre",
    prefix: "gr",
    perPeer: true,
    ipv6: false,
    needs: ["key"],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Key="]],
  },
  {
    value: "ip6gre",
    label: "GRE over IPv6",
    consequence: "the same routed GRE with IPv6 endpoints; every host needs an IPv6 address the others reach it at",
    layer: "l3",
    kind: "ip6gre",
    prefix: "g6",
    perPeer: true,
    ipv6: true,
    needs: ["key"],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Key="]],
  },
  {
    value: "ipip",
    label: "IPIP (IPv4 in IPv4)",
    consequence: "one ipip device per peer, each host's slice routed over it; the smallest header of the routed kinds and unencrypted",
    layer: "l3",
    kind: "ipip",
    prefix: "ii",
    perPeer: true,
    ipv6: false,
    needs: [],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="]],
  },
  {
    value: "sit",
    label: "SIT (IPv6 in IPv4)",
    consequence: "one sit device per peer; SIT carries IPv6 only, so it serves an estate whose ranges are IPv6 and not the IPv4 slices this plan derives",
    layer: "l3",
    kind: "sit",
    prefix: "si",
    perPeer: true,
    ipv6: false,
    needs: [],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="]],
    caveat: "SIT encapsulates IPv6 in IPv4; the rendered slices are IPv4, so the routes over it are listed for review and an IPv4 estate should choose ipip or gre",
  },
  {
    value: "ip6tnl",
    label: "IP6TNL (IPv4 or IPv6 in IPv6)",
    consequence: "one ip6tnl device per peer with Mode=any, each host's slice routed over it; every host needs an IPv6 address the others reach it at",
    layer: "l3",
    kind: "ip6tnl",
    prefix: "i6",
    perPeer: true,
    ipv6: true,
    needs: [],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Mode="]],
  },
  {
    value: "vti",
    label: "VTI (IPsec, IPv4)",
    consequence: "one vti device per peer carrying the decided key as the IPsec mark; the security associations themselves are not systemd's to configure",
    layer: "l3",
    kind: "vti",
    prefix: "vti",
    perPeer: true,
    ipv6: false,
    needs: ["key"],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Key="]],
    caveat: "the IPsec policies and security associations that give a vti device its encryption are configured by an IKE daemon, not by .netdev files; without them the device passes plain packets",
  },
  {
    value: "vti6",
    label: "VTI over IPv6 (IPsec)",
    consequence: "the same IPsec-marked tunnel with IPv6 endpoints; every host needs an IPv6 address the others reach it at",
    layer: "l3",
    kind: "vti6",
    prefix: "vt6",
    perPeer: true,
    ipv6: true,
    needs: ["key"],
    directives: [["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "Key="]],
    caveat: "the IPsec policies and security associations that give a vti6 device its encryption are configured by an IKE daemon, not by .netdev files; without them the device passes plain packets",
  },
  {
    value: "xfrm",
    label: "XFRM interface (IPsec)",
    consequence: "one xfrm device carrying the decided interface id, with every peer's slice routed over it; one device for all peers, and the security associations are configured out of band",
    layer: "l3",
    kind: "xfrm",
    prefix: "xf",
    perPeer: false,
    ipv6: false,
    needs: ["key"],
    directives: [["Xfrm", "InterfaceId="], ["Xfrm", "Independent="]],
    caveat: "an xfrm interface only carries traffic once an IKE daemon installs policies and security associations bound to its interface id; the .netdev creates the interface and nothing else",
  },
  {
    value: "bareudp",
    label: "Bare UDP tunnel",
    consequence: "one bareudp device carrying the decided L3 protocol in UDP on the decided port; a generic L3 encapsulation with the smallest possible configuration",
    layer: "l3",
    kind: "bareudp",
    prefix: "bu",
    perPeer: false,
    ipv6: false,
    needs: ["port", "ethertype"],
    directives: [["BareUDP", "DestinationPort="], ["BareUDP", "EtherType="]],
    caveat: "a bare UDP device learns a peer's address from a route with lightweight tunnel encapsulation, which .network files do not express; the rendered routes reach the peers only once those encapsulation attributes are added",
  },
  {
    value: "fou",
    label: "IPIP inside Foo-over-UDP",
    consequence: "a fou receive port on the decided UDP port and one ipip device per peer encapsulated in it, each host's slice routed over them; UDP traverses middleboxes that drop protocol 4",
    layer: "l3",
    kind: "ipip",
    prefix: "fo",
    perPeer: true,
    ipv6: false,
    needs: ["port"],
    directives: [["FooOverUDP", "Encapsulation="], ["FooOverUDP", "Port="], ["FooOverUDP", "Protocol="], ["Tunnel", "Local="], ["Tunnel", "Remote="], ["Tunnel", "FooOverUDP="], ["Tunnel", "FOUDestinationPort="], ["Tunnel", "Independent="]],
  },
  {
    value: "wireguard",
    label: "WireGuard only, routed",
    consequence: "each host's zone bridge subnet is routed over WireGuard; no L2 between hosts, aliases resolve per host",
    layer: "l3",
    kind: "wireguard",
    prefix: "wg",
    perPeer: false,
    ipv6: false,
    needs: ["wireguard"],
    directives: [["WireGuard", "PrivateKey="], ["WireGuard", "ListenPort="], ["WireGuardPeer", "PublicKey="], ["WireGuardPeer", "AllowedIPs="], ["WireGuardPeer", "Endpoint="]],
  },
  {
    value: "underlay",
    label: "route over the existing network",
    consequence: "no overlay; each host's bridge subnet must be reachable through the site's routers",
    layer: "l3",
    kind: null,
    prefix: "",
    perPeer: false,
    ipv6: false,
    needs: [],
    directives: [],
  },
];

export function transportSpec(value: string): TransportSpec | undefined {
  return TRANSPORTS.find((t) => t.value === value);
}

/** The oldest systemd that documents every directive a transport renders, from the catalogue. */
export function transportRequires(spec: TransportSpec): Requirements {
  const catalog = loadCatalog();
  let since = 0;
  for (const [section, name] of spec.directives) {
    const info = directive("netdev", section, name, catalog);
    if (info?.since) since = Math.max(since, info.since);
  }
  const req: Requirements = { daemons: ["networkd"] };
  if (since) req.systemd = since;
  return req;
}

/** Everything a transport needs from the host being rendered; component.ts fills it in from the plan. */
export interface TransportContext {
  ctx: RenderContext;
  net: Network;
  transport: string;
  /** The hosts the network's machines land on, sorted; this host is one of them. */
  hosts: string[];
  peers: string[];
  /** The zone bridge this host enslaves an L2 transport into. */
  bridge: string;
  /** A host's slice of the decided range, as address/prefix. */
  sliceOf: (host: string) => string;
  /** The IPv4 endpoint decision of a host. */
  endpoint: (host: string) => string;
  /** The IPv6 endpoint decision of a host, for the kinds whose endpoints are IPv6. */
  endpoint6: (host: string) => string;
  /** The identifier decision (GRE key, L2TP tunnel id, xfrm interface id, MACsec port). */
  key: () => string;
  /** The VXLAN or GENEVE network identifier. */
  vni: () => string;
  /** The UDP port an encapsulating kind listens on. */
  port: () => string;
  /** The host link a MACsec transport protects. */
  parent: () => string;
  /** The L3 protocol a bare UDP tunnel carries. */
  etherType: () => string;
  /** The routing table the peer routes belong to, when the harness put the uplink in a VRF. */
  table: string | null;
}

function netdevFile(t: TransportContext, name: string, header: string, sections: Section[]): void {
  t.ctx.file(`etc/systemd/network/${name}.netdev`, renderSections([header], sections));
  t.ctx.expect("networks", `${name}.netdev`);
}

function networkFile(t: TransportContext, name: string, header: string, sections: Section[]): void {
  t.ctx.file(`etc/systemd/network/${name}.network`, renderSections([header], sections));
  t.ctx.expect("networks", `${name}.network`);
}

/** The base of every file this transport renders for the network. */
function fileBase(spec: TransportSpec, net: string, peer?: string): string {
  return `25-migration-${spec.prefix}-${net}${peer ? `-${peer}` : ""}`;
}

/**
 * The tunnel and session identifiers of an L2TP pair. Each side's TunnelId is
 * the other side's PeerTunnelId, so both ends are derived from the same
 * decided base and the two hosts' positions without any exchange.
 */
export function l2tpIds(base: number, hosts: string[], from: string, to: string): { tunnel: number; peerTunnel: number; session: number; peerSession: number } {
  const n = hosts.length;
  const pair = (a: string, b: string) => base + hosts.indexOf(a) * n + hosts.indexOf(b) + 1;
  return { tunnel: pair(from, to), peerTunnel: pair(to, from), session: pair(from, to) + n * n, peerSession: pair(to, from) + n * n };
}

/** The credential the MACsec transmit association reads its key from; systemd-networkd.service loads it. */
export function macsecCredential(net: string): string {
  return `network.macsec.key.${net}`;
}
export const CREDENTIALS_DIRECTORY = "/run/credentials/systemd-networkd.service";

/**
 * Render the transport of one network on one host. Returns whether the host
 * has to forward between the zone bridge and the transport, which the caller
 * turns into the sysctl drop-in. The WireGuard mesh and the underlay routes
 * are rendered by component.ts, which owns the credentials and the uplink.
 */
export function renderTunnel(t: TransportContext): boolean {
  const spec = transportSpec(t.transport);
  if (!spec || !spec.kind || spec.value === "wireguard" || spec.value === "vxlan-wireguard" || spec.value === "vxlan") return false;
  const { ctx, net } = t;
  const name = net.name;
  const local = spec.ipv6 ? t.endpoint6(ctx.host) : t.endpoint(ctx.host);
  const remoteOf = (h: string) => (spec.ipv6 ? t.endpoint6(h) : t.endpoint(h));
  const routes = (destinations: string[]): Section[] => destinations.map((d): Section => ["Route", [["Destination", d], ["Table", t.table]]]);
  const bridged: Section[] = [["Network", [["Bridge", t.bridge]]]];
  const match = (dev: string): Section => ["Match", [["Name", dev]]];
  const link: Section = ["Link", [["RequiredForOnline", "no"]]];

  if (spec.caveat) ctx.note(`${name}: ${spec.caveat}`, "decision");

  switch (spec.value) {
    case "geneve":
    case "gretap":
    case "ip6gretap":
    case "erspan":
    case "gre":
    case "ip6gre":
    case "ipip":
    case "sit":
    case "ip6tnl":
    case "vti":
    case "vti6":
    case "fou": {
      if (spec.value === "fou") {
        const fou = linkName("fou", name);
        netdevFile(t, `25-migration-fou-${name}`, `Rendered by ${ctx.rendererName}: the Foo-over-UDP receive port of network ${name} on ${ctx.host}; the ipip tunnels below are encapsulated in it`, [
          ["NetDev", [["Name", fou], ["Kind", "fou"], ["Description", `Foo-over-UDP receive port of ${name}`]]],
          ["FooOverUDP", [["Encapsulation", "FooOverUDP"], ["Port", t.port()], ["Protocol", "ipip"]]],
        ]);
      }
      for (const peer of t.peers) {
        const dev = linkName(spec.prefix, name, peer);
        const base = fileBase(spec, name, peer);
        const body: SectionEntries = [["Local", local], ["Remote", remoteOf(peer)]];
        if (spec.needs.includes("key")) body.push(["Key", t.key()]);
        if (spec.value === "ip6tnl") body.push(["Mode", "any"]);
        if (spec.value === "erspan") body.push(["ERSPANVersion", 1], ["ERSPANIndex", t.key()]);
        if (spec.value === "fou") body.push(["Independent", "yes"], ["FooOverUDP", "yes"], ["FOUDestinationPort", t.port()]);
        const sections: Section[] =
          spec.value === "geneve"
            ? [["NetDev", [["Name", dev], ["Kind", spec.kind], ["Description", `GENEVE of ${name} to ${peer}`]]], ["GENEVE", [["Id", t.vni()], ["Remote", remoteOf(peer)], ["DestinationPort", t.port()]]]]
            : [["NetDev", [["Name", dev], ["Kind", spec.kind], ["Description", `${spec.kind} of ${name} to ${peer}`]]], ["Tunnel", body]];
        netdevFile(t, base, `Rendered by ${ctx.rendererName}: ${spec.label} of network ${name} from ${ctx.host} to ${peer}`, sections);
        networkFile(
          t,
          base,
          spec.layer === "l2"
            ? `Rendered by ${ctx.rendererName}: enslaves the ${spec.kind} to ${peer} into the zone bridge ${t.bridge}`
            : `Rendered by ${ctx.rendererName}: routes the slice of ${name} on ${peer} over the ${spec.kind} to ${peer}`,
          spec.layer === "l2"
            ? [match(dev), link, ...bridged]
            : [match(dev), link, ["Network", [["IPv4Forwarding", "yes"]]], ...routes([t.sliceOf(peer)])],
        );
      }
      return spec.layer === "l3";
    }
    case "l2tp": {
      const base = Number(t.key());
      for (const peer of t.peers) {
        const ids = l2tpIds(base, t.hosts, ctx.host, peer);
        const dev = linkName(spec.prefix, name, peer);
        const session = linkName("ls", name, peer);
        const file = fileBase(spec, name, peer);
        netdevFile(t, file, `Rendered by ${ctx.rendererName}: L2TPv3 tunnel of network ${name} from ${ctx.host} to ${peer}; the session interface ${session} is what the zone bridge enslaves`, [
          ["NetDev", [["Name", dev], ["Kind", spec.kind], ["Description", `L2TP tunnel of ${name} to ${peer}`]]],
          ["L2TP", [["TunnelId", ids.tunnel], ["PeerTunnelId", ids.peerTunnel], ["Local", local], ["Remote", remoteOf(peer)], ["EncapsulationType", "udp"], ["UDPSourcePort", t.port()], ["UDPDestinationPort", t.port()]]],
          ["L2TPSession", [["Name", session], ["SessionId", ids.session], ["PeerSessionId", ids.peerSession]]],
        ]);
        networkFile(t, file, `Rendered by ${ctx.rendererName}: enslaves the L2TP session to ${peer} into the zone bridge ${t.bridge}`, [match(session), link, ...bridged]);
      }
      return false;
    }
    case "macsec": {
      const dev = linkName(spec.prefix, name);
      const parent = t.parent();
      const base = fileBase(spec, name);
      const credential = macsecCredential(name);
      netdevFile(t, base, `Rendered by ${ctx.rendererName}: MACsec on ${parent}, the segment network ${name} shares between ${t.hosts.join(", ")}; the key is the credential ${credential}, never a value in this file`, [
        ["NetDev", [["Name", dev], ["Kind", spec.kind], ["Description", `MACsec of ${name} on ${parent}`]]],
        ["MACsec", [["Port", t.key()], ["Encrypt", "yes"]]],
        ["MACsecTransmitAssociation", [["PacketNumber", 1], ["KeyId", "01"], ["KeyFile", `${CREDENTIALS_DIRECTORY}/${credential}`], ["UseForEncoding", "yes"]]],
      ]);
      networkFile(t, base, `Rendered by ${ctx.rendererName}: enslaves the MACsec interface of ${name} into the zone bridge ${t.bridge}`, [match(dev), link, ...bridged]);
      networkFile(t, `25-migration-macsec-parent-${name}`, `Rendered by ${ctx.rendererName}: stacks ${dev} on the parent link ${parent} (decision networkd.macsec.parent.${name}); merge this line into the file that already configures ${parent} and delete this one when there is such a file`, [
        match(parent),
        link,
        ["Network", [["MACsec", dev]]],
      ]);
      const drop = ctx.unitAt("etc/systemd/system/systemd-networkd.service.d/25-migration-macsec.conf", [`Rendered by ${ctx.rendererName}: the MACsec keys of the migrated networks, read from the credential store`]);
      drop.add("Service", "LoadCredentialEncrypted", credential);
      ctx.expect("credentials", credential);
      ctx.note(`${name}: supply ${credential} (a 128-bit key as a hexadecimal string, the same on every host of ${name}) with systemd-creds encrypt --name=${credential} into /etc/credstore.encrypted/; the .netdev reads it through ${CREDENTIALS_DIRECTORY}`, "decision");
      return false;
    }
    case "xfrm": {
      const dev = linkName(spec.prefix, name);
      const base = fileBase(spec, name);
      netdevFile(t, base, `Rendered by ${ctx.rendererName}: xfrm interface of network ${name} on ${ctx.host}, interface id ${t.key()}`, [
        ["NetDev", [["Name", dev], ["Kind", spec.kind], ["Description", `xfrm interface of ${name}`]]],
        ["Xfrm", [["InterfaceId", t.key()], ["Independent", "yes"]]],
      ]);
      networkFile(t, base, `Rendered by ${ctx.rendererName}: routes every peer's slice of ${name} over the xfrm interface`, [match(dev), link, ["Network", [["IPv4Forwarding", "yes"]]], ...routes(t.peers.map(t.sliceOf))]);
      return true;
    }
    case "bareudp": {
      const dev = linkName(spec.prefix, name);
      const base = fileBase(spec, name);
      netdevFile(t, base, `Rendered by ${ctx.rendererName}: bare UDP tunnel of network ${name} on ${ctx.host}, carrying ${t.etherType()} on UDP port ${t.port()}`, [
        ["NetDev", [["Name", dev], ["Kind", spec.kind], ["Description", `bare UDP tunnel of ${name}`]]],
        ["BareUDP", [["DestinationPort", t.port()], ["EtherType", t.etherType()]]],
      ]);
      networkFile(t, base, `Rendered by ${ctx.rendererName}: routes every peer's slice of ${name} over the bare UDP tunnel`, [match(dev), link, ["Network", [["IPv4Forwarding", "yes"]]], ...routes(t.peers.map(t.sliceOf))]);
      return true;
    }
    default:
      return false;
  }
}
