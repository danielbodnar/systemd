# swarm-to-systemd

A Claude Code plugin, and a Managed Agents harness, for moving a multi-node, multi-stack Docker Swarm estate onto systemd-native hosts running Podman Quadlet units. It captures what the swarm runs, renders each service into units a host can own, plans the cutover, and verifies the result, with the migration decisions written down at every step rather than buried in generated files.

## What is in the plugin

Four skills carry the method; the agents and commands only sequence them.

| Skill | Purpose | Ships |
|---|---|---|
| `swarm-capture` | Read-only capture of nodes, stacks, services, tasks, networks, volumes, secrets, and configs into a schema-validated `inventory.json` | `capture.sh`, `normalize.ts`, the inventory JSON Schema |
| `swarm-to-quadlet` | Renders per-host `.container`, `.network`, `.volume` units, stack targets, secret import and install scripts, with notes for every lossy translation | `render.ts`, a field-by-field map, alternatives to containers |
| `systemd-migration-plan` | The plan: host mapping, networking after the overlay, secrets sourcing, storage moves, ordered runbooks with rollback | plan template, networking, secrets, storage, runbook references |
| `systemd-verify` | Dry-run validation through the Quadlet generator and `systemd-analyze`, live checks of units, health, ports, networks, volumes, secrets | `verify.sh`, a check reference with Podman version requirements |

Subagents (`swarm-auditor`, `unit-author`, `migration-planner`, `cutover-verifier`) pair each skill with a scope and a tool set. Slash commands (`/swarm-capture`, `/swarm-render`, `/swarm-plan`, `/swarm-verify`) run the sequence from a project directory.

## Using it in Claude Code

Add this repository as a marketplace and install the plugin:

```
/plugin marketplace add danielbodnar/systemd
/plugin install swarm-to-systemd@danielbodnar-systemd
```

Then, from a machine that can reach a Swarm manager:

```
/swarm-capture --compose-dir /srv/stacks
/swarm-render --selinux
/swarm-plan
/swarm-verify            # on each target host, before install.sh
/swarm-verify live       # after
```

The inventory and rendered tree land under `.swarm-migration/` (configurable through the plugin's `inventory_dir` setting). Nothing the plugin does modifies the swarm; installing units on a host is a runbook step the operator performs with the generated `install.sh`.

## Running it on production hosts

`harness/` turns the same skills into Managed Agents that run against a self-hosted sandbox on the host itself, so the capture, render, and verify steps happen where the cluster is, with an operator approving every command that could change anything. The agents, environments, and a scheduled drift audit are declared as files and applied with `ant apply`; the `swarm-agent` CLI runs the worker under systemd and drives sessions. Read `harness/README.md` for setup.

## Principles

The capture is evidence and is never edited; the inventory is a contract with a published schema; the renderer refuses to guess and writes a note instead; the plan is a document a team can execute without the agent; and secret values are never captured, rendered, or read by an agent. Where Swarm had a cluster-wide abstraction (the routing mesh, overlay networks, virtual IPs), the plugin names the host-level replacement and makes the operator choose, because those choices are the migration.

## Requirements

Bun 1.3 or later for the TypeScript scripts; `docker` on a manager node for the capture; Podman 4.9 or later, `jq`, and `systemd-analyze` on target hosts for verification (older Podman works with the fallbacks listed in `skills/systemd-verify/references/checks.md`); the `ant` CLI 1.30 or later and an Anthropic workspace for the harness.
