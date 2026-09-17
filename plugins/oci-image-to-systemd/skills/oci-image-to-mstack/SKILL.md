---
name: oci-image-to-mstack
description: Pull the OCI images an estate uses into systemd mount stacks (NAME.mstack directories under /var/lib/machines or another image class) with importctl pull-oci, pinned to the inventory's digests and versioned for rollback. Use this whenever the user wants container images available to systemd without Docker or Podman, asks about importctl, pull-oci, .mstack, systemd-mstack, RootMStack=, image layers, or how to get an image onto a host for a native service or an nspawn machine, or when a rendered tree's images.json needs to be fulfilled on a host.
---

# OCI image to mount stack

`importctl pull-oci` (systemd 260 and later) downloads an OCI image from a registry into the image directory of a class and writes a mount stack: a directory `NAME.mstack/` holding one `layer@N` symlink per image layer and, unless the image was imported read-only, a writable `rw/` layer on top. `systemd-nspawn --mstack=` and `RootMStack=` in a service consume it directly; nothing unpacks or flattens the image. The writable layer needs overlayfs `FSCONFIG_SET_FD` support, which means a kernel of 6.13 or later; for older hosts use the `oci-image-to-ddi` skill instead.

## Pulling the images of an estate

The `docker-image-to-service` renderer writes `images.json` next to the rendered tree: one entry per distinct image reference with the local name the units expect, the digest the inventory recorded, and the services that use it. On each host:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/oci-image-to-mstack/scripts/pull-images.sh" rendered/images.json            # every image
bash "${CLAUDE_PLUGIN_ROOT}/skills/oci-image-to-mstack/scripts/pull-images.sh" rendered/images.json --host $(hostname)   # only what this host runs
bash "${CLAUDE_PLUGIN_ROOT}/skills/oci-image-to-mstack/scripts/pull-images.sh" rendered/images.json --dry-run  # print the importctl commands
```

The script skips images whose mount stack already exists, pulls the rest with `importctl pull-oci --class=machine REF NAME`, and lists the result with `importctl list-images`. `--class=` selects another image directory (`portable` for portable services, `sysext` or `confext` for extensions) and `--read-only` leaves out the writable layer for images the service never writes to (pair it with `ProtectSystem=strict` in the unit). `--user` pulls into the caller's own image directory for unprivileged use.

## Names, pins, and versions

The local name is derived from the reference by the renderer (`acme-app_2026.09` for `registry.example.com/acme/app:2026.09`), and the unit's `RootMStack=` points at `/var/lib/machines/<name>.mstack`. The renderer records the digest the swarm ran in the unit's `[X-Migration]` section; `pull-images.sh` prints the digest after the pull so the two can be compared, since `pull-oci` pulls by reference and does not verify a digest itself.

To keep several versions for rollback, pull each version under its own name and let a `systemd.v(7)` directory pick the newest: `RootMStack=/var/lib/machines/acme-app.mstack.v/` with `acme-app_2026.08.mstack` and `acme-app_2026.09.mstack` inside it selects the highest version; renaming or removing the newer one rolls back without touching the unit. Read `references/mstack-layout.md` for the layout rules, the `root/` and `bind@` entries, and how a DDI layer fits in.

## Registries

`pull-oci` takes a reference of the form `REGISTRY/REPOSITORY:TAG`. A registry can be described by a file under `/usr/lib/systemd/oci-registry/*.oci-registry` (JSON with `defaultProtocol` and `overrideRegistry`), which is how a mirror, a `file://` registry for tests, or a private registry with a plain name is configured. Credentials for a registry are systemd credentials, never command-line arguments.

## Files

- `scripts/pull-images.sh`: pulls every image in a rendered `images.json` on this host; `--host`, `--class`, `--read-only`, `--user`, `--dry-run`.
- `references/mstack-layout.md`: the `.mstack/` directory format, versioning with `.v/`, and what `RootMStack=` and `--mstack=` do with it.
