---
name: swarm-render
description: Render the captured inventory into per-host Podman Quadlet units under the inventory directory and summarize the renderer's notes.
---

Render Quadlet units from the inventory.

1. Locate `inventory.json` in the inventory directory (`${user_config.inventory_dir}` or `.swarm-migration/`). If it is missing, run `/swarm-capture` first or ask the user for the file.
2. Use `<inventory-dir>/host-map.json` when it exists. Run `bun "${CLAUDE_PLUGIN_ROOT}/skills/swarm-to-quadlet/scripts/render.ts" <inventory-dir>/inventory.json -o <inventory-dir>/rendered` with `--host-map` when applicable. The user's arguments are: $ARGUMENTS. Do not append them to the command as written. Read them as the renderer's own options only (`--host-map FILE`, `--scale-out`, `--auto-update`, `--selinux`, `--unit-dir DIR`, `--config-dir DIR`), pass each option and its value as a separate quoted argument, and stop and ask if an argument is not one of those, or if any value contains shell metacharacters (semicolons, pipes, ampersands, dollar signs, backticks, parentheses, angle brackets, or backslashes).
3. Read `<inventory-dir>/rendered/MIGRATION-NOTES.md` in full. Present the host plan table and every item under "needs a human decision", grouped by service, with your recommended resolution for each.
4. Delegate hand edits to the unit-author agent when the user accepts a recommendation; never edit units on a host.
