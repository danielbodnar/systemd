# systemd-migration-harness

Verification and unattended execution for the `systemd-dev-plugins` migration set.

| Skill | Purpose | Ships |
|---|---|---|
| `systemd-migration-verify` | Dry-run validation through the Quadlet generator and `systemd-analyze verify`, then live checks of unit state, container health, ports, networks, volumes, and secrets against `expected.json` | `verify.sh`, a check reference with Podman version requirements |

The `cutover-verifier` subagent runs the skill on a target host and reports rather than repairs; `/swarm-verify` and `/swarm-verify live` invoke it from a project directory against `rendered/expected.json` under the shared `inventory_dir`.

`harness/` turns the skills of all three plugins into Managed Agents that run against a self-hosted sandbox on the production host itself, so the capture, render, and verify steps happen where the cluster is, with an operator approving every command that could change anything. The agents, environments, and a scheduled drift audit are declared as files and applied with `ant apply`; the `swarm-agent` CLI runs the worker and a credential-free tool executor under systemd and drives sessions. Read `harness/README.md` for setup.

```
/plugin install systemd-migration-harness@systemd-dev-plugins
```

Requirements: Podman 4.9 or later, `jq`, and `systemd-analyze` on target hosts for verification; the `ant` CLI 1.30 or later, Bun 1.3 or later, and an Anthropic workspace for the harness.
