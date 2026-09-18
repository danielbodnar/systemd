---
name: systemd-storage
description: The storage component. Named volumes become directories created by tmpfiles.d with the service's owner (local) or .mount units the service RequiresMountsFor= (NFS, CIFS); bind mounts keep their source through BindPaths= and BindReadOnlyPaths=; tmpfs mounts become TemporaryFileSystem=; device binds become DeviceAllow=. How each volume's data reaches the new host is a decision in plan.yaml. Use this whenever the user asks how Docker volumes, bind mounts, or tmpfs map onto systemd, about mount units, tmpfiles.d, repart.d, or how to move volume data during a cutover.
---

# systemd-storage

A volume is a directory the runtime bind-mounts into the container; systemd does the same with `BindPaths=` on a service that runs in its own root, and it owns the rest of the lifecycle: `tmpfiles.d` creates the directory with the right owner at boot, a `.mount` unit brings a network share up before the service, and `RequiresMountsFor=` ties the two together.

## Decisions it raises

- `storage.state_dir.estate`: where local volumes live; each becomes `<state_dir>/<stack>/<volume>` (default `/var/lib`).
- `storage.move.<volume>` for every local volume: `rsync` (copy while the service is stopped), `snapshot`, `shared` (both sides already mount it), or `empty` (a cache). There is no default; the cutover runbook depends on the answer.

## What it renders

| Mount | Result |
|---|---|
| `type=volume`, local driver | `d <state_dir>/<stack>/<volume> 0750 <user> <group> -` in `/etc/tmpfiles.d/<stack>.conf`; `BindPaths=` (or `BindReadOnlyPaths=`) at the container path |
| `type=volume`, `nfs`/`nfs4`/`cifs` options | `<path>.mount` with `What=`, `Where=`, `Type=`, `Options=` (the `addr=` option becomes the server), `WantedBy=<stack>.target`; `RequiresMountsFor=` on the service |
| `type=bind` | `BindPaths=` or `BindReadOnlyPaths=`; propagation other than `rprivate` is noted |
| `type=bind` under `/dev/` | `DeviceAllow=<node> rw` and `BindPaths=`; the service component sets `DevicePolicy=closed` |
| `type=tmpfs` | `TemporaryFileSystem=<target>:size=,mode=` |

`install.sh` runs `systemd-tmpfiles --create` on the rendered fragment. A volume that was not inventoried on the capturing node is created empty and listed under "needs a human decision"; a service that runs with `DynamicUser=` gets a note suggesting `StateDirectory=` as the native shape.

## Files

- `scripts/component.ts`: the component module.
- See `../migration-planner/references/storage.md` for the copy procedures and the ownership fix-ups behind each `storage.move` option.
