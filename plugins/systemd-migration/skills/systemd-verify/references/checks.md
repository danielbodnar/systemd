# Verification checks

The engine is chosen from the host's entry in `expected.json`: an entry with containers and no `root_kind` comes from the standalone Quadlet renderer and is a Quadlet tree; an entry from the render driver (it always carries `root_kind`) is checked by the native engine, which also covers the Quadlet containers the plan placed on that host. `--engine` overrides the choice.

## Native engine, dry-run

| Check | Command | Meaning of failure |
|---|---|---|
| `unit-file` | file test for every name under `units`, `targets`, `slices`, `timers`, `mounts`, `sockets` | The rendered tree for this host is incomplete or the wrong host's tree was copied. |
| `machine-file` | file test for `etc/systemd/nspawn/<machine>.nspawn` | The machine form was decided for a service but its settings file is missing from the tree. |
| `quadlet-file` | file test for `etc/containers/systemd/<name>.container` when a unit under `units` has no unit file | A service the plan gave the Quadlet form; Podman's generator produces its `.service`. |
| `quadlet-generator` | `QUADLET_UNIT_DIRS=<tree>/containers/systemd podman-system-generator --dryrun`, when the tree has `.container` files | A key the installed Podman does not know, or a syntax error; a warning when Podman is not installed on the host running the dry-run. |
| `systemd-analyze` | `systemd-analyze --root=<tmp> verify --recursive-errors=no <units>` over a copy of the tree with a stub for every `Exec*=` command | A directive the host's systemd does not know, a missing dependency, or an ordering cycle. The detail carries every line the manager printed, with the temporary prefix stripped. |
| `image` | file test for each path under `images` | Warning: the image is not pulled yet; `pull-images.sh` does that before `install.sh`. |
| `credential` | file test in `/etc/credstore.encrypted` and `/etc/credstore` | Warning: `secrets/import-credentials.sh` has not run on this host. |
| `volume` | directory test for each path under `volumes` | Warning: the data has not been moved yet; `install.sh` creates the directory through tmpfiles. |
| `install-script` | `bash -n install.sh` | The install script does not parse; the render is broken. |

## Native engine, live

| Check | Command | Meaning of failure |
|---|---|---|
| `unit-active` | `systemctl is-active <unit>` for units, targets, slices, timers, mounts, sockets | Unit failed or never started; `systemctl status` and `journalctl -u` explain why. |
| `unit-result` | `systemctl show -p Result` for `*-health.service` and `*-restart.service` | The last healthcheck run failed, or the restart unit ran and failed. These oneshot units are inactive between timer runs, so their result is what is checked. |
| `machine-running` | `machinectl show -p State <machine>` | The container is not registered or not running; `journalctl -u systemd-nspawn@<machine>` explains why. |
| `container-exists`, `container-health` | `podman inspect` for each name under `containers` | A Quadlet container the plan placed on this host is missing, unhealthy, or still within its start period. |
| `secret` | `podman secret exists` for each name under `secrets` | `import-secrets.sh` was not run on this host. |
| `network-file` | file test in `/etc/systemd/network` for each `.network` or `.netdev` basename under `networks` | A rendered zone bridge, transport, or macvlan file was not installed. |
| `port-listening` | `ss -ltunH` | Nothing bound the expected port on this host. |
| `credential` | file test in the credential stores | The credential was never imported, or was removed. |
| `volume` | directory test | The volume directory is missing. |
| `restart-loop` | `systemctl show -p NRestarts` | More than three restarts since the unit started; the workload is crashing. |

Whether networkd accepted the installed files (bridges, overlays, leases) is the networkd subtest's job and `networkctl status` on the host; this script checks only that the files are in place.

## Quadlet engine, dry-run

| Check | Command | Meaning of failure |
|---|---|---|
| `unit-file` | file test for each `<unit>.container` in the units directory | The rendered tree for this host is incomplete or the wrong host's tree was copied. |
| `quadlet-generator` | `QUADLET_UNIT_DIRS=<dir> podman-system-generator --dryrun` | A unit uses a key the installed Podman does not know, or has a syntax error; the generator names the file and key. |
| `systemd-analyze` | `systemd-analyze verify <generated unit>` | The generated service fails verification: a bad directive, a missing dependency, or an ordering cycle. |
| `podman` | `podman --version` | Podman is missing; nothing else can work. |
| `secret` | `podman secret exists <name>` | Reported as a warning before install because secrets are imported in the cutover step. |

The generator path differs by distribution: `/usr/lib/systemd/system-generators/podman-system-generator` on Fedora and Arch, `/usr/libexec/podman/quadlet` on some Debian builds. The script tries both.

## Quadlet engine, live

| Check | Command | Meaning of failure |
|---|---|---|
| `unit-active` | `systemctl is-active <unit>` | Unit failed or never started; `systemctl status` and `journalctl -u` explain why. |
| `container-exists`, `container-health` | `podman inspect --format '{{.State.Health.Status}}'` | Container missing, unhealthy, or still within `HealthStartPeriod=`. |
| `port-listening` | `ss -ltunH` | Nothing bound the expected port on this host. |
| `network`, `volume`, `secret` | `podman <kind> exists <name>` | The `.network` or `.volume` unit did not create its object, or the secret was never imported. |
| `restart-loop` | `systemctl show -p NRestarts` | More than three restarts since the unit started; the container is crashing. |

## Podman version requirements for rendered keys

The Quadlet renderer emits keys from recent Quadlet releases. Confirm the target host's `podman --version` supports them, or edit the rendered units:

| Key | Available since | Fallback |
|---|---|---|
| `HealthOnFailure=` | Podman 4.4 | remove; unhealthy containers stay running |
| `Notify=healthy` | Podman 4.9 | `Notify=false`; systemd considers the unit active as soon as the container starts |
| `Secret=...,type=env` | Podman 4.5 | mount the secret as a file and read it from the entrypoint |
| `Tmpfs=`, `Sysctl=`, `Ulimit=`, `AddHost=`, `DNS*=` | Podman 4.6 | `PodmanArgs=--tmpfs ...` and friends |
| `NetworkAlias=` | Podman 4.7 | `PodmanArgs=--network-alias` |
| `.network`, `.volume` units | Podman 4.4 | create networks and volumes with `podman network create` in a oneshot unit |
| `StopTimeout=`, `StopSignal=` | Podman 4.7 | `PodmanArgs=--stop-timeout` |
| `[Quadlet] DefaultDependencies=` | Podman 5.1 | not emitted by the renderer |

Rootless installs put units under `~/.config/containers/systemd/`; pass `--unit-dir` to the renderer and run `verify.sh --units` against that path with `systemctl --user` (the script uses the system manager; adapt the `systemctl` calls or run as the service user with `XDG_RUNTIME_DIR` set).
