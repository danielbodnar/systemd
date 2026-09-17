# Migration notes

Rendered by systemd-migration from an inventory captured 2026-09-01T12:00:00Z (4 services, 2 nodes) against a plan of 62 decisions (4 chosen). Components composed, in order: machined, service, creds, resource-control, storage, networkd, resolved, journald, sysext, portable, quadlet, generator, rollout, haproxy.

## Host plan

| Host | Units | Timers | Mounts | Machines | Ports | Credentials | Images |
|---|---|---|---|---|---|---|---|
| swarm-mgr-1 | web_proxy.service | 0 | 0 | 0 | 80/tcp | 0 | 1 |
| swarm-wrk-1 | data_exporter.service, data_postgres.service, web_app.service | 2 | 1 | 0 | 9187/tcp, 8080/tcp | 3 | 3 |

## Images to pull

| Local name | Reference | Digest recorded by the source | Hosts |
|---|---|---|---|
| acme-app_2026.09 | registry.example.com/acme/app:2026.09 | sha256:0000000000000000000000000000000000000000000000000000000000000002 | swarm-wrk-1 |
| library-caddy_2 | docker.io/library/caddy:2 | none (tag not pinned) | swarm-mgr-1 |
| library-postgres_16.4 | docker.io/library/postgres:16.4 | sha256:0000000000000000000000000000000000000000000000000000000000000003 | swarm-wrk-1 |
| prometheuscommunity-postgres-exporter_v0.15.0 | quay.io/prometheuscommunity/postgres-exporter:v0.15.0 | none (tag not pinned) | swarm-wrk-1 |

`images.json` next to this file drives `pull-images.sh` from the systemd-machined skill.

## Needs a human decision

- data_exporter: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder (/bin/false), set it by hand
- data_postgres: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder (/bin/false), set it by hand
- decision storage.move.web_cache took "rsync" without review: How does the data of volume web_cache (used by web_app) reach the new host?
- decision storage.move.data_pgdata took "rsync" without review: How does the data of volume data_pgdata (used by data_postgres) reach the new host?
- decision networkd.publish.web_app.8080-tcp took "host" without review: Port 8080/tcp of web_app was published in ingress mode through the routing mesh. How do clients reach it now?
- decision resolved.discovery.estate took "hosts" without review: How do services resolve each other's names on the systemd hosts?

## Translations to review

