# Published ports, load balancing, and the ingress mesh

The source balanced in two places. A service had a virtual address that every container on its network could reach, and the orchestrator spread the connections across the service's tasks; and every node accepted every published port, forwarding to a task wherever it ran. Neither is one systemd primitive, so both become decisions: `networkd.publish.<service>.<port>-<protocol>` says what carries the port, and `networkd.ingress.<service>.<port>-<protocol>` says where the port exists.

## The backend table

Everything here is built on one table, which the component computes per host and publishes under `networkd:backends`:

```ts
interface Backend {
  service: string;
  base: string;      // the instance's unit base: web_app, web_app-2
  host: string;
  address: string;   // a machine's lease, or the host's address for a plain service
  port: number;      // what the instance itself listens on
  protocol: string;
  scope: "local" | "remote";
}
```

The instances come from the plan's placement, not from the host being rendered, so a host that runs three instances contributes three backends whether or not it is the host in hand. A machine answers on its static lease at the port the container opened, because the host's forwarded port belongs to the host, not to the instance. A plain service answers on its host's address at the published port, and the second and further instances that share a host take the next ports up, exactly as the service component renders them. `backendsOf(ctx, service, port, host)` is the accessor; the `haproxy-ingress` adapter calls it for its `server` lines.

## The options

| Option | Where it balances | Honours `every-host` | Needs |
|---|---|---|---|
| `host` | nowhere: one bind per host | no | nothing |
| `socket` | nowhere: one `.socket` per instance | no | a process that accepts an inherited socket |
| `reuseport` | the kernel, across the instances on one host | no | the same, plus more than one instance per host to be worth it |
| `socket-proxyd` | the kernel, across every instance of the estate | yes | `systemd-socket-proxyd`, and a TCP port |
| `multipath` | the kernel's route hash, per flow | yes | a virtual address, and routes the site can reach |
| `haproxy` | HAProxy, with health checks | yes | the `haproxy` binary; the adapter component renders it |
| `external-lb` | your balancer | not applicable | you operate it |
| `dns-rr` | the client's resolver | not applicable | clients that tolerate a stale record |

`host`, `socket`, and `reuseport` bind the port on the hosts that run the service and nowhere else. Asking for an every-host ingress beside one of them is not silently dropped: the renderer writes it into the notes as a decision, naming the three options that can do it.

### reuseport

One `.socket` per instance on the host, all bound to the same published port:

```
# web_app-1-8080.socket
[Unit]
Description=web_app-1 port 8080/tcp

[Socket]
ListenStream=8080
ReusePort=yes
Service=web_app-1.service

[Install]
WantedBy=sockets.target
```

`ReusePort=yes` makes systemd set `SO_REUSEPORT` on each socket, so the kernel hashes incoming connections across them and each instance serves its share. Two consequences are worth reading before choosing it. The process must accept the inherited listening socket (`sd_listen_fds`), because it never binds the port itself. And the kernel does not know whether the process behind a socket is healthy: an instance that has stopped answering keeps receiving the connections hashed to its socket until the socket itself is stopped, which is what the rollout controller does when it drains an instance. Unlike every other option, the published port is *not* offset per instance here, because sharing the port is the mechanism.

### socket-proxyd

One `.socket` per backend, all with `ReusePort=yes` on the published port, each activating an instance of a rendered template that runs `systemd-socket-proxyd(8)`:

```
# web_app-8080-web_app-swarm-mgr-1.socket
[Socket]
ListenStream=8080
ReusePort=yes
Service=migration-socket-proxy@10.0.0.11:8080.service
```

The instance name is the backend's `address:port`, which is what `%I` passes to the proxy. The template is hardened the way the rest of the rendered tree is (`DynamicUser=`, `ProtectSystem=strict`, an empty `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`) and carries `--exit-idle-time=` from `networkd.proxy.idle.estate`, so a proxy with no connections exits and the socket re-activates it on the next one. A backend on this host gets a drop-in with `BindsTo=` and `After=` its instance unit, so its proxy goes away with the instance; a remote backend has nothing local to bind to, and its socket is what the rollout controller stops when it drains the other host.

This is the option that reaches every instance of the estate from every host, which is the source's routing mesh. Two limits: it forwards stream sockets only, so a UDP port has to choose something else, and a local instance that listens on the published port itself collides with the proxy socket. The renderer says so as a decision rather than rendering a unit that cannot start, and names the ways out: give the service a virtual address, run it as a machine on a lease, or move the instance to another port. The proxy list is published under `networkd:proxies`.

### multipath

The service gets an address of its own, `networkd.vip.<service>`, taken by default from `networkd.vip.range.estate`. That range defaults to `100.65.0.0/24`: RFC 6598 sets aside `100.64.0.0/10` for addresses that are neither public nor site-local, and the WireGuard tunnel ranges already take `100.64.0.0/16`. Both are decisions, so an estate whose addressing collides changes them.

The address is anchored on a `dummy` netdev, one per service, on every host in the ingress scope:

```
# 25-migration-vip-data_exporter.netdev
[NetDev]
Name=vip-data_e-8f13
Kind=dummy
```

A host that runs an instance of the service holds the address:

```
[Network]
Address=100.65.0.1/32
```

A host in the scope that runs none routes it over the backends instead:

```
[Network]
IPv4Forwarding=yes

[Route]
Destination=100.65.0.1/32
MultiPathRoute=10.0.0.12 1
MultiPathRoute=10.10.1.2 1
```

or, when `networkd.multipath.<service>` chooses the nexthop form, with `[NextHop]` sections and a group the route names:

```
[NextHop]
Id=814021
Gateway=10.0.0.12

[NextHop]
Id=814022
Group=814021:1

[Route]
Destination=100.65.0.1/32
NextHop=814022
```

The two forms do the same thing; `MultiPathRoute=` needs no ids, and the group makes the weights explicit and reusable. The ids are derived from the service name so they are the same on every host and every run, which also means they have to stay clear of any nexthop the host configures itself.

The split between holding and routing is not a simplification, it is how the kernel works: an address that is local is delivered locally, and a route to it never applies. So the spreading happens on the hosts in the mesh that run no instance, and a host that runs the service answers from itself. Each backend contributes one entry, so a host with two instances takes twice the share of a host with one. The hash is per flow and knows nothing about health: a backend that stops answering keeps the flows hashed to it until its entry is withdrawn.

### haproxy

Here the option is a label, a consequence, and `requires: { tools: ["haproxy"] }`. The `haproxy-ingress` component reads the publish decision, the ingress decision, the virtual address, and the backend table, and renders the configuration and a hardened unit. See its skill.

## The ingress scope

`networkd.ingress.<service>.<port>-<protocol>` defaults to `placement-hosts`: the port exists where an instance runs. `every-host` is the source's routing mesh, and means every host the plan renders a tree for, which is every host the placement names for any service. `socket-proxyd`, `multipath`, and `haproxy` read it and render on each of those hosts; the rest say in their notes that they cannot.

The evidence on the decision is the source's own port mode, so a port the source published in `ingress` mode says so and a port it published in `host` mode says that instead. The default stays `placement-hosts` either way, because a mesh is a cost as well as a feature and the plan is the place to look at it.

## What resolution does with a virtual address

The resolved component reads the same decision. When a service has a virtual address, the hosts fragment lists it once at that address rather than once per host, and the DNS-SD and site-DNS paths say in their notes that a client resolving the service by another route bypasses the multipath entirely, so the record to publish is the virtual address.
