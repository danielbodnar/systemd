# Migration notes

Rendered by systemd-migration from an inventory captured 2026-09-01T12:00:00Z (4 services, 2 nodes) against a plan of 54 decisions (54 chosen). Components composed, in order: machined, service, creds, resource-control, storage, networkd, resolved, journald, sysext, portable, quadlet, generator, rollout, haproxy.

## Host plan

| Host | Units | Timers | Mounts | Machines | Ports | Credentials | Images |
|---|---|---|---|---|---|---|---|
| swarm-mgr-1 | web_proxy.service | 0 | 0 | 0 | 80/tcp | 0 | 1 |
| swarm-wrk-1 | data_exporter.service, data_postgres.service, systemd-nspawn@web_app.service | 1 | 1 | 1 | 9187/tcp, 8080/tcp | 3 | 3 |

## Images to pull

| Local name | Reference | Digest recorded by the source | Hosts |
|---|---|---|---|
| acme-app_2026.09 | registry.example.com/acme/app:2026.09 | sha256:0000000000000000000000000000000000000000000000000000000000000002 | swarm-wrk-1 |
| library-caddy_2 | docker.io/library/caddy:2 | none (tag not pinned) | swarm-mgr-1 |
| library-postgres_16.4 | docker.io/library/postgres:16.4 | sha256:0000000000000000000000000000000000000000000000000000000000000003 | swarm-wrk-1 |
| prometheuscommunity-postgres-exporter_v0.15.0 | quay.io/prometheuscommunity/postgres-exporter:v0.15.0 | none (tag not pinned) | swarm-wrk-1 |

`images.json` next to this file drives `pull-images.sh` from the systemd-machined skill.

## Needs a human decision

- web_app: secret web_app_signing_key was mounted at /run/secrets/signing_key in the container; a machine receives it as a credential at /run/host/credentials/web_app_signing_key ($CREDENTIALS_DIRECTORY), so the payload must read it from there
- data_exporter: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder (/bin/false), set it by hand
- data_postgres: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder (/bin/false), set it by hand

## Translations to review

- swarm-mgr-1: host capabilities unknown (no probe file); images are assumed to mount as mount stacks
- web_proxy: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- web_proxy: member of overlay network web_frontend (10.10.1.0/24, vxlan-wireguard); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- web_proxy: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides
- service names are resolved from /etc/hosts (decision resolved.discovery.estate); install.sh appends the rendered fragment once, dedupe it by hand on re-install
- machines on zone vz-web_frontend are listed at their static lease address; on swarm-mgr-1 their DHCP lease names also resolve under _dhcp through the bridge's LocalLeaseDomain=
- swarm-wrk-1: host capabilities unknown (no probe file); images are assumed to mount as mount stacks
- web_app: the group of user 1000:1000 is not set on the machine; systemd-nspawn takes the group from the container's user database
- web_app: ran under an init shim (ProcessTwo=yes) but loads credentials as user 1000; systemd-nspawn can only make them readable when the payload is PID 1, so ProcessTwo= is left off and NoNewPrivileges=yes is set (systemd-nspawn(1), --uid=)
- web_app: environment APP_SECRET_KEY was redacted at capture; the value is passed as credential web_app-app-secret-key, which the payload reads from /run/host/credentials/web_app-app-secret-key or APP_SECRET_KEY_FILE
- web_app: volume web_cache moves by "empty" (decision storage.move.web_cache); the runbook step lands at /var/lib/web/web_cache
- web_app: volumes are bound with the idmap option so the machine's users own them as they did in the container; the source file system must support ID-mapped mounts (systemd-nspawn(1), --bind=)
- web_app: the root is read-only (ReadOnly=yes); every mount target (/tmp, /cache) must already exist in the image, as systemd-nspawn cannot create it
- web_app: the healthcheck (curl -fsS http://localhost:8080/healthz || exit 1) is not rendered for a machine; run it inside with machinectl shell web_app from a timer, or let the payload use sd_notify
- web_app: rendered as machine web_app (systemd-nspawn); review /etc/systemd/nspawn/web_app.nspawn
- data_exporter: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- data_postgres: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes
- data_postgres: sysctls kernel.shmmax apply to the whole host from /etc/sysctl.d/90-data.conf, not to the service alone
- data_postgres: update_config (stop-first, parallelism 1, on failure pause) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback
- data_postgres: the healthcheck runs from data_postgres-health.timer every 10s and restarts the service after 5 consecutive failures; the start period becomes the timer's first delay
- data_postgres: secret data_postgres_password was owned by 999:999 in the container; credentials are readable by the service user only, which is what the mode asked for
- data_postgres: volume data_pgdata at /var/lib/data/data_pgdata is created for a DynamicUser= service; StateDirectory= would be the native shape if the path can move under /var/lib/data_postgres
- data_postgres: volume data_pgdata moves by "rsync" (decision storage.move.data_pgdata); the runbook step lands at /var/lib/data/data_pgdata
- data_exporter: member of overlay network data_backend (10.10.2.0/24, local); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- data_exporter: member of macvlan network data_monitoring (192.168.50.128/25, local); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- data_exporter: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides
- data_postgres: member of overlay network data_backend (10.10.2.0/24, local); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it
- web_app: machine web_app joins zone vz-web_frontend with MAC 26:3b:af:b1:00:98 and static lease 10.10.1.2; the guest must run a DHCP client on host0 (systemd-networkd with the shipped 80-container-host0.network) to take the lease
- machines on zone vz-web_frontend are listed at their static lease address; on swarm-wrk-1 their DHCP lease names also resolve under _dhcp through the bridge's LocalLeaseDomain=

## Carried over from the capture

- service web_proxy: image docker.io/library/caddy:2 is not pinned to a digest
- service data_exporter: image quay.io/prometheuscommunity/postgres-exporter:v0.15.0 is not pinned to a digest
- service web_app: task t3 on swarm-mgr-1 is failed (task: non-zero exit (137))
- service web_app: publishes through the ingress routing mesh; systemd hosts publish per host
- network web_frontend: encrypted overlay; cross-host transport must be replaced (see migration-planner/references/networking.md)
- network data_backend: encrypted overlay; cross-host transport must be replaced (see migration-planner/references/networking.md)
- image docker.io/library/postgres:16.4: not present on the capturing node, so its entrypoint, command, and environment are unknown; the rendered ExecStart= needs a review (used by data_postgres)
- image quay.io/prometheuscommunity/postgres-exporter:v0.15.0: not present on the capturing node, so its entrypoint, command, and environment are unknown; the rendered ExecStart= needs a review (used by data_exporter)
