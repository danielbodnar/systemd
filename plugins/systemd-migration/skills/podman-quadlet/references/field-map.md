# Swarm service spec to Quadlet field map

The table records how `scripts/render.ts` translates each inventory field, what is lost, and why the target was chosen. Quadlet key names follow `podman-systemd.unit(5)`; systemd keys follow `systemd.service(5)`, `systemd.unit(5)`, and `systemd.resource-control(5)`. Verify key availability against the Podman version on the target host before relying on a newer key such as `Notify=healthy` or `HealthOnFailure=`.

## Identity and image

| Inventory | Rendered | Notes |
|---|---|---|
| `name` | unit file `<name>.container`, `ContainerName=<name>` | Full Swarm name keeps stacks from colliding. |
| `stack` | `Label=io.systemd-dev-plugins.stack=`, `WantedBy=<stack>.target`, `/etc/systemd/system/<stack>.target` | The target is a plain systemd unit, not a Quadlet file. |
| `image`, `image_digest` | `Image=image@digest` when a digest exists, otherwise `Image=image` | With `--auto-update`, tag-based images also get `AutoUpdate=registry` so `podman-auto-update.timer` can roll them. |
| `command` | `Entrypoint=["..."]` | JSON array form preserves arguments with spaces. |
| `args` | `Exec=arg arg` | Quoted with systemd rules. |
| `labels` | `Label=io.systemd-dev-plugins.service=` only | Swarm service labels mostly carry compose and orchestrator metadata (`traefik.*`, `com.docker.*`); copy specific ones by hand if a host-side tool reads them. |
| `container_labels` | `Label=` | Copied verbatim. |

## Scheduling

| Inventory | Rendered | Notes |
|---|---|---|
| `mode: replicated`, `replicas` | one `.container` per chosen host; `--scale-out` adds `<name>-N` instances | Hosts running the service today are preferred; the count is reported in the notes when it falls short. |
| `mode: global` | one `.container` on every eligible host | Direct equivalent. |
| `mode: *-job` | `.container` with `Restart=no` and no `[Install]` | Run with `systemctl start`; pair with a `.timer` for recurring jobs. |
| `placement.constraints` | host selection only | `node.role`, `node.hostname`, `node.id`, `node.labels.*`, `engine.labels.*`, `node.platform.*` with `==` and `!=` are honoured. Unknown keys exclude the node. |
| `placement.preferences` | ignored | Spread preferences have no per-host meaning; the host map is the replacement. |
| `placement.max_replicas_per_node` | caps instances per host in scale-out mode | |
| `tasks[]` | placement hint | Current task nodes rank first among eligible hosts. |
| `update_config`, `rollback_config` | note only | Rolling updates become "install on one host, verify, move on"; the cutover runbook covers ordering. |
| `endpoint_mode` | note only | See networking. |

## Process environment

| Inventory | Rendered | Notes |
|---|---|---|
| `env` (plain) | `Environment=KEY=value` | Values with whitespace are quoted. |
| `env` (redacted) | `Secret=<name>-<key>,type=env,target=KEY` | The secret name is listed in `expected.json` and in `import-secrets.sh`. |
| `user` | `User=` | Podman accepts `uid[:gid]` and names present in the image. |
| `workdir` | `WorkingDir=` | |
| `hostname` | `HostName=` | |
| `init` | `RunInit=true` | |
| `tty` | not rendered | Interactive terminals have no place in a service. |
| `read_only` | `ReadOnly=true` | Podman keeps `/run`, `/tmp`, `/var/tmp` writable via `ReadOnlyTmpfs=` default. |
| `stop_signal`, `stop_grace_period` | `StopSignal=`, `StopTimeout=<seconds>` | Default 10 seconds like Swarm. |

## Storage

