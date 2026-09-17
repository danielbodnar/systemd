---
name: systemd-sysext
description: The extensions component. A stack's configuration files can ship as a configuration extension merged into /etc by systemd-confext instead of plain files, and a pure-/usr payload can ship as a system extension merged by systemd-sysext; both are one artifact that refreshes atomically. Use this whenever the user asks about sysext, confext, extension-release, extension images, shipping config as an image, or atomic config updates on systemd hosts.
---

# systemd-sysext

`systemd-sysext(8)` merges extension images over `/usr/` and, as `systemd-confext`, over `/etc/`. An extension is a directory or a disk image with an `extension-release` file; refreshing merges every extension atomically, so a stack's configuration becomes a versioned artifact rather than a set of files copied into place.

## Decisions it raises

`sysext.configs.<stack>` for each stack with config files: `files` (default; `/etc/<stack>/configs/<name>` installed by `install.sh` with the recorded ownership) or `confext` (the files are packed under `/var/lib/confexts/<stack>/` with an `extension-release.<stack>` and merged by `systemd-confext refresh`).

## What it renders

With `confext`: the directory tree under `var/lib/confexts/<stack>/etc/`, the release file with `ID=_any` and `CONFEXT_LEVEL=1`, the ownership manifest applied by `install.sh`, `systemd-confext refresh` after install, and the same `BindReadOnlyPaths=` on the services as with plain files. Application images are not sysexts: an OCI image has a full root, not a `/usr/` overlay, which is why images run as mount stacks (see `systemd-machined`).

## Files

- `scripts/component.ts`: the component module.
