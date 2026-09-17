# Service spec to native unit

One row per inventory field the renderer reads. "Lossy" names what the unit cannot express; every lossy row also produces a line in `MIGRATION-NOTES.md`.

| Inventory field | Directive(s) | Notes |
|---|---|---|
| `image`, `image_digest` | `RootMStack=<image-dir>/<name>.mstack` (`RootImage=<name>.raw` with `--root-image`), `[X-Migration] Image=`, `ImageDigest=`, `ImageName=` | `<name>` is the last two repository components and the tag (`acme-app_2026.09`); `images.json` lists every name for `pull-images.sh`. |
| `command`, `args`, `images[].entrypoint`, `images[].cmd` | `ExecStart=`, `ExecSearchPath=` | Swarm's `command` overrides the entrypoint; otherwise entrypoint plus `args` (or the image's `cmd`). A bare command name resolves through the image's `PATH`. Unknown image: note and a placeholder. |
| `env`, `redacted_env`, `images[].env` | `Environment=` or `EnvironmentFile=/etc/<stack>/<service>.env` (more than six lines), `LoadCredentialEncrypted=` plus `<NAME>_FILE=%d/<credential>` for redacted values | The image's variables come first; `PATH` is not copied. |
| `workdir`, `images[].workdir` | `WorkingDirectory=` | |
| `user`, `images[].user` | `User=`, `Group=`, or `DynamicUser=yes` when none | A container that ran as root gets a dynamic user; set `User=` by hand when the workload must own its data. |
| `mode`, `replicas`, `placement`, `tasks` | one unit per host from the placement, `ConditionHost=`, numbered units with `--scale-out` | Replicas beyond the eligible hosts are a note. |
| `stack` | `PartOf=<stack>.target`, `Slice=stack-<stack>.slice`, `<stack>.target` with `Wants=`, `stack-<stack>.slice` | |
| `restart_policy` | `Restart=` (`any` → `always`, `on-failure`, `none` → `no`), `RestartSec=`, `StartLimitBurst=`, `StartLimitIntervalSec=` | Jobs (`*-job` modes) are `Type=oneshot` without `Restart=`. |
| `stop_grace_period`, `stop_signal` | `TimeoutStopSec=`, `KillSignal=`, `KillMode=mixed` | |
| `healthcheck` | `<service>-health.timer` (`OnActiveSec=` start period, `OnUnitActiveSec=` interval), `<service>-health.service` (same root, `ExecStart=/bin/sh -c` with the retries, `TimeoutStartSec=`), `OnFailure=<service>-restart.service` | Equivalent: retries happen within one timer run rather than across runs. |
| `resources.limits` | `CPUQuota=`, `MemoryMax=`, `TasksMax=` | |
| `resources.reservations` | `MemoryLow=`, `CPUWeight=` | Reservations are soft in both systems. |
| `cap_add`, `cap_drop` | `CapabilityBoundingSet=` (from Docker's default set), `AmbientCapabilities=`, `NoNewPrivileges=yes` when nothing is added | `privileged` is lossy: a note, never a directive. |
| `ulimits` | `LimitNOFILE=`, `LimitNPROC=`, and so on | `soft:hard` when they differ. |
| `sysctls` | `/etc/sysctl.d/90-<stack>.conf`, no `ProtectKernelTunables=` | Lossy: sysctls apply to the whole host. |
| `read_only` | `ProtectSystem=strict` | |
| `init` | nothing | systemd reaps the service's children; no stub init is needed. |
| `mounts[type=volume]` local | `BindPaths=/var/lib/<stack>/<volume>:<target>`, `tmpfiles.d` `d` line, `RequiresMountsFor=` | Not inventoried volumes are created empty with a note. |
| `mounts[type=volume]` nfs, cifs | `<path>.mount` (`What=`, `Where=`, `Type=`, `Options=`), `RequiresMountsFor=` | `addr=` in the options becomes the server in `What=`. |
| `mounts[type=bind]` | `BindPaths=` or `BindReadOnlyPaths=`; `/dev/*` sources become `DeviceAllow=` under `DevicePolicy=closed` | Propagation other than `rprivate` is lossy. |
| `mounts[type=tmpfs]` | `TemporaryFileSystem=<target>:size=,mode=` | |
| `secrets` | `LoadCredentialEncrypted=<name>:/etc/credstore.encrypted/<name>`, `BindReadOnlyPaths=%d/<name>:/run/secrets/<target>` | Ownership inside the container is lossy: credentials belong to the service user. |
| `configs` | `/etc/<stack>/configs/<name>` with ownership and mode from the reference, `BindReadOnlyPaths=` at the target | |
| `ports` | `SocketBindAllow=<proto>:<port>`, `SocketBindDeny=any` | Lossy when published and container ports differ, and for ingress mode (no routing mesh). |
| `networks`, `endpoint_mode`, `hostname`, `dns`, `extra_hosts` | nothing | Lossy in this renderer: the service is in the host namespace. `docker-network-to-networkd` and `docker-container-to-nspawn` cover them. |
| `logging` | journal, `SyslogIdentifier=`, `LogExtraFields=SWARM_STACK= SWARM_SERVICE=` | Driver options are lossy. |
| `update_config`, `rollback_config` | nothing | Runbook steps; image versions under a `.v/` directory make rollback a rename. |
| `labels`, `container_labels` | nothing | Noted when present. |

Always rendered: `Type=exec`, `MountAPIVFS=yes`, `PrivateTmp=yes` (unless a tmpfs is mounted at `/tmp`), `PrivateDevices=yes` (unless devices are bound), `ProtectProc=invisible`, `ProtectKernelTunables=yes` (unless sysctls are set), `PrivateUsers=self`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `After=network-online.target`, `Wants=network-online.target`.
