# Service spec to native unit

One row per field of `Service` in `contract/types.ts`, in the order the type
declares them, with the directives the rendered tree carries for it. A field
that no directive can express has a row saying so, and every such row also
produces a line in `MIGRATION-NOTES.md`. Rows marked with a component name are
rendered by that component into the same unit through the shared render
context; the rest belong to `skills/systemd-service`.

| Inventory field | Directive(s) | Notes |
|---|---|---|
| `id` | nothing | Swarm's own identifier; the unit is named after `name`. |
| `name` | `<name>.service` (`<name>-<n>.service` per instance), `Description=`, `[X-Migration] Service=` | Refused when it is not a plain name, because it reaches unit names and install scripts. |
| `short_name` | nothing | The name without the stack prefix, kept for reports. |
| `stack` | `PartOf=<stack>.target`, `Slice=stack-<stack>.slice`, `<stack>.target` with `Wants=`, `stack-<stack>.slice`, `[X-Migration] Stack=` | The generator component may materialize the target and slice instead of rendering them. |
| `image`, `image_digest` | `RootMStack=<image-dir>/<name>.mstack` (`RootImage=<name>.raw` with `--root-image`), `RequiresMountsFor=` for a DDI, `[X-Migration] Image=`, `ImageDigest=`, `ImageName=` | `<name>` is the last two repository components and the tag (`acme-app_2026.09`); `images.json` lists every name for `pull-images.sh`. |
| `command`, `args` (with `images[].entrypoint`, `images[].cmd`) | `ExecStart=`, `ExecSearchPath=` | Swarm's `command` overrides the entrypoint; otherwise entrypoint plus `args` (or the image's `cmd`). A bare command name resolves through the image's `PATH`. Unknown image: a note and the `/bin/false` placeholder. |
| `env`, `redacted_env` (with `images[].env`) | `Environment=` or `EnvironmentFile=/etc/<stack>/<service>.env` (more than six lines), and, from the creds component, `LoadCredentialEncrypted=` with `<NAME>_FILE=%d/<credential>` for redacted values | The image's variables come first; `PATH` is not copied because `ExecSearchPath=` carries it. |
| `labels` | nothing | Docker's own `com.docker.*` labels are dropped silently; every other label is listed in a note. |
| `container_labels` | nothing | Read for a job's schedule (see `mode`); otherwise a note through `labels`. |
| `mode` (`replicated`, `global`) | one unit per host from the placement, `ConditionHost=` | `global` renders on every eligible host; `replicas` decides the count for `replicated`. |
| `mode` (`replicated-job`, `global-job`) | `Type=oneshot`, `RemainAfterExit=no`, no `Restart=`, no start limit, no health timer; with a schedule, `<service>.timer` (`OnCalendar=`, `Persistent=yes`, `AccuracySec=1s`, `Unit=`) that the stack target wants instead of the service | The schedule is the decision `service.schedule.<service>` (an `OnCalendar` expression, default empty, which runs the job once when the stack target starts). Its default comes from a service label whose last segment is `schedule` or `cron`, translated from crontab syntax where the expression allows. |
| `replicas` | the instance count per host, numbered units with `--scale-out` | Replicas that no eligible host can take are a note on the placement decision. |
| `placement.constraints` | the eligible hosts, `ConditionHost=` | `node.id`, `node.hostname`, `node.role`, `node.platform.*`, `node.labels.*`, and `engine.labels.*` with `==` and `!=`. |
| `placement.preferences` | the order instances are handed to hosts | A spread preference groups the eligible hosts by its descriptor and takes the groups round-robin, hosts the descriptor says nothing about last; several preferences order within each other's groups. Any other preference is a note. |
| `placement.max_replicas_per_node` | the per-host instance cap under `--scale-out` | 0 and absent both mean no cap, as in Swarm. Replicas the cap leaves unplaced are a note that names the cap. |
| `placement.platforms` | the eligible hosts | Matched against each node's OS and architecture, with Docker's architecture names normalized. |
| `networks` | nothing here; the networkd component renders the zone bridge and the resolved component the names | Lossy in this renderer: a native service is in the host's network namespace. A machine form gets its own namespace and an address. |
| `ports` | from the networkd component: `SocketBindAllow=<proto>:<port>`, `SocketBindDeny=any`, or a `.socket` unit, per the `networkd.publish.<service>.<port>` decision | Lossy when the published and container ports differ, and for ingress mode, which has no routing mesh behind it. |
| `mounts[type=volume]` local | from the storage component: `BindPaths=/var/lib/<stack>/<volume>:<target>`, a `tmpfiles.d` `d` line, `RequiresMountsFor=` | A volume the capture did not see is created empty with a note. |
| `mounts[type=volume]` nfs, cifs | from the storage component: `<path>.mount` (`What=`, `Where=`, `Type=`, `Options=`), `RequiresMountsFor=` | `addr=` in the options becomes the server in `What=`. |
| `mounts[type=bind]` | from the storage component: `BindPaths=` or `BindReadOnlyPaths=`; `/dev/*` sources become `DeviceAllow=` under `DevicePolicy=closed` | Propagation other than `rprivate` is lossy. |
| `mounts[type=tmpfs]` | from the storage component: `TemporaryFileSystem=<target>:size=,mode=`; a tmpfs at `/tmp` suppresses `PrivateTmp=` | |
| `secrets` | from the creds component: `LoadCredentialEncrypted=<name>:/etc/credstore.encrypted/<name>`, `BindReadOnlyPaths=%d/<name>:/run/secrets/<target>` | Ownership inside the container is lossy: a credential belongs to the service's user. |
| `configs` | `/etc/<stack>/configs/<name>` with the reference's ownership and mode, `BindReadOnlyPaths=` at the target | The sysext component ships them as a confext instead when `sysext.configs.<stack>` says so. |
| `healthcheck` | `<service>-health.timer` (`OnActiveSec=` the start period, `OnUnitActiveSec=` the interval), `<service>-health.service` (the same root, `ExecStart=`, `TimeoutStartSec=`), `OnFailure=<service>-restart.service`, `Wants=<service>-health.timer` | Equivalent: the retries happen within one timer run rather than across runs. A shell check is the decision `service.healthcheck.<service>`; a job gets no health timer, because a oneshot unit's result is its exit status. |
| `resources.limits` | from the resource-control component: `CPUQuota=`, `MemoryMax=`, `TasksMax=` | |
| `resources.reservations` | from the resource-control component: `MemoryLow=`, `CPUWeight=` | Reservations are soft in both systems. |
| `restart_policy.condition` | `Restart=` (`any` to `always`, `on-failure` to `on-failure`, `none` to `no`) | A job gets no `Restart=`: a failed oneshot unit stays failed until its timer or an operator runs it again, as a Swarm job's task does. |
| `restart_policy.delay` | `RestartSec=` | Sub-second delays keep their precision (`500ms`). |
| `restart_policy.max_attempts` | `[Unit] StartLimitBurst=` | 0 and absent mean Swarm never gives up, so the unit gets `StartLimitIntervalSec=0`, which turns off the rate limit systemd would otherwise apply from `DefaultStartLimitBurst=`. |
| `restart_policy.window` | `[Unit] StartLimitIntervalSec=` | An absent window with a capped count becomes `infinity`, which systemd.unit(5) documents as counting over any interval. The limit counts every start, so the restart `<service>-restart.service` performs after a failed healthcheck counts too, which is how Swarm counted an unhealthy task against `max_attempts`; a note says so on every service where both apply. |
| `update_config` | nothing here | A note; the rollout component renders the per-stack rollout specification and the controller that walks it. |
| `rollback_config` | nothing here | A note; the previous image version stays pullable under its own name in a `.v/` directory. |
| `stop_grace_period` | `TimeoutStopSec=` | Sub-second periods keep their precision. A period of 0 is rendered as 0, which lets the manager reach `SIGKILL` at once as the source did, with a note. |
| `stop_signal` | `KillSignal=`, with `KillMode=mixed` always | A value that is not a signal name is a note, and the unit keeps systemd's default `SIGTERM`. |
| `user` (with `images[].user`) | `User=`, `Group=`, or `DynamicUser=yes` when neither names one | A container that ran as root gets a dynamic user; set `User=` by hand when the workload must own its data. |
| `workdir` (with `images[].workdir`) | `WorkingDirectory=` | |
| `hostname` | `ProtectHostname=private:<hostname>` | The name is set in the service's own UTS namespace: the host keeps its own name and nothing outside the service resolves the new one. A value that is not a host name is a note. |
| `dns` | nothing | Lossy: there is no per-service resolver directive. The resolved component configures each host's resolver; a private resolver needs a machine form. |
| `extra_hosts` | nothing | Lossy: add each entry to the host's `/etc/hosts` or give the resolved component a record for the name. |
| `cap_add`, `cap_drop` | `CapabilityBoundingSet=` (from Docker's default set), `AmbientCapabilities=`, and `NoNewPrivileges=yes` always, because ambient capabilities are raised before exec and the two coexist | |
| `sysctls` | `/etc/sysctl.d/90-<stack>.conf`, and no `ProtectKernelTunables=` | Lossy: the settings apply to the whole host, not to the service alone. |
| `ulimits` | `LimitNOFILE=`, `LimitNPROC=`, and the rest of the `Limit*=` set systemd.exec(5) documents | `soft:hard` when they differ, `infinity` for Docker's -1. A name systemd.exec(5) does not document is a note, never an invented directive. |
| `read_only` | `ProtectSystem=strict` | The whole hierarchy is read-only except the API file systems, which is what Docker's flag does; the bound volumes stay writable. |
| `init` | nothing of its own | When the image's argv already begins with an init this renderer documents (tini, dumb-init, docker-init, catatonit, runit, s6-svscan, supervisord), `ExecStart=` keeps it and a note says which. Otherwise a note: Docker ran its own init from outside the image, and the service manager reaps the orphans it would have reaped. |
| `tty` | nothing | Lossy: a service has no pseudo-terminal. `StandardInput=tty` with `TTYPath=` naming a device on the host is a hand edit. |
| `privileged` | nothing | Lossy: a note, never a directive. The unit carries Docker's default capability set; add what the workload needs to `CapabilityBoundingSet=` and `AmbientCapabilities=`. |
| `logging` | from the journald component: the journal, `SyslogIdentifier=`, `LogExtraFields=SWARM_STACK= SWARM_SERVICE=`, and `LogNamespace=` when the stack chose one | A driver other than the journal is a note. Driver options (`max-size`, `max-file`) become journald's own retention settings, not per-service directives. |
| `endpoint_mode` | nothing here | Evidence for the networkd component's `networkd.publish.<service>.<port>` decision: `vip` means clients reached one address, which becomes one address per host and whichever load-balancing option the decision takes; `dnsrr` means they already resolved a record per task. |
| `tasks` | the default of the `placement.hosts.<service>` decision | The source's own scheduling is the suggestion, never the rule. |

Always rendered on a plain service: `Type=exec` (`oneshot` for a job),
`MountAPIVFS=yes`, `PrivateTmp=yes` (unless a tmpfs is mounted at `/tmp`),
`PrivateDevices=yes` (unless devices are bound), `ProtectProc=invisible`,
`ProtectKernelTunables=yes` (unless sysctls are set), `PrivateUsers=self`,
`NoNewPrivileges=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`,
`KillMode=mixed`, `After=network-online.target`,
`Wants=network-online.target`, `ConditionHost=`, and the `[X-Migration]`
section systemd ignores and the verifier reads.
