---
name: haproxy-ingress
description: Render a hardened HAProxy front end for the published ports a migration plan hands to HAProxy, as /etc/haproxy/haproxy.cfg plus haproxy-migration.service, with backends taken from the estate's instances and health checks taken from the source healthcheck. Use this whenever a published port needs a real load balancer with health checks or layer 7 behaviour, whenever the user asks how the Swarm routing mesh or a service VIP is replaced, whenever the publish decision networkd.publish.<service>.<port> should be or already is "haproxy", or whenever someone asks why the rendered tree carries an haproxy.cfg and what its frontends, backends, and server lines mean. Use it after the networkd component has published the backend table; HAProxy is an adapter target, not a systemd man page.
---

# HAProxy as a publish option

Docker Swarm balanced published ports in two places at once: every node accepted the port through the routing mesh, and a service VIP spread connections over the tasks. systemd replaces the first with the ingress decision and the second with routed addresses, socket units, or a proxy. When the workload wants real health checks, draining, or HTTP awareness, the publish decision picks `haproxy` and this component renders the load balancer.

HAProxy is a third party rather than a systemd page, so the component claims no page of the systemd surface and is listed under `adapters` in `contract/coverage.json`, next to Quadlet. Nothing else in the estate changes: the instances stay the units the service, machined, or quadlet component rendered, and HAProxy sits in front of them.

## Which HAProxy the rendered tree assumes

**HAProxy 2.4 or later.** The unit and the configuration use, and are checked against, what that release documents:

- `haproxy -Ws` runs master-worker mode with `sd_notify`, which is what makes `Type=notify` correct (master-worker with notification since 1.8).
- `log stdout format raw local0` sends the log to the unit's standard output, so the journal takes it and no syslog socket is needed (since 1.9).
- `http-check send meth GET uri <path>` and `http-check expect status 200-399` are the current form of the HTTP probe; the arguments `option httpchk` used to take are deprecated (since 2.2).
- `stats socket ... level admin` is the runtime API the rollout controller drains a server through.

On an older HAProxy the configuration will not load, and the unit says so before it starts anything: `ExecStartPre=` runs `haproxy -c -q -f` on every start and the first `ExecReload=` runs it again before the signal, so a bad configuration never replaces a working process. Check `haproxy -v` on the target hosts; the host probe records whether the binary exists at all, and the publish option's `requires` uses that.

## What triggers it

One thing only: a published port whose publish decision, `networkd.publish.<service>.<port>-<proto>`, is `haproxy`. Ports that kept `host`, `socket`, `reuseport`, `socket-proxyd`, `multipath`, `external-lb`, or `dns-rr` are none of this component's business, and a plan where no port chose HAProxy renders no configuration, no unit, and no note. HAProxy proxies TCP, so a UDP port that chose it is left unfronted with a note saying to choose again.

## The decisions it raises

These appear only after a publish decision has chosen HAProxy, so re-run `plan.ts` against the plan once you have made that choice in `review.ts`; until then the renderer uses the defaults below and lists each one under "needs a human decision" in `MIGRATION-NOTES.md`.

| Decision | Kind | Default | Meaning |
|---|---|---|---|
| `haproxy.mode.<service>.<port>-<proto>` | choice `tcp`, `http` | `http` when the source healthcheck is a plain `http://` probe, else `tcp` | Whether the frontend and backend parse requests or pass connections through. `tcp` carries any protocol, TLS included; `http` gives HTTP logging and header handling and needs a backend that speaks plain HTTP. |
| `haproxy.check.<service>.<port>-<proto>` | choice `tcp-connect`, `http`, `none` | `http` when the source healthcheck is an HTTP probe, else `tcp-connect` | How an instance is judged healthy. The HTTP form sends `GET` to the path the source healthcheck probed and accepts statuses 200 to 399. `none` keeps every instance in rotation whatever its state. |
| `haproxy.proxy-protocol.<service>.<port>-<proto>` | choice `no`, `send` | `no` | Whether every server line gets `send-proxy-v2` so the instance sees the client's address. The instance must be configured to accept the header, or every connection fails. |
| `haproxy.stats.estate` | choice `socket`, `no` | `socket` | Whether `global` carries `stats socket /run/haproxy-migration/admin.sock mode 660 level admin`, the runtime API the rollout controller uses to drain a server without a re-render. |

