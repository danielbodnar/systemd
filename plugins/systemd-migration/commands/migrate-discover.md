---
name: migrate-discover
description: Discover the estate and the target hosts. Capture the Docker Swarm cluster reachable from this machine (or DOCKER_HOST) into a raw capture and a normalized inventory.json, and probe the systemd hosts the estate will move to, all under the plugin's migration directory.
---

Discover the source estate and the destination hosts.

1. Determine the migration directory: `${user_config.inventory_dir}` if set, otherwise `.systemd-migration/` in the project root. Create it if needed.
2. Capture the source. For a Docker Swarm, run `bash "${CLAUDE_PLUGIN_ROOT}/skills/discover-docker-swarm/scripts/capture.sh" -o <dir>/capture` on a manager node; if this machine is not a manager, ask the user for a `DOCKER_HOST` value or an SSH target and use `-H`. Pass `--compose-dir` when the user names a directory of compose files. For a Podman host, use the `discover-podman` skill's `capture.sh` the same way. The user's arguments are: $ARGUMENTS. Do not append them to the command as written. Read them as a list of the script's own options only (`-o DIR`, `-H HOST`, `--compose-dir DIR`, `--no-tasks`), pass each option and its value as a separate quoted argument, and stop and ask if an argument is not one of those, or if any value contains shell metacharacters (semicolons, pipes, ampersands, dollar signs, backticks, parentheses, angle brackets, or backslashes).
3. Normalize: `bun "${CLAUDE_PLUGIN_ROOT}/skills/discover-docker-swarm/scripts/normalize.ts" <dir>/capture -o <dir>/inventory.json` (or the Podman normalizer).
4. Probe the target hosts. Ask the user which systemd hosts the estate moves to if they are not the same machines. Run `bash "${CLAUDE_PLUGIN_ROOT}/skills/discover-systemd-hosts/scripts/probe.sh" -o <dir>/hosts --ssh <user@host>` for each, or tell the user to run the script on each host and copy the JSON into `<dir>/hosts/`. Host names come from the user; pass each as its own `--ssh` argument and refuse anything that is not a plain `user@host` or `host` token.
5. Read the inventory and the host files and report: node, stack, service, network, volume, secret, and config counts; every warning; the risks the `discover-docker-swarm` skill lists under "Reading the output critically"; and, per target host, the systemd version, whether mount stacks are usable, and which daemons and tools are missing.

Do not modify the cluster or the hosts.
