---
name: swarm-capture
description: Capture a running Docker Swarm cluster (nodes, stacks, services, tasks, overlay networks, volumes, secrets, configs) into raw inspect output and a normalized, schema-validated inventory.json. Use this whenever the user wants to inventory, audit, snapshot, export, or document a Swarm estate, asks "what is running on the swarm", mentions docker stack ls, docker service inspect, or wants a starting point for moving Swarm workloads to systemd, Podman, Quadlet, or Kubernetes. Run it before any planning or rendering step, even when the user only asks for the migration itself, because every later step reads the inventory this skill produces.
---

# Swarm capture

A migration is only as trustworthy as the inventory it starts from, so this skill separates two concerns: an unopinionated capture that records exactly what the Docker API reports, and a normalization pass that turns those records into a stable, documented shape. The raw capture is kept forever as evidence; the inventory is what every other skill in this plugin reads.

## When to run what

1. **On a manager node**, run `scripts/capture.sh`. It only needs the `docker` CLI and a manager socket; it never modifies the cluster. Copy the resulting directory off the host.
2. **Anywhere with Bun installed**, run `scripts/normalize.ts` on that directory to produce `inventory.json`. The normalizer redacts environment values whose names or values look credential-bearing, converts Docker's nanosecond durations into systemd-style strings, links volumes, secrets, and configs to the services that use them, and validates the result against the published schema before writing it.
3. Hand `inventory.json` to `swarm-to-quadlet` (rendering) and `systemd-migration-plan` (planning). Keep the raw directory next to it; reviewers will want to check a rendered unit against the original inspect output.

```bash
# on a manager node
bash "${CLAUDE_PLUGIN_ROOT}/skills/swarm-capture/scripts/capture.sh" -o /tmp/swarm-capture --compose-dir /srv/stacks

# on the operator machine
bun "${CLAUDE_PLUGIN_ROOT}/skills/swarm-capture/scripts/normalize.ts" ./swarm-capture -o ./inventory.json
```

If the user works from a project directory, write both outputs under the plugin's configured inventory directory (default `.swarm-migration/`) so later commands find them without being told where to look.

## What the inventory contains

The schema lives in `references/inventory-schema.json` (JSON Schema 2020-12) and is the contract between skills. Read it when you need a field's exact name or type; the summary is:

- `cluster`: engine version, manager and worker counts, and whether the capturing node is the leader.
- `nodes[]`: hostname, role, availability, labels, engine labels, platform, and resources. Placement decisions later depend on labels, so the capture keeps every label verbatim.
- `stacks[]`: stack names and the services each one owns, recovered from the `com.docker.stack.namespace` label.
- `services[]`: the full service spec flattened to one level: image, command, environment, mode and replica count, placement constraints and preferences, networks with aliases, published ports with their publish mode, mounts, secrets, configs, healthcheck, resource limits and reservations, restart and update policy, and the observed task placement (which node each task runs on right now).
- `networks[]`, `volumes[]`, `secrets[]`, `configs[]`: definitions plus a `used_by` list. Swarm secret values are never captured, environment values that look like credentials are redacted at capture and again at normalization, and config payloads are captured because Swarm defines them as non-sensitive. Volumes are listed for the capturing node only; mounts that reference a volume absent from the list are flagged.

Two fields matter more than the rest for migration and deserve a second look after every capture. `services[].tasks[]` records where replicas actually run, which is the best evidence for which host should own a unit. `services[].ports[].mode` distinguishes `ingress` (the routing mesh, which systemd hosts do not have) from `host` (a plain published port, which maps directly).

## Reading the output critically

Do not treat a clean capture as a clean estate. Look for these signs and report them to the user before planning:

- Services whose tasks are in `failed` or `rejected` state; migrating a broken service faithfully reproduces the breakage.
- Images referenced by mutable tags without a digest. The inventory records `image_digest` when Swarm pinned one; if it is absent, the rendered unit will pull whatever the tag resolves to on the new host.
- Environment values that were redacted. The normalizer redacts names matching password, secret, token, key, credential, and similar; the migrated units will need those values supplied through Podman secrets or systemd credentials rather than copied from the capture.
- Bind mounts to paths that only exist on specific nodes, and `local` volumes with driver options that reference NFS or device paths. Both pin a service to a host in ways the placement constraints may not express.
- Overlay networks with `encrypted: true`. Podman networks are host-local, so cross-host traffic will need a WireGuard or similar transport; the planning skill covers this.

## Files

- `scripts/capture.sh`: read-only capture on a manager node; requires `docker` and `jq` (for redaction). Produces `raw/*.json` and `manifest.json`.
- `scripts/normalize.ts`: Bun script, no dependencies; converts a capture directory into `inventory.json` and validates the required structure before writing.
- `references/inventory-schema.json`: the inventory contract.
- `references/field-notes.md`: where each inventory field comes from in the Docker API, and the conversions applied. Read it when a value looks surprising.
- `references/example-inventory.json`: a small two-node, two-stack inventory used by the plugin's tests and useful as a template when the user has no cluster access yet.
