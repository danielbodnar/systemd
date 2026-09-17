# The zone bridge and its transports

A service the plan runs as a machine gets its own network namespace, and `systemd-nspawn` connects it to the host through a zone: `Zone=<network>` in the `.nspawn` file creates a veth pair whose host side joins a bridge named `vz-<network>`, created on the first machine and removed when the last one leaves and nothing else is enslaved. The networkd component owns everything on the host side of that bridge: its address, its DHCP server, the fixed address of every machine, and the transport that joins the bridges of several hosts. Every value comes from a decision in `plan.yaml`; this page explains how the values are derived and what the files look like.

## The bridge

`25-migration-vz-<network>.network` matches the bridge by kind and name and sorts before the shipped `80-container-vz.network`, so it replaces that file for the migrated networks and carries the settings that matter from it (`RequiredForOnline=no`, `LinkLocalAddressing=yes`, `IPv6AcceptRA=no`, `PersistLeases=runtime`).

```
[Match]
Kind=bridge
Name=vz-web_frontend

[Link]
RequiredForOnline=no

[Network]
Address=10.10.1.1/24
LinkLocalAddressing=yes
DHCPServer=yes
IPMasquerade=ipv4
IPv6AcceptRA=no

[DHCPServer]
PoolOffset=3
PoolSize=252
PersistLeases=runtime
LocalLeaseDomain=_dhcp

[DHCPServerStaticLease]
MACAddress=26:3b:af:b1:00:98
Address=10.10.1.2
Hostname=web_app
```

`IPMasquerade=ipv4` is written unless the source network was internal, in which case `IPMasquerade=no` keeps the machines from reaching anything beyond the bridge. `LocalLeaseDomain=` takes the value of `networkd.domain.<network>`, so the host resolves `web_app._dhcp` to the lease once it is handed out.

## The address plan

The decided range `networkd.subnet.<network>` is one address space for the whole network. When machines attached to the network land on several hosts, the range is split into the smallest power of two of equal slices that fits the hosts, and each host takes the slice at its position in the sorted list of host names. A `/24` shared by two hosts becomes two `/25` slices; three hosts take four `/26` slices and leave one unused. A network whose machines all sit on one host keeps the whole range as its only slice.

Inside a host's slice, the addresses are fixed by position:

- the slice's first usable address (the base plus one) is the host's own address on the bridge, and therefore the machines' gateway;
- the machines attached to the network on that host, sorted by name, take the base plus two, plus three, and so on;
- the DHCP pool starts right after the last static lease and ends before the slice's last address, which is left out so the last slice never hands out the broadcast address.

For an L2 transport (`vxlan`, `vxlan-wireguard`) and for a local network, the bridge address carries the full prefix of the decided range, because every host's bridge sits in the same broadcast domain, and each host's `[DHCPServer]` pool is offset into its own slice so two servers on one L2 domain never offer the same address. The static lease table is the same on every host of the network, so whichever server answers a machine first hands out the address the plan recorded. For a routed transport (`wireguard`, `underlay`) the bridge address carries the slice's prefix, because each slice is its own subnet reached through a route.

## The MAC derivation

A static lease matches the client's hardware address, and `systemd-nspawn` would otherwise generate the machine's MAC from the host's machine ID, which the renderer cannot know. The component therefore derives the MAC from the machine name alone: the first six bytes of SHA-256 over the name (`web_app`, `web_app-2`), with the first byte's locally administered bit set and its multicast bit cleared. The same name yields the same MAC on every host and every run, and the address is one systemd-nspawn accepts through the documented `SYSTEMD_NSPAWN_NETWORK_MAC` environment variable (see `docs/ENVIRONMENT.md`), which the component writes as `Environment=` into the machine's `systemd-nspawn@.service` drop-in. The guest still has to run a DHCP client on `host0`; a machine image that runs `systemd-networkd` does so through the shipped `80-container-host0.network`, and an image without one needs the address configured inside it, which the notes say per machine.

## The transports

A network whose attached machines land on more than one host needs a transport, chosen in `networkd.transport.<network>`. The files below are rendered on every host of the network; the examples show host `swarm-wrk-1` (position 1) with peer `swarm-mgr-1` (position 0), a VNI of 3, a tunnel range of `100.64.3.0/24`, and a base port of 51820 for the third network sorted by name.

### vxlan-wireguard

