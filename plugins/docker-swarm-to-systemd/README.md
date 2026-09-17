# docker-swarm-to-systemd

The source side of the `systemd-dev-plugins` migration set. It captures what a multi-node, multi-stack Docker Swarm estate runs into a normalized inventory, and it plans the move onto systemd-native hosts, with the migration decisions written down rather than buried in generated files. Rendering the inventory into units is the job of the target plugins (`podman-container-to-quadlet` today; nspawn, portable, and plain-unit targets are planned), and verifying the result belongs to `systemd-migration-harness`. All of them read the same inventory contract.

## What is in the plugin

| Skill | Purpose | Ships |
|---|---|---|
| `docker-swarm-to-inventory` | Read-only capture of nodes, stacks, services, tasks, networks, volumes, secrets, and configs into a schema-validated `inventory.json` | `capture.sh`, `normalize.ts`, field notes, an example inventory |
| `docker-to-systemd-planner` | The plan: host mapping, networking after the overlay, secrets sourcing, storage moves, ordered runbooks with rollback | plan template, networking, secrets, storage, runbook references |

`contract/` holds the inventory JSON Schema, its TypeScript types, and a dependency-free validator. It is the source that every other plugin vendors; see `contract/README.md`.

Subagents `swarm-auditor` and `migration-planner` pair the skills with a scope and a tool set. The slash commands `/swarm-capture` and `/swarm-plan` run them from a project directory.

## Using it in Claude Code

```
/plugin marketplace add danielbodnar/systemd
/plugin install docker-swarm-to-systemd@systemd-dev-plugins
/plugin install podman-container-to-quadlet@systemd-dev-plugins   # the renderer
/plugin install systemd-migration-harness@systemd-dev-plugins     # the verifier
```

Then, from a machine that can reach a Swarm manager:

```
/swarm-capture --compose-dir /srv/stacks
/swarm-render --selinux        # podman-container-to-quadlet
/swarm-plan
/swarm-verify                  # systemd-migration-harness, on each target host before install.sh
/swarm-verify live             # after
```

The inventory, plan, and rendered tree land under `.swarm-migration/` (configurable through the `inventory_dir` setting, which the sibling plugins share). Nothing the plugin does modifies the swarm; installing units on a host is a runbook step the operator performs.

## Principles

The capture is evidence and is never edited; the inventory is a contract with a published schema; the planner refuses to guess and asks instead; the plan is a document a team can execute without the agent; and secret values are never captured, rendered, or read by an agent. Where Swarm had a cluster-wide abstraction (the routing mesh, overlay networks, virtual IPs), the plugin names the host-level replacement and makes the operator choose, because those choices are the migration.

## Requirements

Bun 1.3 or later for the TypeScript scripts; `docker` and `jq` on a manager node for the capture.
