---
name: docker-image-to-service
description: Render a Swarm or Compose inventory into native systemd service units that run each container image as the service's root with RootMStack= (or RootImage=), with no container runtime: per-host .service units, stack targets and slices, health timers, encrypted credentials for secrets, mount units for network volumes, tmpfiles for local volumes, sysctl fragments, config files, and install scripts. Use this whenever the user wants containers as plain systemd services, asks for RootMStack=, RootImage=, "run this image without Docker or Podman", systemd credentials for container secrets, or a field-by-field translation of a service spec into systemd.exec, systemd.service, and systemd.resource-control directives. Use it after docker-swarm-to-inventory has produced inventory.json and, ideally, after the planner's translation map; run those first if they are missing.
---

# Docker image to native service

A container is a process tree with a private root file system, a few namespaces, and a cgroup. systemd provides each of those to a service directly: `RootMStack=` mounts the pulled image (its mount stack) as the root, `MountAPIVFS=` supplies the API file systems, `BindPaths=` and `BindReadOnlyPaths=` bring in volumes, configs, and credentials, `PrivateUsers=self` gives the process its own user namespace, and the `[Service]` resource and sandboxing directives take the place of the runtime's flags. This skill renders that shape from the inventory and documents every decision it could not make faithfully.

## Workflow

1. Confirm `inventory.json` exists and read its `warnings[]`. Images the capture could not inspect leave the entrypoint unknown; the renderer says so per service.
2. Build the translation map (`docker-to-systemd-planner`) if it does not exist yet, and read its "needs a human decision" section: ingress ports, cross-host overlays, and privileged services need answers before the units are right.
3. Render:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/docker-image-to-service/scripts/render.ts" inventory.json -o rendered-native \
    --host-map host-map.json
```

4. Read `rendered-native/MIGRATION-NOTES.md` in full and walk the user through every item under "needs a human decision".
5. Pull the images on each host with the `oci-image-to-mstack` skill (`pull-images.sh rendered-native/images.json`), fill `/etc/swarm-migration/secrets/` and run `secrets/import-credentials.sh`, then `install.sh` from the host's directory. Verify with the `systemd-migration-verify` skill before starting anything.

Flags: `--host-map FILE` overrides placement (`{"service": ["host-a"]}`); `--scale-out` renders numbered instances when a service wants more replicas than eligible hosts; `--root-image` writes `RootImage=NAME.raw` for hosts without mount stacks (build the images with `oci-image-to-ddi`); `--image-dir` and `--state-dir` change where images and volumes live on the hosts.

## Output tree

```
rendered-native/
  MIGRATION-NOTES.md            decisions, translations to review, carried warnings
  images.json                   local image name -> reference, digest, hosts; input to pull-images.sh
  expected.json                 what systemd-migration-verify checks on each host
  hosts/<hostname>/
    install.sh                  copies etc/ into place, applies modes, daemon-reload, verify, optionally --start
    secrets/import-credentials.sh   systemd-creds encrypt from /etc/swarm-migration/secrets (operator-supplied)
    expected.json               this host's units, timers, mounts, ports, credentials, images
    etc/systemd/system/         <service>.service, <stack>.target, stack-<stack>.slice,
                                <service>-health.service and .timer, <service>-restart.service, <path>.mount
    etc/<stack>/configs/<name>  config payloads (ownership and mode applied by install.sh)
    etc/<stack>/<service>.env   long environments, mode 0600
    etc/tmpfiles.d/<stack>.conf local volume directories
    etc/sysctl.d/90-<stack>.conf sysctls the services set (host-wide)
```

Every unit carries an `[X-Migration]` section with the stack, service, image reference, digest, and local image name, which systemd ignores and the verifier reads.

## Translation principles

**The image is the root, the host is the kernel.** `RootMStack=/var/lib/machines/<name>.mstack` mounts the image as pulled by `importctl pull-oci`; nothing is unpacked. The image's entrypoint, command, working directory, and user come from the inventory's `images[]` (recorded by the capture where the image was present) or from the service spec's overrides; `ExecSearchPath=` carries the image's `PATH` so a bare command name resolves inside the image.

**Secrets are credentials.** Each Swarm secret becomes `LoadCredentialEncrypted=name:/etc/credstore.encrypted/name`, and the file is also bound where the container saw it (`/run/secrets/<target>`) through `BindReadOnlyPaths=%d/name:...`. Environment values the capture redacted become credentials too, exposed as `<NAME>_FILE=%d/<credential>`. Values never touch the rendered tree; `import-credentials.sh` encrypts them from files the operator places.

**Volumes are directories or mounts.** A local volume is `/var/lib/<stack>/<volume>`, created by a `tmpfiles.d` line with the service's owner and bound at the container path; a volume with a network driver becomes a `.mount` unit that the service `RequiresMountsFor=`. Bind mounts keep their source; a tmpfs becomes `TemporaryFileSystem=`.

**Ports are what the process opens.** A native service shares the host's network namespace, so it listens on the port the process binds; `SocketBindAllow=` and `SocketBindDeny=any` restrict it to the published set. A published port that differs from the container port is a note, as are ingress-mode ports, which have no routing mesh behind them.

**Health is a timer.** `<service>-health.timer` runs the healthcheck command in the same root at the Swarm interval, after the start period; after the configured retries fail, `OnFailure=` restarts the service. An application that speaks `sd_notify(3)` should use `WatchdogSec=` instead, which is a hand edit.

**Resources and security are directives.** Limits and reservations become `CPUQuota=`, `MemoryMax=`, `MemoryLow=`, `TasksMax=`; ulimits become `Limit*=`; `cap_add` and `cap_drop` become `CapabilityBoundingSet=` and `AmbientCapabilities=` starting from Docker's default set; `privileged` is never rendered. `read_only` becomes `ProtectSystem=strict`.

**Networks are the next phase.** Overlay networks, aliases, and VIPs are not rendered here: the services share the host namespace and reach each other by host address, which the notes say per service. `docker-network-to-networkd` renders zone bridges and cross-host transport; an nspawn machine (`docker-container-to-nspawn`) is the target when a private network namespace is required.

Read `references/directive-map.md` for the complete field table and `references/example-web_app.service` for a rendered unit from the fixture estate.

## Files

- `scripts/render.ts`: the renderer; importable (`render(inventory, options)`, `capabilitySet`, `commandLine`) and runnable.
- `references/directive-map.md`: service spec field to directive, with what is lossy.
- `references/example-web_app.service`: a rendered unit, kept as a reading aid.
