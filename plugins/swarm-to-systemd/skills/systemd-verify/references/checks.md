# Verification checks

## Dry-run mode

| Check | Command | Meaning of failure |
|---|---|---|
| `unit-file` | file test for each `<unit>.container` in the units directory | The rendered tree for this host is incomplete or the wrong host's tree was copied. |
| `quadlet-generator` | `QUADLET_UNIT_DIRS=<dir> podman-system-generator --dryrun` | A unit uses a key the installed Podman does not know, or has a syntax error; the generator names the file and key. |
| `systemd-analyze` | `systemd-analyze verify <generated unit>` | The generated service fails verification: a bad directive, a missing dependency, or an ordering cycle. A target that lives on another host is not referenced from the unit itself, so this is a real problem to fix in the rendered tree. |
| `podman` | `podman --version` | Podman is missing; nothing else can work. |
| `secret` | `podman secret exists <name>` | Reported as a warning before install because secrets are imported in the cutover step. |

The generator path differs by distribution: `/usr/lib/systemd/system-generators/podman-system-generator` on Fedora and Arch, `/usr/libexec/podman/quadlet` on some Debian builds. The script tries both.

## Live mode

| Check | Command | Meaning of failure |
|---|---|---|
| `unit-active` | `systemctl is-active <unit>` | Unit failed or never started; `systemctl status` and `journalctl -u` explain why. |
| `container-exists`, `container-health` | `podman inspect --format '{{.State.Health.Status}}'` | Container missing, unhealthy, or still within `HealthStartPeriod=`. |
| `port-listening` | `ss -ltunH` | Nothing bound the expected port on this host. |
| `network`, `volume`, `secret` | `podman <kind> exists <name>` | The `.network` or `.volume` unit did not create its object, or the secret was never imported. |
| `restart-loop` | `systemctl show -p NRestarts` | More than three restarts since the unit started; the container is crashing. |

## Podman version requirements for rendered keys

The renderer emits keys from recent Quadlet releases. Confirm the target host's `podman --version` supports them, or edit the rendered units:

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
