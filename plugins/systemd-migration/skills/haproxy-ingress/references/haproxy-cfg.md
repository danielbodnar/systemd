<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# The rendered haproxy.cfg, annotated

This is the configuration the component writes for the fixture estate on `swarm-wrk-1` when `web_app`'s ingress port 8080 and `data_exporter`'s port 9187 both chose `haproxy`, `web_app`'s ingress is `every-host`, and every other decision took its default. The file is rendered from the plan: change a decision and render again rather than editing it, because the next render overwrites whatever is there.

Everything below is what HAProxy 2.4 and later document. The unit checks the file with `haproxy -c -q -f` before every start and before every reload, so a configuration that does not parse never replaces a running process.

```haproxy
# Rendered by systemd-migration for swarm-wrk-1: HAProxy fronting the published ports that chose it.
# Re-render from the plan instead of editing; haproxy-migration.service checks the file before every start and reload.
# data_exporter 9187/tcp: ingress placement-hosts, mode tcp, check tcp-connect, 1 backend(s)
# web_app 8080/tcp: ingress every-host, mode http, check http, 1 backend(s)

global
    log stdout format raw local0
    stats socket /run/haproxy-migration/admin.sock mode 660 level admin
    stats timeout 30s

defaults
    log global
    option dontlognull
    retries 3
    timeout connect 5s
    timeout client 30s
    timeout server 30s

frontend fe_data_exporter_9187_tcp
    mode tcp
    option tcplog
    bind 10.0.0.12:9187
    default_backend be_data_exporter_9187_tcp

backend be_data_exporter_9187_tcp
    mode tcp
    balance roundrobin
    # on this host: instance data_exporter of data_exporter
    server data_exporter 10.0.0.12:9187 check

frontend fe_web_app_8080_tcp
    mode http
    option httplog
    bind 10.0.0.12:8080
    default_backend be_web_app_8080_tcp

backend be_web_app_8080_tcp
    mode http
    balance roundrobin
    option httpchk
    http-check send meth GET uri /healthz
    http-check expect status 200-399
    default-server inter 15s fall 3 rise 2
    timeout check 5s
    # on this host: instance web_app of web_app
    server web_app 10.0.0.12:8080 check
```

## Line by line

**The header.** One comment per fronted port recording the three things that shaped it: the ingress scope, the proxy mode, and the check kind, with the number of backends. Reading the header tells you which decisions produced the file without opening `plan.yaml`.

**`log stdout format raw local0`.** HAProxy writes its log to standard output instead of a syslog socket, so the journal takes it under `SyslogIdentifier=haproxy-migration` and `journalctl -u haproxy-migration.service` shows the traffic. `format raw` leaves out the syslog header the journal would only duplicate.

**`stats socket ... mode 660 level admin`.** The runtime API, in the unit's `RuntimeDirectory=`, which systemd creates on start and removes on stop. `mode 660` with a `DynamicUser=` identity means only root reaches it. This is the socket the rollout controller drains through; set `haproxy.stats.estate` to `no` and both lines disappear.

**`defaults`.** `retries 3` reattempts a failed connection on another server; `option dontlognull` drops the log line for connections that carried nothing, which health probes and port scanners produce in quantity. The three timeouts exist because HAProxy warns about a proxy that has none, and 5 seconds to connect with 30 seconds of idle tolerance suits a service behind a health check. A workload with long-lived streams (websockets, database sessions) wants a larger `timeout client` and `timeout server`; raise them in the plan's rendering rather than in the file.

**`frontend fe_<service>_<port>_<proto>`.** One per published port, with `backend be_<service>_<port>_<proto>` behind it. The two prefixes keep a frontend and a backend from ever carrying the same name, and the stem says which port of which service the section belongs to, which is what the runtime commands below address. `bind` takes the service VIP when `networkd.vip.<service>` resolves, and otherwise the host's own address: an explicit address rather than `*` so the frontend cannot collide with something else on the host, and so a host with several addresses does not accidentally publish on all of them.

**`mode` and `option ...log`.** `tcp` with `option tcplog` forwards connections untouched and logs at layer 4. `http` with `option httplog` parses requests and logs method, path, and status. The default follows the source healthcheck: a plain `http://` probe is the estate's own statement that the port speaks HTTP.

**`balance roundrobin`.** Connections go to each server in turn. It is the closest analogue of what the Swarm VIP did, it needs no state shared between hosts, and it behaves correctly when servers are added or removed by a re-render. A workload that needs session affinity wants `balance source` or a cookie, which is a change to make deliberately and to record.

**`option httpchk` with `http-check send` and `http-check expect`.** The HTTP probe, taken from the source healthcheck's URL. The path is the path the container probed, so the new check exercises what the old one did. Statuses 200 to 399 count as healthy. This is the current form; the arguments `option httpchk` used to take are deprecated.

**`default-server inter 15s fall 3 rise 2`.** The interval and the failure count come from the source healthcheck (`interval: 15s`, `retries: 3`); two consecutive successes return a server to rotation. A backend whose service had no healthcheck, like `data_exporter` above, gets no `default-server` line and uses HAProxy's own defaults.

**`server <instance> <address>:<port> check`.** One per instance the plan places. The name is the instance base, the same name the unit carries (`web_app`, `web_app-2`), suffixed with the host only when one base appears on several hosts. The address is the machine's lease when the instance runs as a machine, and the host's address when it runs as a plain service, which is why an instance on this host is reached at the same address the frontend binds unless the service has a VIP. The comment above each line says whether the instance is on this host or reached over the transport.

`send-proxy-v2` joins the line when `haproxy.proxy-protocol.<service>.<port>-<proto>` is `send`. Turn it on only when the instance is configured to expect the header, because a backend that does not understand it rejects every connection.

## The port the instance already holds

A plain service on the same host binds the published port itself. HAProxy cannot bind the same address and port, so the renderer raises this as a decision whenever it sees it. Three ways out, in the order they are usually worth taking:

1. Give the service a VIP (`networkd.vip.<service>`), so the frontend binds the virtual address and the instance keeps the host's.
2. Run the service as a machine, so the instance answers on its lease inside the zone rather than on the host's address.
3. Move the instance to another port, which means the process must be configured to listen there.

## Draining a server

With the stats socket on, an operator or the rollout controller takes an instance out of rotation without re-rendering anything:

```bash
echo "show servers state" | socat stdio /run/haproxy-migration/admin.sock
echo "set server be_web_app_8080_tcp/web_app state drain" | socat stdio /run/haproxy-migration/admin.sock
echo "set server be_web_app_8080_tcp/web_app state ready" | socat stdio /run/haproxy-migration/admin.sock
```

Draining stops new connections while existing ones finish, which is what a rolling update wants between batches. The state is runtime only: a restart of the unit returns every server to what the file says, so a host taken out for longer belongs in the plan's placement rather than on the socket.

## Reloading

`systemctl reload haproxy-migration.service` runs `haproxy -c -q -f /etc/haproxy/haproxy.cfg` and then signals `USR2` to the master, which starts workers on the new configuration and lets the old ones finish their connections. A configuration that fails the check fails the reload and leaves the running process alone. `install.sh` ends with `systemctl try-reload-or-restart`, so installing a re-rendered tree picks up the new file without dropping the port.

`systemctl stop` sends `SIGUSR1`, HAProxy's soft stop, so connections drain up to `TimeoutStopSec=30` before systemd kills what is left.
