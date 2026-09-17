---
name: systemd-verify
description: Validate rendered or installed units (native services, Quadlet) against the migration's expectations, on a target host or in dry-run mode. Use this whenever the user asks to check, validate, verify, lint, or smoke test Quadlet or systemd units, wants to know whether a migrated stack is healthy, asks why a .container file does not produce a service, or is about to install units on a production host. Runs the Quadlet generator in dry-run, systemd-analyze verify, and, with --live, checks unit state, container health, and listening ports against expected.json from the render driver.
---

# systemd verify

A rendered unit tree is a hypothesis about how the hosts will behave; this skill tests it. It runs in two modes. Dry-run parses the units through the Quadlet generator and `systemd-analyze verify` without touching the running system, so it is safe on a production host before installation. Live mode compares the running system with `expected.json` after installation: unit state, container health, published ports, networks, volumes, and secrets.

## Running it

```bash
# before installing, on the target host, against the rendered tree for that host
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-verify/scripts/verify.sh" \
    --expected rendered/expected.json --units rendered/hosts/$(hostname)/etc/containers/systemd --dry-run

# after install.sh, on the same host
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-verify/scripts/verify.sh" --expected rendered/expected.json --live
```

The script prints one line per check with `ok`, `warn`, or `fail`, a summary, and exits non-zero on any failure. `--host NAME` overrides the hostname used to select the entry in `expected.json`; `--json` emits the results as JSON for the harness to record.

## Reading failures

- **Generator rejects a unit.** The dry-run prints the generator's message; the key is almost always a typo or a key the installed Podman does not support. Check the Podman version against `references/checks.md` and either drop the key or upgrade.
- **`systemd-analyze verify` warns about ordering.** A `.target` that wants a unit not present on this host, or an `After=` on a unit that lives elsewhere. Fix the target or the host map.
- **Unit active but container unhealthy.** The health command runs inside the container with the image's tools; a `curl` that is not in the image fails every time. Compare with the Swarm healthcheck, which had the same requirement.
- **Port not listening.** Either the unit failed, or the port is published by a different unit on this host (scale-out offsets), or a firewall dropped the rule. `ss -ltnp` shows who owns the port.
- **Secret missing.** `import-secrets.sh` was not run on this host, or a value file was absent; the script reports which name.

Report every failure to the user with the command that reproduces it and the fix you propose, then stop. Do not auto-fix units on a production host; the change belongs in the rendered tree so it is reproducible.

## Files

- `scripts/verify.sh`: the checker; dry-run and live modes; requires `jq`, `systemd-analyze`, and Podman.
- `references/checks.md`: what each check does, the exact commands, and the Podman version requirements for keys the renderer uses.