The evidence under each is the source's own values: the port's mode and published number, the service's mode, replica count, and `endpoint_mode`, and the healthcheck's command, interval, timeout, and retries. The interval, retries, and timeout also become `default-server inter ... fall ... rise 2` and `timeout check ...`, so the new health checks run at the cadence the old ones did.

Two decisions belong to the networkd component and this one only reads them: `networkd.ingress.<service>.<port>-<proto>` chooses `placement-hosts` (the frontend exists where the service runs) or `every-host` (the frontend exists on every host the plan renders, forwarding to the placement hosts, which is the routing mesh), and `networkd.vip.<service>` gives the service an address the frontend binds instead of the host's.

## What it renders, per host in scope

`/etc/haproxy/haproxy.cfg`, built in a fixed order so two runs of the same plan produce the same bytes:

- `global` with the log target and, when the stats decision says so, the runtime socket under the unit's `RuntimeDirectory=`.
- `defaults` with the log, `retries`, and the connect, client, and server timeouts.
- One `frontend fe_<service>_<port>_<proto>` per published port, binding the service VIP when `networkd.vip.<service>` resolves and otherwise the host's probed address (the inventory's node address when the host was not probed), with `default_backend` naming its backend.
- One `backend be_<service>_<port>_<proto>` per published port, `balance roundrobin`, the health check the decision chose, and one `server` line per instance the plan places, on this host and on the others, taken from the backend table the networkd component publishes. A server is named after the instance base (`web_app`, `web_app-2`), suffixed with the host only when the same base appears on more than one host, so `set server <backend>/<name> state drain` on the runtime socket names something stable.

`/etc/systemd/system/haproxy-migration.service`. The name is deliberate: a distribution's own `haproxy.service` stays where it is and the two never collide. It is `Type=notify` around `haproxy -Ws`, `PartOf=` and `WantedBy=` the target of every stack whose ports it fronts, and `ExecReload=` validates the configuration before signalling `USR2` so a reload cannot take the estate's ingress down. `KillSignal=SIGUSR1` makes a stop a soft stop, draining within `TimeoutStopSec=`.

The hardening follows the service component: `DynamicUser=yes`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=` and `AmbientCapabilities=` holding nothing but `CAP_NET_BIND_SERVICE` (which is what lets an unprivileged process bind a port below 1024), `ProtectSystem=strict` with no writable path but `RuntimeDirectory=haproxy-migration`, the `Protect*` and `Restrict*` set, `SystemCallFilter=@system-service`, and `SocketBindAllow=` for each fronted port with `SocketBindDeny=any` behind it, so the process can bind those ports and nothing else. Every directive is one `contract/directives.json` documents, which the harness suite checks.

The unit goes into `expected.json` for the verifier, each fronted port goes into its port list, and `install.sh` runs `systemctl try-reload-or-restart haproxy-migration.service` after `daemon-reload`.

## TLS termination is out of scope

Nothing in the rendered tree terminates TLS, and the renderer leaves that under "needs a human decision" whenever it renders anything. A certificate and its key are credentials: they belong in `LoadCredentialEncrypted=` on the unit, read from `$CREDENTIALS_DIRECTORY` by a `bind ... ssl crt` line, which also means reviewing whether the frontend should still be in the mode the plan chose. Decide it before a fronted port is reachable beyond the estate. Until then the frontend is plain, and an `https://` healthcheck in the source is read as a backend that terminates TLS itself, which is why such a probe leaves the mode at `tcp`.

## Reading the result

`references/haproxy-cfg.md` annotates a rendered configuration line by line and lists the runtime commands that drain and restore a server. Read it before changing anything by hand: the file is rendered from the plan, and an edit made in place is lost at the next render. Change the decision and render again.
