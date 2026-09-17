<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# systemd-dev-plugins

Claude Code plugins maintained alongside the systemd source tree. The marketplace is declared in `.claude-plugin/marketplace.json` at the repository root.

```
/plugin marketplace add danielbodnar/systemd
/plugin install systemd-migration@systemd-dev-plugins
```

| Plugin | Purpose |
|---|---|
| `systemd-migration` | Move container orchestration (Docker Swarm first, Podman next) onto systemd-native infrastructure: adapters discover the estate, a planner writes a reviewable plan, and one skill per systemd component renders its part of the result. See `systemd-migration/README.md`. |

`scripts/render-fixtures.sh` regenerates the committed fixture estate under `test/test-container-migration/` from the plugin's scripts; the harness test suite fails when the fixtures drift. `PLAN.md` records the design and its status.
