# Networking after Swarm

Swarm provided three network services that disappear with it: overlay networks that span hosts, the ingress routing mesh that accepts a published port on every node, and virtual IPs with embedded DNS for service discovery. Everything that crossed a host boundary needs a replacement, and the choice depends on how much of the estate ends up on one host. The `systemd-networkd` component raises each replacement as a decision in `plan.yaml`; this page is the planner's view of what those decisions mean, so the review conversation can be had before the plan is rendered.

## Decide the shape first

Read `networks[].used_by` and `services[].tasks[].node` in the inventory. If every member of a network is placed on one host after migration, the network is local and needs nothing beyond the rendered zone bridge. Only networks whose members land on different hosts raise `networkd.transport.<network>`. Collapsing a stack onto one host is a legitimate answer and is usually the cheapest one; write the decision down either way.

Two more things follow from the shape. A network whose machines span hosts has its decided range split into equal slices, one per host, so the gateways, the static leases, and the DHCP pools never collide; a `/24` shared by two hosts becomes two `/25` slices. And a layer 2 transport keeps the whole range as one broadcast domain, while a layer 3 transport routes each slice, which is what makes aliases resolve per host rather than estate-wide.

## Cross-host transport options

`networkd.transport.<network>` offers every tunnel kind `systemd.netdev(5)` documents that can carry a network between hosts. The full table, with the file shapes and what each kind still needs by hand, is `skills/systemd-networkd/references/transports.md`. From the planner's side there are five families:

**Encrypted by itself.** `vxlan-wireguard` (an L2 domain inside a WireGuard mesh) and `wireguard` (each host's slice routed over the mesh). These are the defaults to reach for when the source overlay was `encrypted: true` or the hosts share an untrusted link. The keys are never values in a file: the private key is the credential `network.wireguard.private.<netdev>` and each peer's public key is `network.wireguard.public.<host>`, which `systemd-networkd.service` imports itself. `macsec` is the other encrypted option, and it fits only when the hosts already share one Ethernet segment; it also needs a receive channel per peer, which the inventory cannot supply.

**Plain L2 over the site's network.** `vxlan`, `geneve`, `gretap`, `ip6gretap`, and `l2tp`. The closest analogue to an overlay, and the option that keeps one broadcast domain, but the frames travel unencrypted and the failure modes move into the switch fabric. Prefer routing unless a single broadcast domain is a hard requirement.

**Plain L3 tunnels.** `gre`, `ip6gre`, `ipip`, `ip6tnl`, `fou` (IPIP inside UDP, for a path that drops protocol 4), and `bareudp`. Each host's slice is routed to its peers. Cheaper than L2 and easier to reason about; nothing resolves across hosts by itself, so the resolution decision matters more.

**IPsec.** `vti`, `vti6`, and `xfrm`. systemd creates the interface and the mark or interface id; the policies and security associations come from an IKE daemon, not from `.netdev` files. Choose one of these only when such a daemon is already part of the estate.

**No tunnel at all.** `underlay` says the site's routers carry each host's slice. It raises `networkd.uplink.<host>` on the next planning pass, so the routes can be rendered as a drop-in for the uplink's own `.network`, and `networkd.uplink.owner.<host>`, which defaults to `site`. Answering `harness` lets the plan put the uplink into a bond, a tagged VLAN, and a VRF; nothing about a link the site owns is touched otherwise.

`erspan` and `sit` are offered because `systemd.netdev(5)` documents them, and both carry a caveat the plan repeats: ERSPAN encapsulates mirrored traffic in one direction, and SIT carries IPv6 in IPv4, which the rendered IPv4 slices are not. Traffic control (`[QDisc]` and the shapers) is out of scope, because Swarm has no equivalent to translate.

## Service discovery

Across hosts nothing resolves automatically once the embedded DNS is gone. `resolved.discovery.estate` chooses between a rendered `/etc/hosts` fragment, DNS-SD over the zone, and the site's own DNS; the `systemd-resolved` skill covers all three. A service that takes a virtual address (below) is listed once at that address instead of once per host, because that is the address the balancing is behind.

## Replacing the VIP and the ingress mesh

Every published port raises two decisions. `networkd.publish.<service>.<port>-<protocol>` says what carries it, and `networkd.ingress.<service>.<port>-<protocol>` says whether the port exists only where the service runs (the default) or on every host of the plan, which is the mesh. The comparison table is `skills/systemd-networkd/references/load-balancing.md`; the summary for a review conversation:

- `host` and `socket` bind the port where the service runs. Simple, explicit, and no balancing. A port the source published in `ingress` mode has no default, precisely so this is a decision and not an accident.
- `reuseport` gives each instance on a host its own `.socket` on the same port with `ReusePort=yes`, and the kernel spreads connections across them. It balances within a host, needs a process that accepts an inherited socket, and cannot serve a mesh.
- `socket-proxyd` puts one socket-activated `systemd-socket-proxyd` in front of each backend, local or remote. It is the option that reproduces the mesh with nothing but systemd, works for machines and plain services alike, and is TCP only.
- `multipath` gives the service an address of its own on a `dummy` netdev and routes it over the backends with `MultiPathRoute=` or a nexthop group. It is the closest thing to the source's VIP that networkd renders itself: layer 3, per flow, and not health aware.
- `haproxy` hands the port to the `haproxy-ingress` adapter, which renders a hardened unit with health checks derived from the source's healthcheck. Choose it when layer 7 behaviour or health-aware balancing is actually wanted, and accept a third-party binary on the hosts.
- `external-lb` and `dns-rr` keep the balancing outside the estate. The plan lists the hosts as backends, or announces one record per host.

Edge proxies that were `mode: global` on Swarm map cleanly onto "one unit per edge host plus a virtual address or a load balancer in front". Move them last, because flipping them is the moment traffic changes.

## When a service is rendered as a Quadlet container

The Quadlet form keeps Podman on the host, and Podman's own bridge networks are host-local: a network alias resolves to the containers on the same host's bridge and to nothing else. So a stack that keeps cross-host members and chooses the Quadlet form needs the same transport decision as any other, and needs the published ports to be reached through one of the publish options rather than through a VIP that no longer exists. The `podman-quadlet` skill says the same from its side and points back here.

## Firewalling

The rendered tree touches netfilter in one place only: `IPMasquerade=` on a zone bridge, which `systemd-networkd` manages per interface, and which is written as `no` when the source network was `internal`. Everything else is the host's own ruleset. Podman inserts its own netfilter rules for the ports and bridges of the Quadlet form, which is a second ruleset on the same host. On hosts running `firewalld` or a custom `nftables` ruleset, confirm that the zone bridges and the tunnel or uplink interfaces sit in a zone that allows forwarding before assuming a connectivity problem is DNS, and check `nft list ruleset` after the first unit starts. The routed transports also need `net.ipv4.ip_forward`, which the component renders as `/etc/sysctl.d/80-migration-forwarding.conf` on exactly the hosts that need it.
