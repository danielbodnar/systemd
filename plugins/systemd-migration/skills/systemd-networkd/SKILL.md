---
name: systemd-networkd
description: The networking component. Replaces orchestrator networks with systemd-networkd: an address range per network, a zone bridge with a DHCP server and static leases for every service that runs as a machine or a virtual machine, a transport per cross-host overlay (every tunnel kind systemd.netdev(5) documents, from VXLAN over WireGuard to GENEVE, GRE, L2TP, MACsec, xfrm, bare UDP, and Foo-over-UDP, or the site's routers), macvlan and ipvlan on a decided parent link, a bond, VLAN, or VRF when the plan owns the uplink, and a policy per published port (bound on each host, socket-activated, spread with ReusePort=, proxied per backend with systemd-socket-proxyd, routed to a service VIP with MultiPathRoute= or a nexthop group, fronted by HAProxy, behind an external load balancer, or DNS round robin) with an ingress scope beside it, all as decisions in plan.yaml with the source's values as evidence, never as constants. Use this whenever the user asks about overlay networks, the ingress routing mesh, VIPs, load balancing, published ports, macvlan or ipvlan, bridges and zones for nspawn or vmspawn, VXLAN, GENEVE, GRE, L2TP, MACsec, IPsec tunnels, VNIs, WireGuard keys and endpoints, bonds, VLANs, VRFs, DHCP static leases, .network and .netdev files, socket activation, ReusePort=, systemd-socket-proxyd, or SocketBindAllow=.
---

# systemd-networkd

An orchestrator hides three things behind a network name: an address range, a way for members on different hosts to reach each other, and a way for clients to reach published ports. systemd separates them: `systemd-networkd` manages links, bridges, and tunnels from `.network` and `.netdev` files; the service manager binds ports through `.socket` units or lets the process bind them under `SocketBindAllow=`; resolution is `systemd-resolved`'s job (see the `systemd-resolved` skill). Every one of those is a decision here, because a wrong guess about a subnet or a transport is the kind of mistake that takes a site down.

## Decisions it raises

Always, for the networks and ports the inventory has:

- `networkd.subnet.<network>` (value, CIDR) for every application network: the range it uses on the systemd hosts. The source's IPAM subnet is the default and the evidence; for a macvlan or ipvlan network the source's `ip_range` is the default instead, because the rest of the segment belongs to the site.
- `networkd.domain.<network>` (value, name, default `_dhcp`): the local domain under which the host resolves the DHCP leases of the zone bridge (`LocalLeaseDomain=`), which is what the shipped `80-container-vz.network` uses.
- `networkd.transport.<network>` (choice) for every overlay whose members land on more than one host: one option per tunnel kind `systemd.netdev(5)` documents as a transport, plus `underlay`. `vxlan-wireguard` is the default when the source overlay was encrypted; an unencrypted one has no default. Each option carries the systemd version the directive catalogue gives the directives it renders. `references/transports.md` is the table.
- `networkd.vni.<network>` (value, port format): the VXLAN or GENEVE network identifier. The default is the network's 1-based position among the application networks sorted by name, so two overlays never share it.
- `networkd.wireguard.subnet.<network>` (value, CIDR): the range the WireGuard tunnel addresses come from, one address per host in the order of the host names. The default is `100.64.<position>.0/24` from the RFC 6598 shared address space.
- `networkd.wireguard.port.estate` (value, port, default 51820) when any overlay spans hosts: the base UDP port; the network at position `p` listens on the base port plus `p - 1`.
- `networkd.wireguard.endpoint.<host>` (value, IPv4) for every host an overlay lands on: the address the other hosts reach it at, for the WireGuard endpoint, the VXLAN underlay, or any other IPv4 tunnel. The default is the host's first probed address, else the inventory node's.
- `networkd.parent.<network>` (value, name) for every macvlan or ipvlan network: the host link the interfaces attach to, defaulting to the parent the source recorded.
- `networkd.zone.<service>` (choice) for every service that is a member of at least one application network: which network it attaches to when it runs as a machine or a virtual machine, one option per network plus `host` for the host's network namespace. The machined component reads it to write `Zone=` or `Private=no`.
- `networkd.publish.<service>.<port>-<protocol>` (choice) for every published port: `host`, `socket`, `reuseport`, `socket-proxyd`, `multipath`, `haproxy`, `external-lb`, or `dns-rr`. An ingress-mode port has no default: the routing mesh is gone, so say what replaces it. `references/load-balancing.md` is the comparison.
- `networkd.ingress.<service>.<port>-<protocol>` (choice, default `placement-hosts`): whether the port exists only where the service runs or on every host of the plan, which is the source's routing mesh. Only `socket-proxyd`, `multipath`, and `haproxy` can honour `every-host`; the other options say so in a note.

Raised on the next planning pass, once an option that needs them has been chosen (answer the option, re-run `plan.ts` against the plan, then review the new questions):

- `networkd.tunnel.key.<network>` (value, port format, default the network's position): the identifier the chosen transport carries, which is the GRE key for the GRE family and vti, the L2TP tunnel id, the xfrm interface id, or the MACsec port.
- `networkd.tunnel.port.<network>` (value, port): the UDP port of an encapsulating transport. The default is the conventional port for the kind (6081 for GENEVE, 1701 for L2TP, 5555 for Foo-over-UDP, 6635 for bare UDP) plus the network's position.
- `networkd.bareudp.ethertype.<network>` (choice, default `ipv4`): the L3 protocol a bare UDP tunnel carries.
- `networkd.macsec.parent.<network>` (value, name, no default): the host link a MACsec transport protects, which the inventory cannot know because the source's overlay hid it.
- `networkd.endpoint6.<host>` (value, no default unless the probe found one): the IPv6 address the other hosts reach a host at, for `ip6gre`, `ip6gretap`, `ip6tnl`, and `vti6`.
- `networkd.uplink.<host>` (value, path, no default), raised after a transport chose `underlay`: the `.network` file that configures the host's uplink, so the routes to the other hosts' slices can be rendered as a drop-in for it.
- `networkd.uplink.owner.<host>` (choice, default `site`): who configures that link. `harness` means this plan may reshape it, and raises the three below.
- `networkd.uplink.bond.<host>` (choice, default `none`, else a `[Bond] Mode=`), `networkd.uplink.vlan.<host>` (choice, default `no`) with `networkd.uplink.vlan.id.<host>` (value, port format, no default), and `networkd.uplink.vrf.<host>` (choice, default `no`) with `networkd.uplink.vrf.table.<host>` (value, port format, default derived from the host's position).
- `networkd.tap.<service>` (choice, default `vmspawn`) for a service the plan runs as a virtual machine: whether `systemd-vmspawn` creates the tap that joins it to the zone bridge, or `systemd-networkd` pre-creates it.
- `networkd.vip.range.estate` (value, CIDR, default `100.65.0.0/24`) and, per service with a multipath port, `networkd.vip.<service>` (value, IPv4, default the next address of that range) and `networkd.multipath.<service>` (choice, default `multipath-route`).
- `networkd.proxy.idle.estate` (value, default `5min`): `--exit-idle-time=` of the socket proxies.

## What it renders

- For a plain service: `SocketBindAllow=<proto>:<port>` and `SocketBindDeny=any`, or a `<unit>-<port>.socket` when the port is socket-activated. With `reuseport`, one such socket per instance on the host, all bound to the published port with `ReusePort=yes` and `Service=` pointing at that instance, so the kernel spreads connections; the port is not offset per instance, because sharing it is the point.
- With `socket-proxyd`: one `.socket` per backend on the published port with `ReusePort=yes`, each activating a `migration-socket-proxy@<address>:<port>.service` instance of a rendered hardened template that runs `systemd-socket-proxyd` with the decided idle timeout. A backend on this host gets a drop-in with `BindsTo=` its instance unit, so the proxy stops with it. The list is published under `networkd:proxies` (service, published port, socket unit, proxy unit, the instance it binds to, and the backend) for the rollout controller to stop when it drains a host.
- With `multipath`: `25-migration-vip-<service>.netdev`, a `dummy` link that anchors the service's virtual address, and `25-migration-vip-<service>.network`, which carries `Address=<vip>/32` on a host that runs an instance and, on a host in the ingress scope that runs none, a `[Route]` with one `MultiPathRoute=` per backend or a `[NextHop]` group the route names. Per flow, not health aware.
- For a machine attached to an overlay or bridge network: `25-migration-vz-<network>.network` for the zone bridge `vz-<network>` that `systemd-nspawn` creates for `Zone=`, with the host's gateway address inside the decided range, `DHCPServer=yes`, masquerading unless the source network was internal, `LocalLeaseDomain=` from the domain decision, and one `[DHCPServerStaticLease]` per machine with an address derived from the range and a MAC derived from the machine name. The machine's `systemd-nspawn@.service` drop-in gets `Environment=SYSTEMD_NSPAWN_NETWORK_MAC=` with that MAC, and its `.nspawn` file gets one `Port=` per published port.
- For a service the plan runs as a virtual machine: `25-migration-vt-<machine>.network`, which enslaves the tap `vt-<machine>` into the zone bridge instead of letting the shipped `80-vm-vt.network` give it a subnet of its own, a `.netdev` for that tap when the tap decision says networkd owns it, and a `systemd-vmspawn@.service` drop-in with `Environment=SYSTEMD_VMSPAWN_NETWORK_MAC=` so the guest presents the MAC the static lease names.
- The transport between the hosts of a multi-host overlay, from the transport decision: an L2 kind is enslaved into the zone bridge and every host's bridge keeps the whole range, an L3 kind carries a `[Route]` to each peer's slice and the bridges take slice-sized prefixes. `references/transports.md` gives the file shape of each kind and what it still needs by hand.
- When the plan owns a host's uplink: `25-migration-bond.netdev` and its `.network`, `25-migration-vlan.netdev`, `25-migration-vrf.netdev`, a drop-in for the site's uplink file that stacks the first of them on the link, and the underlay routes moved onto the topmost interface, in the VRF's table when there is one.
- For a machine attached to a macvlan or ipvlan network: `25-migration-mv-<network>.netdev`, its `.network` with the host's address, `25-migration-parent-<network>.network` stacking it on the decided parent, and `MACVLAN=` or `IPVLAN=` in the machine's `.nspawn` file.
- `/etc/sysctl.d/80-migration-forwarding.conf` for the routed transports only, and `networkctl reload` from `install.sh`.
- Every rendered `.network`, `.netdev`, and drop-in is checked against the directive catalogue, and every basename is recorded in `expected.json` under `networks`. An interface name longer than fifteen characters keeps its first ten and takes a four-character digest of the whole, because that is all the kernel accepts.

## What it publishes to the other components

- `networkd:leases`: the static lease of every machine and virtual machine of the estate, which the resolved component turns into the hosts fragment.
- `networkd:backends`: every published port's backends, keyed `<service>.<published>-<protocol>`, each an instance the plan places with its address (a lease, or its host's address), the port it listens on, and whether it sits on this host. The `haproxy-ingress` adapter reads it through `backendsOf()`.
- `networkd:proxies`: the socket proxies rendered on this host, for the rollout controller's `drain` and `activate` verbs.

## Files

- `scripts/component.ts`: the component module, the decisions, the zone bridges, and the uplink.
- `scripts/transports.ts`: the table of tunnel kinds and their rendering.
- `scripts/publish.ts`: the backend table and the load-balancing mechanisms.
- `scripts/shared.ts`: the decision ids, the state keys, and the address arithmetic.
- `references/zone-bridge.md`: the zone bridge, the DHCP pool and static leases, the MAC derivation, and the three original transports with their file shapes.
- `references/transports.md`: every tunnel kind, what it renders, what it needs decided, and what it still needs by hand.
- `references/load-balancing.md`: the publish options, the ingress scope, the VIP, and what each one can and cannot do.
- `references/networking.md` (in `../migration-planner/references/`): the same ground from the planner's side.