| Inventory | Rendered | Notes |
|---|---|---|
| `mounts[type=volume]` known to the inventory | `Volume=<name>.volume:/target[:ro]` plus a `.volume` unit | `VolumeName=` keeps the Swarm name so data copied from the old host lands where the unit expects it. |
| `mounts[type=volume]` unknown | `Volume=<name>:/target` | Podman creates an empty named volume; the notes flag it. |
| `mounts[type=bind]` | `Volume=/src:/target[:ro][,Z or z][,propagation]` | The path must exist on the host; `--selinux` adds relabeling. |
| `mounts[type=tmpfs]` | `Tmpfs=/target:size=,mode=` | |
| `volumes[].driver`, `options` | `Driver=`, `Type=`, `Device=`, `Options=` on the `.volume` | Docker `local` driver options `type`, `device`, `o` map one to one. |
| `configs` | file under `/etc/containers/swarm-configs/<name>` and `Volume=<path>:<target>:ro` | Podman has no config object; the install script sets ownership. |
| `secrets` | `Secret=<name>,type=mount,target=<basename>,uid=,gid=,mode=` | Targets under `/run/secrets/` are passed as bare names, matching Podman's default mount location. |

## Networking

| Inventory | Rendered | Notes |
|---|---|---|
| `networks[]` (overlay) | `Network=<name>.network` and one `.network` per host with `Driver=bridge`, the original `Subnet=`, `Gateway=`, `IPRange=`, `Internal=`, `IPv6=` | Host-local bridges. Cross-host reachability is a planning task. |
| `networks[].aliases`, `short_name` | `NetworkAlias=` | Quadlet applies aliases to every attached network. |
| `ports[]` | `PublishPort=published:target[/proto]` | Ingress and host modes render identically; ingress is flagged. Scale-out instances offset the published port. |
| `dns` | `DNS=`, `DNSSearch=`, `DNSOption=` | |
| `extra_hosts` | `AddHost=host:ip` | Docker stores `ip host`; the renderer reorders. |
| `networks[].encrypted` | note | Replace with WireGuard or an encrypted underlay. |
| ingress network | skipped | It exists only for the routing mesh. |

## Security and limits

| Inventory | Rendered | Notes |
|---|---|---|
| `cap_add`, `cap_drop` | `AddCapability=`, `DropCapability=` | `ALL` is lowercased for Podman. |
| `sysctls` | `Sysctl=` | |
| `ulimits` | `Ulimit=name=soft:hard` | |
| `privileged` | note | Not rendered; the operator decides. |
| `resources.limits.nano_cpus` | `[Service] CPUQuota=N%` | `1.5e9` nano CPUs is `150%`. |
| `resources.limits.memory_bytes` | `[Service] MemoryMax=` | Bytes. |
| `resources.limits.pids` | `[Service] TasksMax=` and `PidsLimit=` | Both so `podman inspect` and `systemctl` agree. |
| `resources.reservations.memory_bytes` | `[Service] MemoryLow=` | Best-effort protection, the nearest systemd concept to a reservation. |
| `resources.reservations.nano_cpus` | `[Service] CPUWeight=` | Reservations become relative weight. |

## Lifecycle

| Inventory | Rendered | Notes |
|---|---|---|
| `restart_policy.condition` | `Restart=always`, `on-failure`, or `no` | |
| `restart_policy.delay` | `RestartSec=` | Default 5 seconds like Swarm. |
| `restart_policy.max_attempts`, `window` | `[Unit] StartLimitBurst=`, `StartLimitIntervalSec=` | systemd stops restarting once the burst is exhausted; `systemctl reset-failed` clears it. |
| `healthcheck` | `HealthCmd=`, `HealthInterval=`, `HealthTimeout=`, `HealthRetries=`, `HealthStartPeriod=`, `HealthOnFailure=kill`, `Notify=healthy` | `kill` turns unhealthy into a unit failure so `Restart=` engages; `Notify=healthy` makes `systemctl start` wait for the first passing check. |
| `logging` | `LogDriver=journald` | Journald keeps logs queryable with `journalctl -u`; other drivers are flagged. |
| always | `TimeoutStartSec=900` | Image pulls on first start need more than the 90 second default. |
| always | `Wants=network-online.target`, `After=network-online.target` | Quadlet adds `network-online` ordering itself on recent versions; the explicit lines cost nothing on older ones. |

## Not represented

Swarm features with no per-host meaning are not rendered and are called out in the notes when present: routing mesh semantics, VIP-based service discovery across hosts, encrypted overlay transport, spread preferences, rolling update ordering, and node-level drain and availability. The `migration-planner` skill owns their replacements.
