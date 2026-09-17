# podman-container-to-quadlet

The Podman target of the `systemd-dev-plugins` migration set. It renders an inventory produced by `docker-swarm-to-systemd` into per-host Podman Quadlet units, `.container`, `.network`, and `.volume` files that Podman's generator turns into ordinary service units, plus a target per stack, a secret import script, and an install script per host. Every translation the renderer could not make faithfully is written to `MIGRATION-NOTES.md` for a human decision.

| Skill | Purpose | Ships |
|---|---|---|
| `podman-container-to-quadlet` | Renders the per-host unit tree and explains each field's mapping | `render.ts`, a field-by-field map, alternatives to containers, an example unit |

`contract/` is a vendored copy of the inventory contract from `docker-swarm-to-systemd`; do not edit it here.

The `unit-author` subagent renders, resolves the notes into concrete unit edits, and stays inside the rendered directory. The `/swarm-render` command runs it from a project directory and expects `inventory.json` under the shared `inventory_dir` (default `.swarm-migration/`).

```
/plugin install podman-container-to-quadlet@systemd-dev-plugins
/swarm-render --selinux --host-map .swarm-migration/host-map.json
```

Requirements: Bun 1.3 or later to render; Podman 4.9 or later on the target hosts (older Podman works with the fallbacks listed in the field map).
