---
name: swarm-plan
description: Write MIGRATION-PLAN.md for moving the captured Swarm estate to systemd hosts, after asking the planning questions.
---

Produce the migration plan.

1. Confirm `inventory.json` exists in the inventory directory (`${user_config.inventory_dir}` or `.swarm-migration/`); run `/swarm-capture` first if it does not. `rendered/MIGRATION-NOTES.md` from `/swarm-render` is strongly recommended unless the user only wants an early estimate.
2. Run `bun "${CLAUDE_PLUGIN_ROOT}/skills/docker-to-systemd-planner/scripts/plan-map.ts" <inventory-dir>/inventory.json -o <inventory-dir>` and present the "needs a human decision" section of `<inventory-dir>/TRANSLATION-MAP.md`. If the user named the deployment forms under consideration, pass them as `--targets` (a comma-separated list from service, nspawn, vmspawn, portable, capsule, sysext, confext, networkd, quadlet); pass nothing else from the arguments to the command.
3. Invoke the migration-planner agent with the inventory directory and any constraints the user stated: $ARGUMENTS
4. The planner asks the five questions from the docker-to-systemd-planner skill; relay the user's answers verbatim.
5. When `MIGRATION-PLAN.md` is written, summarize the cutover order and the open risks, and point the user at the first runbook.
