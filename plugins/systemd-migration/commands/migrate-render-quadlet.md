---
name: migrate-render-quadlet
description: Render the whole inventory as Podman Quadlet units in one call, without a reviewed plan, for a first look at the Podman adapter target; a migration picks Quadlet per service through the plan's form decision and renders with /migrate-render.
---

Render Quadlet units from the inventory in one call.

1. Locate `inventory.json` in the migration directory (`${user_config.inventory_dir}` or `.systemd-migration/`). If it is missing, run `/migrate-discover` first or ask the user for the file.
2. Use `<dir>/host-map.json` when it exists. Run `bun "${CLAUDE_PLUGIN_ROOT}/skills/podman-quadlet/scripts/render.ts" <dir>/inventory.json -o <dir>/rendered-quadlet` with `--host-map` when applicable. The user's arguments are: $ARGUMENTS. Do not append them to the command as written. Read them as the renderer's own options only (`--host-map FILE`, `--scale-out`, `--auto-update`, `--selinux`, `--unit-dir DIR`, `--config-dir DIR`), pass each option and its value as a separate quoted argument, and stop and ask if an argument is not one of those, or if any value contains shell metacharacters (semicolons, pipes, ampersands, dollar signs, backticks, parentheses, angle brackets, or backslashes).
3. Read `<dir>/rendered-quadlet/MIGRATION-NOTES.md` in full. Present the host plan table and every item under "needs a human decision", grouped by service, with your recommended resolution for each.
4. Explain that this is the adapter's one-call shortcut: for the migration itself, set `form.service.<name>` to `quadlet` in `plan.yaml` for the services that should stay on Podman and render everything together with `/migrate-render`. Delegate hand edits to the quadlet-author agent when the user accepts a recommendation; never edit units on a host.
