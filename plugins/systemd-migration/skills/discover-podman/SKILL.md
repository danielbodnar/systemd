---
name: discover-podman
description: Capture a Podman host (its containers, pods, networks, volumes, secret names, images, and existing Quadlet files) into raw inspect output and a normalized, schema-validated inventory.json, the same contract discover-docker-swarm writes. Use this whenever the user wants to inventory, audit, snapshot, or document what runs under Podman, mentions podman ps, podman pod inspect, podman-compose, rootless containers, or existing Quadlet units, or wants to move Podman containers onto plain systemd services, machines, or a cleaner Quadlet layout. Run it before any planning or rendering step, even when the user only asks for the migration itself, because every later step reads the inventory this skill produces.
---

# Podman capture

This skill is the Podman adapter. It mirrors `discover-docker-swarm`: a read-only capture records exactly what Podman reports, and a normalization pass turns those records into the shared inventory shape (`contract/inventory-schema.json`) that the planner and every component read. The raw capture stays next to the inventory as evidence.

A Podman host has no cluster, so the inventory it yields is small in some places by design: one node (the host), one instance per container, and no scheduling constraints. What it does carry is everything the container runtime knows about each workload, which is what the systemd components need.

## When to run what

1. **On the Podman host**, run `scripts/capture.sh`. It needs the `podman` CLI and `jq`, runs as whichever user owns the containers (rootful containers need root, rootless ones the owning user), and never modifies anything: every Podman call passes through a wrapper that refuses any verb other than listing and inspection. Copy the resulting directory off the host.
2. **Anywhere with Bun installed**, run `scripts/normalize.ts` on that directory to produce `inventory.json`. The normalizer redacts environment values the same way the Docker adapter does, links containers to pods, networks, volumes, and secrets, validates the result against the published schema, and writes it.
3. Hand `inventory.json` to `migration-planner` (planning) and the render driver. The plan decides per service whether it becomes a plain service, a machine, or stays a Quadlet container through the `podman-quadlet` component.

```bash
# on the Podman host
bash "${CLAUDE_PLUGIN_ROOT}/skills/discover-podman/scripts/capture.sh" -o /tmp/migrate-discover

# on the operator machine
bun "${CLAUDE_PLUGIN_ROOT}/skills/discover-podman/scripts/normalize.ts" ./migrate-discover -o ./inventory.json
```

`-c NAME` captures through a `podman --connection` remote instead of the local service. `--no-quadlet` skips copying the existing Quadlet files.

## What is captured

| File | Command | Notes |
|---|---|---|
| `raw/info.json`, `raw/version.json` | `podman info`, `podman version` | Host name, architecture, CPUs, memory, cgroup version, rootless flag, engine version. |
| `raw/containers.ls.json`, `raw/containers.json` | `podman ps -a`, `podman container inspect` | Every container including stopped ones and pod infra containers. `Config.Env` and `Config.CreateCommand` are redacted before the file is written. |
| `raw/pods.ls.json`, `raw/pods.json` | `podman pod ps`, `podman pod inspect` | Membership, shared namespaces, the infra container id. |
| `raw/networks.json`, `raw/volumes.json` | `podman network inspect`, `podman volume inspect` | Subnets, gateways, drivers, labels, mount points. |
| `raw/secrets.json` | `podman secret ls` | Names, ids, and drivers only. `podman secret inspect` is refused because it accepts `--showsecret`. |
| `raw/images.json` | `podman image inspect` | Entrypoint, command, environment, working directory, user, and digest of every image a container uses, redacted like the containers. |
| `quadlet/` | file copy | Existing `.container`, `.pod`, `.network`, `.volume`, `.kube`, `.image`, `.build` files and drop-ins from `/etc/containers/systemd`, `/usr/share/containers/systemd`, and `~/.config/containers/systemd`, with secret-looking `Environment=` lines redacted. They are evidence, not input: the normalizer lists them in `warnings[]` and does not parse them. |

## How the inventory is filled

- `cluster`: one manager (this host), no workers, `is_leader` true, `engine_version` from `podman info`.
- `nodes[]`: the host, `ready` and `active`, with CPUs and memory from `podman info` and `podman.rootless` and `podman.cgroup_version` as engine labels.
- `stacks[]`: one per pod, holding its member containers; containers outside a pod have `stack: null`.
- `services[]`: one per container (infra containers are skipped), `mode: replicated` with one replica and one task on this host. The name is the container name and `short_name` strips a `<pod>-` or `<pod>_` prefix. Image and digest come from `ImageName` and the image's `RepoDigests`; `command` and `args` are the container's entrypoint and command where they differ from the image's (a changed entrypoint keeps both, because `--entrypoint` clears the image's command). Environment drops Podman's injected `container` and `HOSTNAME` and every variable identical to the image's, then redacts the rest like the Docker adapter. Labels split into `labels` (compose, Podman, and `PODMAN_SYSTEMD_UNIT` bookkeeping) and `container_labels` (the workload's own; image labels under `org.opencontainers.*` are dropped). Networks and aliases, published ports (mode `host`), mounts, healthcheck, restart policy, resources, user, working directory, DNS, extra hosts, capabilities, ulimits, read-only root, init, tty, privileged, and logging map field by field from `HostConfig` and `Config`.
- Pod members share the infra container's network: their networks come from it, and each published port is assigned to the member whose image exposes it, else to the first member, with a warning.
- Secrets: Podman's inspect output does not list a container's secrets, so they are recovered from `Config.CreateCommand` (`--secret name,type=mount,target=...` becomes a `secrets[]` entry; `type=env` marks the variable redacted, and the renderers then name the secret `<service>-<variable>`). `--sysctl` is recovered the same way. A container created without a recorded command gets a warning instead.
- `networks[]`, `volumes[]`, `secrets[]`: definitions with `used_by`. The default `podman` network is left out, and containers attached only to it are flagged. `configs[]` is always empty: Podman has no config object.
- `images[]`: from `raw/images.json`, through the same helper as the Docker adapter.

## Not yet covered

These are recorded as warnings when present rather than mapped, so nothing is lost silently:

- `host`, `none`, `slirp4netns`, and `pasta` network modes; a network's DHCP lease range (the whole subnet is used).
- Pods that share `ipc`, `pid`, or `uts` beyond the network namespace; systemd services do not share those.
- Devices, `--security-opt`, `--group-add`, user namespaces, custom cgroup parents, and CPU shares.
- Containers with no restart policy (their systemd unit would not restart) and containers that are not running.
- Kubernetes YAML run through `podman kube play`: its containers are captured like any others, but the `.kube` file itself is only copied.

## Files

- `scripts/capture.sh`: read-only capture on the Podman host; requires `podman` and `jq`. Produces `raw/*.json`, `quadlet/`, and `manifest.json`, owner-only.
- `scripts/normalize.ts`: Bun script, no dependencies; converts a capture directory into `inventory.json` and validates it against `contract/inventory-schema.json` before writing.
- `../discover-docker-swarm/scripts/normalize.ts`: the redaction, healthcheck, label, image, and stack helpers this adapter reuses, so both adapters redact identically.
- `../../harness/fixtures/podman-capture/`: a small capture of one pod with two containers, a network, a volume, and a secret, used by the harness test and useful as a template.
