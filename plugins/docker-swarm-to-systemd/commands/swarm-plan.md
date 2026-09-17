---
name: swarm-plan
description: Write MIGRATION-PLAN.md for moving the captured Swarm estate to systemd hosts, after asking the planning questions.
---

Produce the migration plan.

1. Confirm `inventory.json` and `rendered/MIGRATION-NOTES.md` exist in the inventory directory (`${user_config.inventory_dir}` or `.swarm-migration/`). Run `/swarm-capture` and `/swarm-render` first if they do not, unless the user only wants an early estimate.
2. Invoke the migration-planner agent with the inventory directory and any constraints the user stated: $ARGUMENTS
3. The planner asks the five questions from the docker-to-systemd-planner skill; relay the user's answers verbatim.
4. When `MIGRATION-PLAN.md` is written, summarize the cutover order and the open risks, and point the user at the first runbook.
