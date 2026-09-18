---
name: migrate-render
description: Compose the systemd components the approved plan selects into per-host trees (services, machines, networks, credentials, mounts, journal settings, extensions) under the migration directory, and summarize what still needs a human.
---

Render the per-host trees from the approved plan.

1. Locate `inventory.json` and `plan.yaml` in the migration directory (`${user_config.inventory_dir}` or `.systemd-migration/`). If the plan is missing or `bun "${CLAUDE_PLUGIN_ROOT}/scripts/review.ts" <dir>/plan.yaml --status` reports anything unresolved or not yet approved, stop and run `/migrate-plan`; do not pass `--accept-defaults` unless the user asks for an unreviewed first look and understands that every default is then listed under "needs a human decision".
2. Run `bun "${CLAUDE_PLUGIN_ROOT}/scripts/render.ts" <dir>/inventory.json <dir>/plan.yaml -o <dir>/rendered`. The user's arguments are: $ARGUMENTS. Do not append them to the command as written. The only options are `--host NAME` (repeatable, restricts the render to those hosts) and `--accept-defaults`; pass each as a separate quoted argument, and stop and ask if an argument is anything else or contains shell metacharacters (semicolons, pipes, ampersands, dollar signs, backticks, parentheses, angle brackets, or backslashes).
3. Read `<dir>/rendered/MIGRATION-NOTES.md` in full. Present the host plan table, the images to pull, and every item under "needs a human decision", grouped by service, with your recommended resolution for each.
4. For a decision that turns out wrong once the units are visible, change it with `review.ts --set` and re-render rather than editing the rendered files; delegate genuine hand edits (an `ExecStart=` the capture could not see, a `WatchdogSec=` for an application that speaks sd_notify) to the unit-author agent, which records each edit as a comment in the unit. Never edit units on a host.
5. Tell the user the order of what follows: pull the images on each host (`systemd-machined` skill), fill the secrets directory and run `secrets/import-credentials.sh`, `install.sh` from the host's directory, and `/migrate-verify` before starting anything.
