# Migration notes (native services)

Rendered by systemd-service from an inventory captured 2026-09-01T12:00:00Z (4 services, 2 nodes). Each service runs as a systemd service whose root is its image, mounted with RootMStack=; there is no container runtime on the hosts.

## Host plan

| Host | Units | Timers | Mounts | Ports | Credentials | Images |
|---|---|---|---|---|---|---|
| swarm-mgr-1 | web_proxy.service | 0 | 0 | 80/tcp | 0 | 1 |
| swarm-wrk-1 | data_exporter.service, data_postgres.service, web_app.service | 2 | 1 | 9187/tcp, 8080/tcp | 3 | 3 |

## Images to pull

| Local name | Reference | Digest recorded by the swarm | Hosts |
|---|---|---|---|
| acme-app_2026.09 | registry.example.com/acme/app:2026.09 | sha256:0000000000000000000000000000000000000000000000000000000000000002 | swarm-wrk-1 |
| library-caddy_2 | docker.io/library/caddy:2 | none (tag not pinned) | swarm-mgr-1 |
| library-postgres_16.4 | docker.io/library/postgres:16.4 | sha256:0000000000000000000000000000000000000000000000000000000000000003 | swarm-wrk-1 |
| prometheuscommunity-postgres-exporter_v0.15.0 | quay.io/prometheuscommunity/postgres-exporter:v0.15.0 | none (tag not pinned) | swarm-wrk-1 |

`images.json` next to this file drives `pull-images.sh` from the systemd-machined skill.

## Needs a human decision

- data_exporter: the Swarm VIP becomes one address per host; other services reach it by the host's address or a name the plan provides
- data_exporter: attached to overlay data_backend; native services share the host network namespace, so container-network addressing and aliases do not apply until systemd-networkd renders the bridges
- data_exporter: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder that must be replaced before install
- data_postgres: attached to overlay data_backend; native services share the host network namespace, so container-network addressing and aliases do not apply until systemd-networkd renders the bridges
- data_postgres: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder that must be replaced before install
- web_app: ingress-mode ports are published in host mode on every host that runs it; front them with a load balancer, DNS round robin, or a VIP (see the translation map)
- web_app: the Swarm VIP becomes one address per host; other services reach it by the host's address or a name the plan provides
- web_app: attached to overlay web_frontend; native services share the host network namespace, so container-network addressing and aliases do not apply until systemd-networkd renders the bridges
- web_proxy: the Swarm VIP becomes one address per host; other services reach it by the host's address or a name the plan provides
- web_proxy: attached to overlay web_frontend; native services share the host network namespace, so container-network addressing and aliases do not apply until systemd-networkd renders the bridges

## Translations to review

- data_exporter: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- data_postgres: update_config (stop-first, parallelism 1, on failure pause) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback
- data_postgres: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- data_postgres: secret data_postgres_password was owned by 999:999 in the container; credentials are readable by the service user only, which is what the mode asked for
- data_postgres: volume data_pgdata at /var/lib/data/data_pgdata is created for a DynamicUser= service; StateDirectory= would be the native shape if the path can move under /var/lib/data_postgres
- data_postgres: sysctls kernel.shmmax apply to the whole host from /etc/sysctl.d/90-data.conf, not to the service alone
- data_postgres: the healthcheck runs from data_postgres-health.timer every 10s and restarts the service after 5 consecutive failures; Swarm's start_period becomes the timer's first delay
- web_app: wanted 2 replicas but rendered 1 (one per eligible host; pass --scale-out for numbered instances)
- web_app: update_config (start-first, parallelism 1, on failure rollback) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback
- web_app: environment APP_SECRET_KEY was redacted at capture; the value is loaded as credential web_app-app-secret-key at %d/web_app-app-secret-key, and the process must read it from there or from APP_SECRET_KEY_FILE
- web_app: secret web_app_signing_key was owned by 1000:1000 in the container; credentials are readable by the service user only, which is what the mode asked for
- web_app: extra host "10.0.9.9 legacy.internal" must be added to the host's /etc/hosts or the resolver
- web_app: sysctls net.core.somaxconn apply to the whole host from /etc/sysctl.d/90-web.conf, not to the service alone
- web_app: the healthcheck runs from web_app-health.timer every 15s and restarts the service after 3 consecutive failures; Swarm's start_period becomes the timer's first delay
- web_proxy: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes

## Carried over from the capture

- service web_proxy: image docker.io/library/caddy:2 is not pinned to a digest
- service data_exporter: image quay.io/prometheuscommunity/postgres-exporter:v0.15.0 is not pinned to a digest
- service web_app: task t3 on swarm-mgr-1 is failed (task: non-zero exit (137))
- service web_app: publishes through the ingress routing mesh; systemd hosts publish per host
- network web_frontend: encrypted overlay; cross-host transport must be replaced (see migration-planner/references/networking.md)
- network data_backend: encrypted overlay; cross-host transport must be replaced (see migration-planner/references/networking.md)
- image docker.io/library/postgres:16.4: not present on the capturing node, so its entrypoint, command, and environment are unknown; the rendered ExecStart= needs a review (used by data_postgres)
- image quay.io/prometheuscommunity/postgres-exporter:v0.15.0: not present on the capturing node, so its entrypoint, command, and environment are unknown; the rendered ExecStart= needs a review (used by data_exporter)
