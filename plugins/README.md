<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# systemd-dev-plugins

Claude Code plugins, maintained alongside the systemd source tree, for moving container orchestration onto systemd-native primitives. The marketplace is declared in `.claude-plugin/marketplace.json` at the repository root; each plugin here is named `<source>-<object>-to-<target>`, and the skills inside it follow the same pattern so that a skill name says exactly what it reads and what it produces.

```
/plugin marketplace add danielbodnar/systemd
/plugin install docker-swarm-to-systemd@systemd-dev-plugins
/plugin install oci-image-to-systemd@systemd-dev-plugins
/plugin install podman-container-to-quadlet@systemd-dev-plugins
/plugin install systemd-migration-harness@systemd-dev-plugins
```

| Plugin | Role | Skills |
|---|---|---|
| `docker-swarm-to-systemd` | Source side: capture a Swarm estate into the inventory contract and plan the migration | `docker-swarm-to-inventory`, `docker-to-systemd-planner` |
| `oci-image-to-systemd` | Native target: pull images into mount stacks and render them as plain services with `RootMStack=`, no container runtime | `oci-image-to-mstack`, `oci-image-to-ddi`, `docker-image-to-service` |
| `podman-container-to-quadlet` | Podman target: render the inventory into per-host Quadlet units | `podman-container-to-quadlet` |
| `systemd-migration-harness` | Verification, and unattended execution through a Managed Agents harness | `systemd-migration-verify` |

The plugins share one contract, the inventory schema under `docker-swarm-to-systemd/contract/`. Because Claude Code installs each plugin into its own cache, consumers carry a vendored copy under their own `contract/` directory; `scripts/sync-contract.sh` refreshes the copies and the harness test suite fails on drift. The typical sequence from a project directory is `/swarm-capture`, `/swarm-plan`, `/swarm-render-native` (or `/swarm-render` for Quadlet), then `/swarm-verify` on each target host before and after installation; each command belongs to the plugin whose skill it runs.

`PLAN.md` describes the next generation of this set: every systemd deployment form (plain units of every type, nspawn, mount stacks, vmspawn, portable services, system and configuration extensions, capsules, networkd) as a target, a planner that builds the Docker-to-systemd translation map from the tree's own directive catalogue, and verification through the tree's integration tests.
