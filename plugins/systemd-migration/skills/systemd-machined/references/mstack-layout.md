# The mount stack layout

A directory with the `.mstack/` suffix describes a mount hierarchy assembled from overlay and bind mounts (`systemd.mstack(7)`, systemd 260). Each entry contributes one layer or one bind mount, and every entry may be a symbolic link. `systemd-mstack(1)` mounts, inspects, and unmounts one from the command line; `systemd-nspawn --mstack=` and `RootMStack=` in `systemd.exec(5)` consume it for a machine or a service.

| Entry | Effect |
|---|---|
| `layer@ID/` | A directory that becomes one overlayfs layer; entries are version-sorted by ID, the first being the bottom layer. `importctl pull-oci` writes one per image layer, `layer@0` being the base. |
| `layer@ID.raw` | A discoverable disk image mounted and used as a layer in the same order. |
| `rw/` | The writable layer on top (`data/` is the upperdir, `work/` the workdir; both are created on first use). Absent when the image was imported with `--read-only`. Needs overlayfs `FSCONFIG_SET_FD`, kernel 6.13 or later. |
| `bind@LOCATION/`, `bind@LOCATION.raw` | Bind-mounted read-write at LOCATION, encoded with the mount unit escaping (`bind@var` for `/var`). |
| `robind@LOCATION/`, `robind@LOCATION.raw` | The same, read-only. |
| `root/` | Used as the root of the hierarchy; only the `usr/` subtree of the overlay is bound into it. |

Every entry type accepts `systemd.v(7)` version selection, so `layer@1.raw.v/` holding `app_2026.08.raw` and `app_2026.09.raw` mounts the newest.

## What pull-oci writes

```
/var/lib/machines/acme-app_2026.09.mstack/
  layer@0 -> ../.oci-sha256:<layer digest>/
  layer@1 -> ../.oci-sha256:<layer digest>/
  rw/
```

Layers are stored once under hidden `.oci-sha256:*` directories and shared between images that have them in common. `importctl list-images` shows the image and its layers; `machinectl remove NAME` removes the stack and `machinectl remove .oci-sha256:DIGEST` a layer nobody references.

## What the consumers do

`RootMStack=/var/lib/machines/NAME.mstack` mounts the stack as the service's root directory before `ExecStart=`. Everything in `systemd.exec(5)` that applies to `RootDirectory=` applies here: `MountAPIVFS=yes` supplies `/proc`, `/sys`, and `/dev`, `BindPaths=` and `BindReadOnlyPaths=` bring host paths in, `ProtectSystem=strict` makes the tree read-only except for what is bound, and the credentials directory is available as `%d`. `PrivateUsers=self` gives the service its own user namespace, which is what lets a mount stack be used from an unprivileged user manager.

`systemd-nspawn --mstack=PATH` boots or runs a command in the stack as a machine, with the machine's own network, PID, and user namespaces; `Boot=no` plus `Parameters=` in the `.nspawn` file runs an application entrypoint instead of an init system.

## Versioning for rollback

Pull each image version under its own name and point the unit at a `.v/` directory:

```
/var/lib/machines/acme-app.mstack.v/
  acme-app_2026.08.mstack/
  acme-app_2026.09.mstack/
RootMStack=/var/lib/machines/acme-app.mstack.v
```

The newest version by `systemd.v(7)` ordering is selected at start; removing or renaming it rolls back at the next restart. The rendered unit records the digest the swarm ran in `[X-Migration] ImageDigest=` so a host can be checked against it.