The WireGuard mesh comes first. `25-migration-wg-<network>.netdev` names no key material: the private key is the credential `network.wireguard.private.25-migration-wg-<network>`, which `systemd-networkd.service` imports itself, and each peer's public key is the credential `network.wireguard.public.<host>`. The operator encrypts them with `systemd-creds encrypt --name=<credential>` into `/etc/credstore.encrypted/` on every host; the plan lists them under `credentials` in `expected.json`.

```
[NetDev]
Name=wg-web_frontend
Kind=wireguard

[WireGuard]
ListenPort=51822
PrivateKey=@network.wireguard.private.25-migration-wg-web_frontend

[WireGuardPeer]
PublicKey=@network.wireguard.public.swarm-mgr-1
Endpoint=10.0.0.11:51822
AllowedIPs=100.64.3.1/32
PersistentKeepalive=25
```

`25-migration-wg-<network>.network` assigns the host's tunnel address, the base of the tunnel range plus one plus the host's position:

```
[Match]
Name=wg-web_frontend

[Network]
Address=100.64.3.2/24
```

The VXLAN then rides inside the tunnel. `25-migration-vx-<network>.netdev` sets the decided VNI with the host's tunnel address as `Local=` and, for exactly two hosts, the peer's tunnel address as `Remote=`:

```
[NetDev]
Name=vx-web_frontend
Kind=vxlan

[VXLAN]
VNI=3
Local=100.64.3.2
Remote=100.64.3.1
MacLearning=yes
```

`25-migration-vx-<network>.network` enslaves it into the zone bridge. With more than two hosts `Remote=` is omitted and the file carries one `[BridgeFDB]` entry with the all-zero MAC and `Destination=` per peer, which is head-end replication: broadcast and unknown unicast frames are copied to every peer.

```
[Match]
Name=vx-web_frontend

[Network]
Bridge=vz-web_frontend
```

Once the VXLAN is enslaved, the bridge is never removed by `systemd-nspawn`, because it only removes an empty bridge.

### vxlan

The same two VXLAN files without the tunnel: `Local=` and `Remote=` (or the flood entries) are the hosts' endpoint decisions, so the frames travel unencrypted over the site's network.

### wireguard

The WireGuard files without the VXLAN. Each host's slice is its own subnet: the peer entry allows the peer's slice as well as its tunnel address, the tunnel's `.network` routes the peer's slice through the peer's tunnel address and enables forwarding on the interface, and the bridge carries its slice's prefix and `IPv4Forwarding=yes`.

```
[WireGuardPeer]
PublicKey=@network.wireguard.public.swarm-mgr-1
Endpoint=10.0.0.11:51822
AllowedIPs=100.64.3.1/32
AllowedIPs=10.10.1.0/25
PersistentKeepalive=25
```

```
[Match]
Name=wg-web_frontend

[Network]
Address=100.64.3.2/24
IPv4Forwarding=yes

[Route]
Destination=10.10.1.0/25
Gateway=100.64.3.1
```

### underlay

No tunnel and no VXLAN. Each host's slice is routed by the site's network, so either the site's routers know the slices, or the host carries a static route per peer slice through the peer's endpoint. Such a route has to live on the uplink, whose `.network` file the renderer cannot guess, so choosing `underlay` raises `networkd.uplink.<host>` on the next plan run; once answered, `<uplink>.d/25-migration-<network>.conf` is rendered as a drop-in:

```
[Route]
Destination=10.10.1.0/25
Gateway=10.0.0.11
```

Until the uplink is answered the routes are listed in the notes as a decision, not guessed.

### Forwarding

The routed transports need the host to forward between the bridge and the tunnel or the uplink, so `/etc/sysctl.d/80-migration-forwarding.conf` sets `net.ipv4.ip_forward = 1` on those hosts only. An L2 transport needs no forwarding beyond the masquerading `systemd-networkd` configures per interface.

## macvlan and ipvlan

A macvlan or ipvlan network is not a zone: its members sit directly on the segment of a host link, so the machine gets `MACVLAN=<parent>` or `IPVLAN=<parent>` in its `.nspawn` file from `networkd.parent.<network>`, and the host gets a sibling interface on the same parent (`25-migration-mv-<network>.netdev` with `Mode=bridge` or `Mode=L2`, its `.network` with the host's address from the decided range, and `25-migration-parent-<network>.network` stacking it on the parent), because a parent link cannot reach the interfaces stacked on it. The host runs no DHCP server on the site's segment. The address each machine should use is derived like a lease from the decided range, which defaults to the source's `ip_range`, and is listed in the notes and in the hosts fragment for the guest to configure. The parent file matches the link by name, so if the parent already has a `.network` the stacking line belongs in that file instead; the notes say so.
