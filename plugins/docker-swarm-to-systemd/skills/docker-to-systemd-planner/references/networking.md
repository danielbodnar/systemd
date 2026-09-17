# Networking after Swarm

Swarm provided three network services that disappear with it: overlay networks that span hosts, the ingress routing mesh that accepts a published port on every node, and virtual IPs with embedded DNS for service discovery. Podman under systemd provides host-local bridge networks with DNS aliases. Everything that crossed a host boundary needs a replacement, and the choice depends on how much of the estate ends up on one host.

## Decide the shape first

Read `networks[].used_by` and `services[].tasks[].node` in the inventory. If every member of a network is placed on one host after migration, the network is local and needs nothing beyond the rendered `.network` unit. Only networks whose members land on different hosts need transport. Collapsing a stack onto one host is a legitimate answer and is usually the cheapest one; write the decision down either way.

## Cross-host transport options

**Routed underlay.** Give each host a distinct subnet for the migrated bridge (override `Subnet=` in the rendered `.network` per host) and add static routes between hosts. Traffic is unencrypted, which is acceptable only where the original overlay was unencrypted and the link is private. `systemd-networkd` expresses this with a `[Route]` section per peer subnet in the host's `.network` file.

**WireGuard mesh.** Where the overlay was `encrypted: true`, or the hosts share an untrusted link, build a WireGuard interface per host with `systemd-networkd`: a `.netdev` of `Kind=wireguard` holding the private key (delivered as a systemd credential, never in the file), one `[WireGuardPeer]` per remote host with its public key, endpoint, and `AllowedIPs` covering that host's bridge subnet, and a `.network` assigning the interface address and routes. Set `Table=` and `RouteMetric=` deliberately when the hosts already run a VPN. Podman's bridge needs IP forwarding enabled on the host and a firewall rule permitting forwarding between the bridge and the WireGuard interface.

**Shared L2.** VLAN or VXLAN interfaces managed by `systemd-networkd` (`Kind=vlan`, `Kind=vxlan`) let the bridge span hosts at layer two when the physical network permits it. This is the closest analogue to an overlay but pushes the failure modes into the switch fabric; prefer routing unless a hard requirement for a single broadcast domain exists.

## Service discovery

Inside a host, Podman's network DNS resolves container names and `NetworkAlias=` values, so a service reaching a peer on the same bridge keeps working with the same hostname. Across hosts nothing resolves automatically. Choose one:

- Publish the peer's port on its host and point callers at the host name through `AddHost=` lines or split-horizon DNS. Simple and explicit; fits databases and other singletons.
- Run a small resolver (or use `systemd-resolved` with a per-interface domain) that maps service names to the host running them, and configure containers with `DNS=` pointing at it.
- Put the peer behind the same load balancer that replaces the ingress mesh and address it by the balancer's name.

Swarm's VIP load-balanced across replicas; when a service keeps several replicas on several hosts, only a load balancer or DNS round robin reproduces that behaviour.

## Replacing the ingress mesh

Every `PublishPort=` in the rendered units binds on the host that runs the unit. Decide how external traffic finds those hosts:

- An external load balancer (cloud, HAProxy, Caddy, Traefik running itself as a Quadlet unit on the edge hosts) with one backend per host and health checks that match the unit's `HealthCmd=`.
- DNS round robin when clients tolerate a dead entry for the TTL.
- A VIP moved between hosts by keepalived for active-passive edge services.

Edge proxies that were `mode: global` on Swarm map cleanly onto "one unit per edge host plus a VIP or load balancer in front". Move them last, because flipping them is the moment traffic changes.

## Firewalling

Podman inserts its own netfilter rules for published ports and bridge NAT. On hosts using `nftables` through `firewalld` or a custom ruleset, confirm the Podman netavark backend is configured for the same firewall driver and that the WireGuard or routed interfaces are placed in a zone that allows forwarding. Test with `nft list ruleset` after the first unit starts, before assuming a connectivity problem is DNS.
