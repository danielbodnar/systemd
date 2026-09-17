---
name: swarm-capture
description: Capture the Docker Swarm cluster reachable from this machine (or DOCKER_HOST) into a raw capture directory and a normalized inventory.json under the plugin's inventory directory.
---

Capture the Swarm cluster and produce an inventory.

1. Determine the inventory directory: `${user_config.inventory_dir}` if set, otherwise `.swarm-migration/` in the project root. Create it if needed.
2. Run `bash "${CLAUDE_PLUGIN_ROOT}/skills/swarm-capture/scripts/capture.sh" -o <inventory-dir>/capture` on a manager node. If the current machine is not a manager, ask the user for a `DOCKER_HOST` value or an SSH target and use `-H`. Pass `--compose-dir` when the user names a directory of compose files. The user's arguments are: $ARGUMENTS. Do not append them to the command as written. Read them as a list of the script's own options only (`-o DIR`, `-H HOST`, `--compose-dir DIR`, `--no-tasks`, `--keep-env`), pass each option and its value as a separate quoted argument, and stop and ask if an argument is not one of those, or if any value contains shell metacharacters (semicolons, pipes, ampersands, dollar signs, backticks, parentheses, angle brackets, or backslashes).
3. Run `bun "${CLAUDE_PLUGIN_ROOT}/skills/swarm-capture/scripts/normalize.ts" <inventory-dir>/capture -o <inventory-dir>/inventory.json`.
4. Read the inventory and report: node, stack, service, network, volume, secret, and config counts; every warning; and the risks listed in the swarm-capture skill under "Reading the output critically".

Do not modify the cluster.
