---
name: systemd-verify
description: Validate rendered or installed units against the migration's expected.json, on a target host or in dry-run mode, for native systemd trees (services, machines, timers, mounts, sockets, credentials, images, volumes) and for Quadlet trees. Use this whenever the user asks to check, validate, verify, lint, or smoke test rendered units, wants to know whether a migrated stack is healthy on a host, asks why systemd-analyze rejects a unit, or is about to install units on a production host. Runs systemd-analyze verify (and the Quadlet generator for Podman hosts) in dry-run and, with --live, checks unit and machine state, health results, listening ports, credentials, and volumes.
---

# systemd verify

A rendered unit tree is a hypothesis about how the hosts will behave; this skill tests it. `expected.json` from the render driver lists, per host, what the tree should carry: units, targets, slices, timers, mounts, sockets, machines, images, credentials, volumes, and ports for a native tree, or units, containers, networks, volumes, and secrets for a Quadlet tree. The script picks the engine from the host's entry (`--engine native|quadlet` overrides it) and runs in two modes. Dry-run checks the rendered tree without touching the running system, so it is safe on a production host before installation. Live mode compares the running system with the expectations after `install.sh`.

## Running it

```bash
# before installing, on the target host, against the rendered tree for that host
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-verify/scripts/verify.sh" \
    --expected rendered/expected.json --units rendered/hosts/$(hostname)/etc/systemd/system --dry-run

# after install.sh, on the same host
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-verify/scripts/verify.sh" --expected rendered/expected.json --live
```

For a host that keeps Quadlet units, point `--units` at `rendered/hosts/$(hostname)/etc/containers/systemd`. The script prints one line per check with `ok`, `warn`, or `fail`, a summary, and exits non-zero on any failure. `--host NAME` overrides the hostname used to select the entry in `expected.json`; `--json` emits the results as JSON for the harness to record.

## What dry-run does on a native tree

Every expected unit file must be present. The units are copied under a temporary root with a stub executable for every command they name, and `systemd-analyze --root verify` runs over them, so the check is meaningful before the images are pulled. Images under `/var/lib/machines`, credentials in `/etc/credstore.encrypted` or `/etc/credstore`, and volume directories are reported as present or still to import; before installation those are warnings, not failures, because the runbook imports them in the cutover step. `install.sh` must parse.

## Reading failures

- **`systemd-analyze` rejects a unit.** The detail lists every line the manager printed. An unknown key (`RootMStack=`, `PrivateUsers=self`) means the host's systemd is older than the plan assumed; change the root-form decision for that host in `plan.yaml` (`machined.root.<host>`) to `ddi` and re-render, or upgrade the host. An ordering or dependency message points at a target that wants a unit not present on this host: fix the placement decision.
- **Generator rejects a Quadlet unit.** The dry-run prints the generator's message; the key is almost always one the installed Podman does not support. Check the version against `references/checks.md` and either drop the key or upgrade.
- **Unit active but the health unit's last result is not success.** The health command runs inside the image with the image's tools; a `curl` that is not in the image fails every time. Compare with the Swarm healthcheck, which had the same requirement.
- **Port not listening.** Either the unit failed, or the port is published by a different unit on this host (scale-out offsets), or a firewall dropped the rule. `ss -ltnp` shows who owns the port.
- **Credential missing.** `import-credentials.sh` was not run on this host, or a value file was absent; the script reports which name.
- **Machine not running.** `machinectl status NAME` and `journalctl -u systemd-nspawn@NAME` explain why; a missing image or a `.nspawn` file with a bind path that does not exist are the usual causes.

Report every failure to the user with the command that reproduces it and the fix you propose, then stop. Do not auto-fix units on a production host; the change belongs in `plan.yaml` or the rendered tree so it is reproducible.

## Files

- `scripts/verify.sh`: the checker; native and Quadlet engines, dry-run and live modes; requires `jq` and `systemd-analyze`, plus Podman for Quadlet trees.
- `references/checks.md`: what each check does, the exact commands, and the Podman version requirements for keys the Quadlet renderer uses.
