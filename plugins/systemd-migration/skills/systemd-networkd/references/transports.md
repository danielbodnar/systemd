# Every transport a network can take

`networkd.transport.<network>` is raised for every overlay whose members land on more than one host. Its options are the tunnel kinds `systemd.netdev(5)` documents that can carry a network between hosts, plus `underlay`, which creates nothing. This page says what each one renders, what it asks to have decided, and what it still needs from the operator. `references/zone-bridge.md` covers the bridge the transports attach to and the three kinds the component started with (`vxlan`, `vxlan-wireguard`, `wireguard`, and `underlay`) in more detail.

## The two shapes

A transport works at layer 2 or at layer 3, and that choice decides the shape of everything around it.

**Layer 2** (`vxlan`, `vxlan-wireguard`, `geneve`, `gretap`, `ip6gretap`, `erspan`, `l2tp`, `macsec`). The tunnel interface is enslaved into the zone bridge with `Bridge=vz-<network>`, so every host's bridge is one broadcast domain. The bridge address carries the full prefix of the decided range, each host's `[DHCPServer]` pool is offset into its own slice, and the static lease table is identical on every host, so whichever server answers first hands out the address the plan recorded. No IP forwarding is needed.

**Layer 3** (`gre`, `ip6gre`, `ipip`, `sit`, `ip6tnl`, `vti`, `vti6`, `xfrm`, `bareudp`, `fou`, `wireguard`, `underlay`). Each host's slice is its own subnet: the bridge address carries the slice's prefix and `IPv4Forwarding=yes`, the tunnel's `.network` carries one `[Route]` per peer slice, and `/etc/sysctl.d/80-migration-forwarding.conf` sets `net.ipv4.ip_forward`. Aliases resolve per host, because there is no shared L2.

A kind whose `Remote=` names a single peer gets one device per peer, named `<prefix>-<network>-<peer>`; the kinds that carry every peer on one device (`vxlan`, `macsec`, `xfrm`, `bareudp`, `wireguard`) get one, named `<prefix>-<network>`. An interface name longer than fifteen characters keeps its first ten characters and takes a four-character digest of the whole name, because that is the kernel's limit.

## The table

| Option | Layer | Kind | Devices | Endpoints | Also decided | Still needed by hand |
|---|---|---|---|---|---|---|
| `vxlan-wireguard` | 2 | `wireguard` + `vxlan` | one of each | IPv4 | VNI, tunnel range, port | the WireGuard keys as credentials |
| `vxlan` | 2 | `vxlan` | one | IPv4 | VNI | nothing |
| `geneve` | 2 | `geneve` | one per peer | IPv4 | VNI, UDP port | nothing |
| `gretap` | 2 | `gretap` | one per peer | IPv4 | key | the site must pass IP protocol 47 |
| `ip6gretap` | 2 | `ip6gretap` | one per peer | IPv6 | key, IPv6 endpoints | an IPv6 underlay |
| `erspan` | 2 | `erspan` | one per peer | IPv4 | key | ERSPAN carries mirrored frames one way; a zone whose machines answer needs `gretap` |
| `l2tp` | 2 | `l2tp` | one per peer | IPv4 | key, UDP port | the UDP port open between the hosts |
| `macsec` | 2 | `macsec` | one | the segment | key (the MACsec port), parent link | a receive channel and association per peer, or a MKA daemon |
| `gre` | 3 | `gre` | one per peer | IPv4 | key | nothing |
| `ip6gre` | 3 | `ip6gre` | one per peer | IPv6 | key, IPv6 endpoints | an IPv6 underlay |
| `ipip` | 3 | `ipip` | one per peer | IPv4 | nothing | nothing |
| `sit` | 3 | `sit` | one per peer | IPv4 | nothing | SIT carries IPv6 in IPv4; the rendered IPv4 slices do not travel over it |
| `ip6tnl` | 3 | `ip6tnl` | one per peer | IPv6 | IPv6 endpoints | an IPv6 underlay |
| `vti` | 3 | `vti` | one per peer | IPv4 | key (the IPsec mark) | the IPsec policies and SAs, from an IKE daemon |
| `vti6` | 3 | `vti6` | one per peer | IPv6 | key, IPv6 endpoints | the IPsec policies and SAs, and an IPv6 underlay |
| `xfrm` | 3 | `xfrm` | one | none | key (the interface id) | the IPsec policies and SAs bound to that interface id |
| `bareudp` | 3 | `bareudp` | one | none | UDP port, EtherType | a lightweight tunnel encapsulation attribute per route, which `.network` files do not express |
| `fou` | 3 | `fou` + `ipip` | a receive port and one tunnel per peer | IPv4 | UDP port | nothing |
| `wireguard` | 3 | `wireguard` | one | IPv4 | tunnel range, port | the WireGuard keys as credentials |
| `underlay` | 3 | none | none | IPv4 | the uplink file | the site's routers, or the rendered route drop-in |

