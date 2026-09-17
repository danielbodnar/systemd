---
name: systemd-networkd
description: The networking component. Replaces orchestrator networks with systemd-networkd: an address range per network, a transport per cross-host overlay (VXLAN over WireGuard, plain VXLAN, routed WireGuard, or the site's routers), and a policy per published port (bound on each host, socket-activated, behind an external load balancer, or DNS round robin), all as decisions in plan.yaml with the source's values as evidence, never as constants. Use this whenever the user asks about overlay networks, the ingress routing mesh, VIPs, published ports, macvlan or ipvlan, bridges and zones for nspawn, VXLAN, WireGuard, .network and .netdev files, socket activation, or SocketBindAllow=.
---

# systemd-networkd

An orchestrator hides three things behind a network name: an address range, a way for members on different hosts to reach each other, and a way for clients to reach published ports. systemd separates them: `systemd-networkd` manages links, bridges, and tunnels from `.network` and `.netdev` files; the service manager binds ports through `.socket` units or lets the process bind them under `SocketBindAllow=`; resolution is `systemd-resolved`'s job (see the `systemd-resolved` skill). Every one of those is a decision here, because a wrong guess about a subnet or a transport is the kind of mistake that takes a site down.

## Decisions it raises

- `networkd.subnet.<network>` (value, CIDR) for every application network: the range it uses on the systemd hosts. The source's IPAM subnet is the default and the evidence; change it when the range collides with the site.
- `networkd.transport.<network>` (choice) for every overlay whose members land on more than one host: `vxlan-wireguard` (default when the source overlay was encrypted), `vxlan`, `wireguard` (routed, no L2), or `underlay` (the site's routers carry the bridge subnets). An unencrypted source overlay has no default: pick one.
- `networkd.publish.<service>.<port>-<protocol>` (choice) for every published port: `host` (default for host-mode ports), `socket`, `external-lb`, or `dns-rr`. An ingress-mode port has no default: the routing mesh is gone, so say what replaces it.

## What it renders

- For a plain service: `SocketBindAllow=<proto>:<port>` and `SocketBindDeny=any`, or a `<unit>-<port>.socket` when the port is socket-activated. Published ports that differ from the container port, and instances that share a host, are noted.
- For a machine: the zone bridge (`vz-<network>` through `Zone=`) with the decided subnet, static leases for fixed addresses, and the transport between hosts: a `vxlan` netdev bridged into the zone, a `wg` netdev with keys as credentials, or nothing when the site routes. The shipped `80-container-vz.network` is the base; the rendered drop-in replaces its range with the decided one.
- A macvlan or ipvlan network becomes the matching `.netdev` on the parent link the plan names.

## Files

- `scripts/component.ts`: the component module.
- `references/networking.md` (in `../migration-planner/references/`): the transports, the VIP replacements, and the `.netdev` and `.network` shapes behind each option.
