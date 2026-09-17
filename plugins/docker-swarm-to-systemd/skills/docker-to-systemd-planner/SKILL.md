---
name: docker-to-systemd-planner
description: Produce the migration plan for moving a multi-node, multi-stack Docker Swarm estate onto systemd-native hosts running Podman Quadlet units. Use this whenever the user asks how to migrate, decommission, or replace Docker Swarm, wants a cutover plan, runbook, rollback plan, host mapping, or risk assessment, or asks what to do about overlay networks, the ingress routing mesh, Swarm secrets, volumes, or service discovery on systemd. Also use it when a rendered unit tree exists and the user asks "what now" or "how do we switch over". It reads inventory.json and the rendered MIGRATION-NOTES.md and writes a plan document; it does not touch hosts.
---

# systemd migration plan

Rendering units is mechanical; deciding the order in which stacks move, how hosts talk to each other once the overlay is gone, where secrets come from, and how to get back if the cutover fails is not. This skill turns the inventory and the renderer's notes into a plan a team can execute and audit. The plan is a document, written to the inventory directory as `MIGRATION-PLAN.md`, and its structure is fixed by `references/plan-template.md` so that plans for different estates are comparable.

## Inputs

- `inventory.json` from `docker-swarm-to-inventory` (required).
- `rendered/MIGRATION-NOTES.md` and `rendered/expected.json` from `podman-container-to-quadlet` (strongly recommended; plan without them only when the user asks for an early estimate).
- Answers from the user to the questions in "What to ask" below. Do not invent them.

## What to ask

Ask these before writing, in one message, and record the answers in the plan's "Decisions" section:

1. Which hosts survive the migration, which are new, and whether the same machines will be reinstalled or new ones provisioned. Podman and Docker Swarm can coexist on a host during a dual-run, but disk and port contention must be planned.
2. Whether cross-host service traffic exists today (read `networks[].used_by` against `services[].tasks[].node`; if the members of a network run on more than one host, it does) and which transport the user prefers: routed underlay, WireGuard mesh via `systemd-networkd`, or collapsing the stack onto one host.
3. Where secret values will come from on the new hosts: Podman secrets fed by an operator, `systemd-creds` encrypted credentials, or an external secret manager. The capture never contains values.
4. The acceptable downtime per stack and whether a dual-run (old and new serving simultaneously behind a load balancer) is possible.
5. How data volumes move: rsync from the old host while the service is stopped, storage-level snapshot, or shared storage that both sides already mount.

## Building the plan

Work through the references in order and write each section as you go:

1. **Host mapping.** Start from `expected.json`. Every stack gets a primary host and, for global or multi-replica services, the set of hosts. State-bearing services (anything with a volume that is not a cache) get exactly one host. Write a `host-map.json` when the renderer's placement is not what the user wants and re-render.
2. **Networking.** Apply `references/networking.md`. Decide the replacement for the ingress mesh (external load balancer, DNS round robin, or a VIP with keepalived), the transport for overlay networks that span hosts, and how service names resolve across hosts. Encrypted overlays must get an encrypted transport or an explicit acceptance of plaintext.
3. **Secrets and configs.** Apply `references/secrets-and-configs.md`. List every Podman secret name from `expected.json`, its source, and who imports it. Configs are files and go through normal configuration management.
4. **Storage.** Apply `references/storage.md`. For each volume, the copy method, the expected size, the stop-copy-start window, and the ownership fix-up.
5. **Cutover order and runbook.** Apply `references/cutover-runbook.md`. Order stacks from least to most dependent: leaf services first, shared databases last, edge proxies at the very end when DNS or the load balancer flips. Each stack gets a preflight, a cutover, a verification (delegated to `systemd-migration-verify`), and a rollback step with a named trigger.
6. **Risks.** One row per renderer note and capture warning that is still open, with an owner and a mitigation.

Keep the prose short and the tables complete. A plan that a reviewer can verify against the inventory is worth more than one that reads well.

## Files

- `references/plan-template.md`: the fixed section structure with guidance under each heading.
- `references/networking.md`: replacements for overlay networks, the routing mesh, VIPs, and DNS, with `systemd-networkd` and WireGuard configuration shapes.
- `references/secrets-and-configs.md`: Podman secrets, `systemd-creds`, `LoadCredential=`, and how to feed the rendered `import-secrets.sh`.
- `references/storage.md`: moving named volumes and bind mounts without losing data or ownership.
- `references/cutover-runbook.md`: per-stack runbook skeleton, dual-run pattern, rollback triggers.