Every option but `underlay` carries `requires: { daemons: ["networkd"], systemd: N }`, where `N` is the newest version the directive catalogue gives any directive the kind renders. `erspan` needs 252 because `ERSPANVersion=` does; `l2tp` needs 245 because `UDPDestinationPort=` does; `vxlan` needs 243 because `VNI=` was `Id=` before it. The option is still offered on an older host, with the shortfall spelled out in its consequence.

## What the files look like

An L2 kind with one device per peer, here `geneve` on `swarm-wrk-1` with the peer `swarm-mgr-1`:

```
[NetDev]
Name=gn-web_fro-2b41
Kind=geneve
Description=GENEVE of web_frontend to swarm-mgr-1

[GENEVE]
Id=3
Remote=10.0.0.11
DestinationPort=6083
```

```
[Match]
Name=gn-web_fro-2b41

[Link]
RequiredForOnline=no

[Network]
Bridge=vz-web_frontend
```

An L3 kind, here `gre`, differs only in the `.network`: instead of enslaving the device it routes the peer's slice over it, on-link, with no gateway.

```
[Network]
IPv4Forwarding=yes

[Route]
Destination=10.10.1.0/25
```

`l2tp` renders the tunnel and its session in one `.netdev`, and the `.network` matches the session interface, which is the L2 device:

```
[L2TP]
TunnelId=3
PeerTunnelId=2
Local=10.0.0.12
Remote=10.0.0.11
EncapsulationType=udp
UDPSourcePort=1703
UDPDestinationPort=1703

[L2TPSession]
Name=ls-web_fro-9c7e
SessionId=7
PeerSessionId=6
```

The tunnel and session ids are derived from the decided base and the two hosts' positions, so each side's `TunnelId=` is the other side's `PeerTunnelId=` without anything being exchanged.

`fou` renders a receive port beside the tunnels, exactly as the Foo-over-UDP example in `systemd.netdev(5)` does:

```
[NetDev]
Name=fou-web_fr-51a0
Kind=fou

[FooOverUDP]
Encapsulation=FooOverUDP
Port=5557
Protocol=ipip
```

and each peer's `ipip` device carries `Independent=yes`, `FooOverUDP=yes`, and `FOUDestinationPort=` with the same port.

`macsec` never writes a key. `[MACsecTransmitAssociation]` takes `KeyFile=`, and the file it names is the credential `network.macsec.key.<network>` as `systemd-networkd.service` exposes it, so a drop-in for that unit carries `LoadCredentialEncrypted=` and the operator runs `systemd-creds encrypt --name=network.macsec.key.<network>` into `/etc/credstore.encrypted/` on every host of the network:

```
[MACsec]
Port=3
Encrypt=yes

[MACsecTransmitAssociation]
PacketNumber=1
KeyId=01
KeyFile=/run/credentials/systemd-networkd.service/network.macsec.key.web_frontend
UseForEncoding=yes
```

A second file stacks the MACsec interface on the decided parent link, the same way the macvlan parent file does, and says in its header to merge the line into the link's own `.network` when there is one.

## The uplink the plan owns

Choosing `underlay` raises `networkd.uplink.<host>`, the `.network` file that configures the link the peers are reached through, and `networkd.uplink.owner.<host>`. The owner defaults to `site`: nothing about the link is touched, and the routes to the peers' slices are rendered as `<uplink>.d/25-migration-<network>.conf`, exactly as before.

Answering `harness` says the plan may reshape the link, and raises three more questions on the next pass: a bond mode, a VLAN tag, and a VRF. They stack in that order, each rendered as a `.netdev` plus a `.network` for the layer above it, with a drop-in on the site's uplink file that attaches the first of them:

```
# 10-eth0.network.d/25-migration-uplink.conf
[Network]
Bond=bond-mig
```

```
# 25-migration-bond.netdev
[NetDev]
Name=bond-mig
Kind=bond

[Bond]
Mode=802.3ad
```

```
# 25-migration-bond.network
[Match]
Name=bond-mig

[Link]
RequiredForOnline=yes

[Network]
VLAN=vl-100
```

```
# 25-migration-uplink.network
[Match]
Name=vl-100

[Link]
RequiredForOnline=yes

[Network]
VRF=vrf-mig
IPv4Forwarding=yes
```

The peer routes then drop into the topmost interface's file (`25-migration-uplink.network.d/`) instead of the site's, and carry `Table=` of the VRF when there is one. Two things the renderer cannot do are said as decisions rather than guessed: an enslaved link cannot hold addresses, so the uplink's `Address=`, `Gateway=`, and `DHCP=` lines have to move into the bond's file, and a route inside a VRF is reached only by a process running in that VRF.

## Traffic control

`[QDisc]` and the shapers are out of scope. The source orchestrator has no equivalent, so there is nothing to translate and nothing to decide.
