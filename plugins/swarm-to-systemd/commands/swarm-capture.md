---
name: swarm-capture
description: Capture the Docker Swarm cluster reachable from this machine (or DOCKER_HOST) into a raw capture directory and a normalized inventory.json under the plugin's inventory directory.
---

Capture the Swarm cluster and produce an inventory.

1. Determine the inventory directory: `${user_config.inventory_dir}` if set, otherwise `.swarm-migration/` in the project root. Create it if needed.
2. Run `bash "${CLAUDE_PLUGIN_ROOT}/skills/swarm-capture/scripts/capture.sh" -o <inventory-dir>/capture` on a manager node. If the current machine is not a manager, ask the user for a `DOCKER_HOST` value or an SSH target and use `-H`. Pass `--compose-dir` when the user names a directory of compose files. Arguments after the command name are appended verbatim: $ARGUMENTS
3. Run `bun "${CLAUDE_PLUGIN_ROOT}/skills/swarm-capture/scripts/normalize.ts" <inventory-dir>/capture -o <inventory-dir>/inventory.json`.
4. Read the inventory and report: node, stack, service, network, volume, secret, and config counts; every warning; and the risks listed in the swarm-capture skill under "Reading the output critically".

Do not modify the cluster.
