---
name: discover-systemd-hosts
description: Probe the target hosts (the systemd machines the estate moves to) and record what their systemd can do: version and features, kernel, cgroup hierarchy, mount-stack support, which daemons (networkd, resolved, machined, importd, portabled) and tools (systemd-nspawn, importctl, systemd-creds, systemd-repart, podman) are installed, image directories, and addresses. Use this before planning, whenever the user names the destination hosts, asks whether a host can run mount stacks or nspawn, wants to know which systemd version is on a target, or asks why the planner chose disk images over RootMStack= for a host.
---

# Host discovery

A plan is only as good as its knowledge of the destination. `probe.sh` runs on each target host, or reaches it over ssh with nothing installed remotely, and writes one JSON file per host in the shape `plan.yaml` carries under `hosts`. The planner then decides from evidence: a host on systemd 255 cannot mount a stack, so its images become disk images; a host without `systemd-resolved` cannot announce DNS-SD; a service can become a machine only where `systemd-nspawn` exists. Every option a host cannot satisfy is annotated on the decision rather than silently dropped.

```bash
# on a target host
bash "${CLAUDE_PLUGIN_ROOT}/skills/discover-systemd-hosts/scripts/probe.sh" -o hosts

# from the operator machine, over ssh
bash "${CLAUDE_PLUGIN_ROOT}/skills/discover-systemd-hosts/scripts/probe.sh" -o hosts --ssh root@web-1 --ssh root@db-1

# then
bun "${CLAUDE_PLUGIN_ROOT}/scripts/plan.ts" inventory.json --hosts hosts -o plan.yaml
```

The probe is read-only and needs a POSIX shell, coreutils, and `systemctl`; `ip(8)` adds the addresses when present. It never runs a command that changes the host.

## What it records

| Field | Source | Who reads it |
|---|---|---|
| `systemd.version`, `systemd.features` | `systemctl --version` | every component's version floor; the `mstack` option needs 260 |
| `kernel` | `uname -r` | `overlayfs_fsconfig` (6.13 and later), the `mstack` option |
| `cgroup_v2` | `/sys/fs/cgroup` file system type | resource control |
| `daemons` | `systemd-<name>` binaries under the systemd library directory | networkd and resolved options, machined forms |
| `tools` | `command -v` | the forms a service may take (machine, vm, portable, quadlet), credentials, DDIs |
| `image_dirs` | `/var/lib/{machines,portables,extensions,confexts}` | machined and sysext defaults |
| `addresses` | `ip -o -4 addr` | the resolved component's hosts fragment; the networkd transports |
| `notes` | `systemctl is-enabled` and `is-active` of the relevant units | the planner's evidence; a present but disabled daemon is a runbook step |

Without probe files the planner targets the inventory's own nodes with unknown capabilities and says so on every affected decision. That is enough for an estimate and not for a migration.

## Files

- `scripts/probe.sh`: the probe; `-o DIR`, `--ssh HOST` (repeatable).
- The output shape is `$defs.host` in `contract/plan-schema.json`.
