---
name: swarm-render
description: Render the captured inventory into per-host Podman Quadlet units under the inventory directory and summarize the renderer's notes.
---

Render Quadlet units from the inventory.

1. Locate `inventory.json` in the inventory directory (`${user_config.inventory_dir}` or `.swarm-migration/`). If it is missing, run `/swarm-capture` first or ask the user for the file.
2. Use `<inventory-dir>/host-map.json` when it exists. Run `bun "${CLAUDE_PLUGIN_ROOT}/skills/swarm-to-quadlet/scripts/render.ts" <inventory-dir>/inventory.json -o <inventory-dir>/rendered` with `--host-map` when applicable and any extra flags the user passed: $ARGUMENTS
3. Read `<inventory-dir>/rendered/MIGRATION-NOTES.md` in full. Present the host plan table and every item under "needs a human decision", grouped by service, with your recommended resolution for each.
4. Delegate hand edits to the unit-author agent when the user accepts a recommendation; never edit units on a host.
