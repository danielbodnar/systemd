---
name: podman-quadlet
description: Render a Swarm inventory into per-host Podman Quadlet units (.container, .network, .volume) plus stack targets, secret import scripts, and install scripts, and explain how each Swarm service-spec field maps onto Quadlet and systemd directives. Use this whenever the user wants to convert Docker Swarm services, stacks, or compose files to systemd units, asks for Quadlet, podman-systemd, or "run this container under systemd", or needs a field-by-field translation of replicas, placement, healthchecks, secrets, configs, overlay networks, published ports, resource limits, or restart policies. Use it after discover-docker-swarm has produced inventory.json and the plan selects Quadlet for the service; if there is no inventory yet, run that skill first.
---

# Swarm to Quadlet

Quadlet is the systemd-native way to run Podman containers: a `.container` file under `/etc/containers/systemd/` is turned into a regular service unit by a generator at daemon-reload time, so the container gets systemd's dependency ordering, restart logic, cgroup accounting, journal integration, and `systemctl` as its management interface. This skill renders those files from the inventory and documents every translation decision, because the value of a migration lies in the decisions rather than the file generation.

## Workflow

1. Confirm `inventory.json` exists and read its `warnings[]`; unresolved warnings become unresolved problems on the new hosts.
2. Decide host assignment. The renderer derives it from placement constraints and the current task placement, and a `host-map.json` (`{"stack_service": ["host-a", "host-b"]}`) overrides it. Prefer an explicit host map for anything stateful.
3. Render:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/podman-quadlet/scripts/render.ts" inventory.json -o rendered \
    --host-map host-map.json --selinux
```

4. Read `rendered/MIGRATION-NOTES.md` in full and walk the user through every item under "needs a human decision". Nothing in that list is safe to skip.
5. Review one rendered unit per stack against `references/field-map.md`, then hand the tree to `systemd-verify` before anything is installed.

Flags: `--scale-out` renders numbered instances when a service wants more replicas than eligible hosts; `--auto-update` adds `AutoUpdate=registry` to units whose image is tag-based; `--selinux` appends volume relabeling suffixes; `--unit-dir` and `--config-dir` change target paths for rootless or non-standard layouts.

## As a component of the compose engine

The same rendering is available per service through the plan: the `quadlet` component (`scripts/component.ts`) is registered in `contract/registry.ts`, so the engine's form decision (`form.service.<name>`) offers `quadlet` next to `service`, `machine`, `vm`, and `portable`. A service that takes it gets its `.container` (and the `.network` and `.volume` files it needs) under the unit directory of the rendered host tree, `<name>.service` in `expected.json` because Podman's generator produces it, a place in the stack target the service component writes, its published ports in `expected.json`, and its secrets in `secrets/import-secrets.sh`; the creds, storage, networkd, resource-control, and journald components leave a Quadlet service alone. The files are the ones `render.ts` writes, through the same functions.

The component raises these estate-level decisions:

| Decision | Kind | Default | Meaning |
|---|---|---|---|
| `quadlet.secrets.estate` | choice | `podman-secret` | Secrets and redacted variables become `Secret=` references created by `import-secrets.sh`. A systemd credential path is not offered because `podman-systemd.unit(5)` documents no way to hand one to the container. |
| `quadlet.auto_update.estate` | choice yes/no | `no` | `AutoUpdate=registry` on tag-based images (the `--auto-update` flag). |
| `quadlet.selinux.estate` | choice yes/no | `no` | Relabel suffixes on bind and config mounts (the `--selinux` flag). |
| `quadlet.unit_dir.estate` | path | `/etc/containers/systemd` | Where the Quadlet files go (the `--unit-dir` flag). |
| `quadlet.config_dir.estate` | path | `/etc/containers/swarm-configs` | Where config payloads go; raised only when the inventory has configs (the `--config-dir` flag). |

Quadlet is Podman's interface rather than a systemd man page, so the component claims no page of the systemd surface and is listed under `adapters` in `contract/coverage.json`.

## Output tree

```
rendered/
  MIGRATION-NOTES.md            decisions, lossy translations, carried warnings
  expected.json                 what systemd-verify checks on each host
  hosts/<hostname>/
    install.sh                  copies units, daemon-reloads, verifies, optionally starts
    etc/containers/systemd/     <service>.container, <network>.network, <volume>.volume
    etc/containers/swarm-configs/  config payloads mounted read-only
    etc/systemd/system/<stack>.target
    secrets/import-secrets.sh   creates Podman secrets from /etc/swarm-migration/secrets (operator-supplied, outside the workspace)
```

Unit names use the full Swarm service name (`web_app.container` becomes `web_app.service`) so two stacks with a service called `db` cannot collide. Each stack gets a `<stack>.target` that wants its units, which gives operators a single `systemctl start web.target`.

## Translation principles

**Replicas become hosts.** Swarm schedules N tasks across a cluster; systemd runs one unit per host. The renderer places one instance on each eligible host, preferring hosts already running the service, and reports when it could not reach the requested count. Running several copies on one host is rarely useful under systemd and is opt-in.

**Ingress becomes per-host publishing.** The routing mesh accepted a published port on every node and forwarded internally. On systemd hosts each unit publishes on its own host only, so the plan must put a load balancer, DNS round robin, or a VIP in front. The renderer flags every ingress-mode port.

**Overlay becomes bridge plus transport.** Podman networks are host-local. The renderer emits a `.network` per host with the original subnet so container addressing and DNS aliases keep working within a host; cross-host traffic needs a routed underlay or WireGuard, which the planning skill designs.

**Secrets never touch the rendered tree.** Swarm secrets become `Secret=name,type=mount,...` references and redacted environment values become `Secret=name,type=env,...`. `secrets/import-secrets.sh` creates them from one file per secret under `/etc/swarm-migration/secrets/`, a root-only directory outside any agent workspace. Configs are non-secret in Swarm and are written out as files with their captured ownership and mode.

**Resource limits use systemd's cgroup properties.** Quadlet defaults to `CgroupsMode=split`, which places the container in the service's cgroup, so `CPUQuota=`, `MemoryMax=`, `MemoryLow=`, and `TasksMax=` in `[Service]` apply directly and remain visible in `systemctl status` and `systemd-cgtop`.

**Health drives restarts.** `HealthCmd=` and friends carry the Swarm healthcheck, `HealthOnFailure=kill` makes an unhealthy container exit so `Restart=` applies, and `Notify=healthy` delays the unit's active state until the first successful check, which is the closest systemd analogue of Swarm's `start_period` semantics.

Read `references/field-map.md` for the complete field table with the reasoning behind each choice, and `references/alternatives.md` for when a workload is better served by `systemd-nspawn`, a portable service, or a plain service unit than by a container at all.

## Files

- `scripts/render.ts`: the renderer; importable (`render(inventory, options)`) and runnable. `renderContainer`, `networkUnit`, `volumeUnit`, `synthesizedVolumeUnit`, and `importScript` are exported for the component.
- `scripts/component.ts`: the `quadlet` component the compose engine runs when the plan chooses the Quadlet form for a service.
- `references/field-map.md`: Swarm service spec to Quadlet and systemd directive mapping, including what is lossy.
- `references/alternatives.md`: non-container targets and when to choose them.
- `references/example-web_app.container`: a rendered unit from the example inventory, kept as a reading aid.