- swarm-mgr-1: host capabilities unknown (no probe file); images are assumed to mount as mount stacks
- web_proxy: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- web_proxy: member of overlay network web_frontend (10.10.1.0/24, vxlan-wireguard); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- web_proxy: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides, unless a published port chooses multipath and the plan gives it an address of its own
- service names are resolved from /etc/hosts (decision resolved.discovery.estate); install.sh appends the rendered fragment once, dedupe it by hand on re-install
- web_proxy: the source describes no update_config; the rollout specification takes parallelism 1, delay 0s, and max failure ratio 0, and the order and failure action come from rollout.order.web_proxy and rollout.failure.web_proxy when those decisions exist
- swarm-mgr-1: /usr/local/lib/systemd-migration/stackctl drives deploy, rollback, drain, activate, scale, rotate, and status from /etc/systemd-migration/rollout/<stack>.conf; every verb takes --dry-run and prints the systemctl commands it would run
- the service component gives each stack target [Install] WantedBy=multi-user.target but enables nothing; install.sh now runs systemctl enable over the stack targets, and install.sh --start still enables and starts them
- swarm-wrk-1: host capabilities unknown (no probe file); images are assumed to mount as mount stacks
- data_exporter: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- data_postgres: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- data_postgres: sysctls kernel.shmmax apply to the whole host from /etc/sysctl.d/90-data.conf, not to the service alone
- data_postgres: update_config (stop-first, parallelism 1, on failure pause) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback
- data_postgres: the healthcheck runs from data_postgres-health.timer every 10s and restarts the service after 5 consecutive failures; the start period becomes the timer's first delay
- web_app: init was set, which made Docker run its own init as PID 1 from outside the image; the image records none of the init processes this renderer documents (catatonit, docker-init, dumb-init, runit, s6-svscan, supervisord, tini), so ExecStart= runs the workload directly and the service manager reaps the orphans the init would have reaped
- web_app: sysctls net.core.somaxconn apply to the whole host from /etc/sysctl.d/90-web.conf, not to the service alone
- web_app: StartLimitBurst=5 counts every start within StartLimitIntervalSec=120, including the restarts web_app-restart.service performs after a failed healthcheck, which is how Swarm counted an unhealthy task against max_attempts; systemctl reset-failed clears the counter
- web_app: update_config (start-first, parallelism 1, on failure rollback) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback
- web_app: extra_hosts 10.0.9.9 legacy.internal are not rendered as service directives; add each to the host's /etc/hosts or give the resolved component a record for the name
- web_app: the healthcheck runs from web_app-health.timer every 15s and restarts the service after 3 consecutive failures; the start period becomes the timer's first delay
- data_postgres: secret data_postgres_password was owned by 999:999 in the container; credentials are readable by the service user only, which is what the mode asked for
- web_app: environment APP_SECRET_KEY was redacted at capture; the value is loaded as credential web_app-app-secret-key at %d/web_app-app-secret-key, and the process must read it from there or from APP_SECRET_KEY_FILE
- web_app: secret web_app_signing_key was owned by 1000:1000 in the container; credentials are readable by the service user only, which is what the mode asked for
- data_postgres: volume data_pgdata at /var/lib/data/data_pgdata is created for a DynamicUser= service; StateDirectory= would be the native shape if the path can move under /var/lib/data_postgres
- data_postgres: volume data_pgdata moves by "rsync" (decision storage.move.data_pgdata); the runbook step lands at /var/lib/data/data_pgdata
- web_app: volume web_cache moves by "rsync" (decision storage.move.web_cache); the runbook step lands at /var/lib/web/web_cache
- data_exporter: member of overlay network data_backend (10.10.2.0/24, local); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- data_exporter: member of macvlan network data_monitoring (192.168.50.128/25, local); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- data_exporter: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides, unless a published port chooses multipath and the plan gives it an address of its own
- data_postgres: member of overlay network data_backend (10.10.2.0/24, local); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- web_app: member of overlay network web_frontend (10.10.1.0/24, vxlan-wireguard); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- web_app: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides, unless a published port chooses multipath and the plan gives it an address of its own
- data_exporter: the source describes no update_config; the rollout specification takes parallelism 1, delay 0s, and max failure ratio 0, and the order and failure action come from rollout.order.data_exporter and rollout.failure.data_exporter when those decisions exist
- swarm-wrk-1: /usr/local/lib/systemd-migration/stackctl drives deploy, rollback, drain, activate, scale, rotate, and status from /etc/systemd-migration/rollout/<stack>.conf; every verb takes --dry-run and prints the systemctl commands it would run

## Carried over from the capture

- service web_proxy: image docker.io/library/caddy:2 is not pinned to a digest
- service data_exporter: image quay.io/prometheuscommunity/postgres-exporter:v0.15.0 is not pinned to a digest
- service web_app: task t3 on swarm-mgr-1 is failed (task: non-zero exit (137))
- service web_app: publishes through the ingress routing mesh; systemd hosts publish per host
- network web_frontend: encrypted overlay; cross-host transport must be replaced (see migration-planner/references/networking.md)
- network data_backend: encrypted overlay; cross-host transport must be replaced (see migration-planner/references/networking.md)
- image docker.io/library/postgres:16.4: not present on the capturing node, so its entrypoint, command, and environment are unknown; the rendered ExecStart= needs a review (used by data_postgres)
- image quay.io/prometheuscommunity/postgres-exporter:v0.15.0: not present on the capturing node, so its entrypoint, command, and environment are unknown; the rendered ExecStart= needs a review (used by data_exporter)
