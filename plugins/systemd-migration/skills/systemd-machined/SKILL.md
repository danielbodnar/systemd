---
name: systemd-machined
description: The machines component. Pull the OCI images an estate uses into systemd mount stacks with importctl pull-oci (pinned to the inventory's digests, versioned for rollback), pack them into discoverable disk images for hosts without mount stacks, and run a service as a machine (systemd-nspawn with a .nspawn file, registered with machined) or a virtual machine (systemd-vmspawn) when the plan selects that form. Use this whenever the user asks about importctl, pull-oci, .mstack, systemd-mstack, RootMStack=, RootImage=, DDIs, systemd-repart, systemd-dissect, nspawn, vmspawn, machinectl, or how to get an image onto a host and run it in its own namespaces.
---

# systemd-machined

The machines component owns three things: images (how an OCI image becomes something systemd can mount), machines (a service that runs under `systemd-nspawn` in its own PID and network namespace), and virtual machines (`systemd-vmspawn`). The planner decides per service which form it takes; this skill renders the chosen form and provides the scripts that put the images in place.

## Images: mount stacks

`importctl pull-oci` (systemd 260 and later) downloads an OCI image from a registry into the image directory of a class and writes a mount stack: a directory `NAME.mstack/` holding one `layer@N` symlink per image layer and, unless the image was imported read-only, a writable `rw/` layer on top. `systemd-nspawn --mstack=` and `RootMStack=` in a service consume it directly; nothing unpacks or flattens the image. The writable layer needs overlayfs `FSCONFIG_SET_FD` support, which means a kernel of 6.13 or later; `discover-systemd-hosts` records whether a host has it, and the planner falls back to a DDI (below) where it does not.

The `systemd-service` renderer writes `images.json` next to the rendered tree: one entry per distinct image reference with the local name the units expect, the digest the inventory recorded, and the services that use it. On each host:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-machined/scripts/pull-images.sh" rendered/images.json            # every image
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-machined/scripts/pull-images.sh" rendered/images.json --host $(hostname)   # only what this host runs
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-machined/scripts/pull-images.sh" rendered/images.json --dry-run  # print the importctl commands
```

The script skips images whose mount stack already exists and pulls the rest with `importctl pull-oci --class=machine REF NAME`. When the inventory recorded a digest, `REF` is the immutable `REPOSITORY@sha256:...` form rather than the tag, so a re-pushed tag or a tampering registry cannot substitute content; an image the swarm ran without a digest is pulled by tag and reported as such. `importctl` verifies nothing beyond the TLS session, which is why the pin lives in the reference. The result is listed with `importctl list-images`. `--class=` selects another image directory (`portable` for portable services, `sysext` or `confext` for extensions) and `--read-only` leaves out the writable layer for images the service never writes to (pair it with `ProtectSystem=strict` in the unit). `--user` pulls into the caller's own image directory for unprivileged use.

## Names, pins, and versions

The local name is derived from the reference by the renderer (`acme-app_2026.09` for `registry.example.com/acme/app:2026.09`), and the unit's `RootMStack=` points at `/var/lib/machines/<name>.mstack`. The renderer records the digest the swarm ran in the unit's `[X-Migration]` section and in `images.json`; `pull-images.sh` pulls by that digest.

To keep several versions for rollback, pull each version under its own name and let a `systemd.v(7)` directory pick the newest: `RootMStack=/var/lib/machines/acme-app.mstack.v/` with `acme-app_2026.08.mstack` and `acme-app_2026.09.mstack` inside it selects the highest version; renaming or removing the newer one rolls back without touching the unit. Read `references/mstack-layout.md` for the layout rules, the `root/` and `bind@` entries, and how a DDI layer fits in.

## Registries

`pull-oci` takes a reference of the form `REGISTRY/REPOSITORY:TAG`. A registry can be described by a file under `/usr/lib/systemd/oci-registry/*.oci-registry` (JSON with `defaultProtocol` and `overrideRegistry`), which is how a mirror, a `file://` registry for tests, or a private registry with a plain name is configured. Credentials for a registry are systemd credentials, never command-line arguments.

## Images: discoverable disk images for older hosts

On hosts older than systemd 260, or on kernels older than 6.13 where a writable overlay layer is not available, the same image runs as a service with `RootImage=`, which mounts a discoverable disk image (DDI, see `systemd-dissect(1)`) as the root. `make-ddi.sh` merges a mount stack into one file system image with `systemd-repart(8)`:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-machined/scripts/make-ddi.sh" /var/lib/machines/acme-app_2026.09.mstack /var/lib/machines/acme-app_2026.09.raw
```

The script mounts the stack read-only with `systemd-mstack --mount --read-only`, runs `systemd-repart` with the definition in `references/repart.d/` (`Type=root`, `Format=erofs`, `CopyFiles=/`, `Minimize=best`), and unmounts. The result is a GPT image with one root partition that `RootImage=` mounts read-only; add `--verity` to sign it with `systemd-repart --verity=` for `RootVerity=` hosts, and `--squashfs` when the host kernel has no erofs. When the plan's `machined.root_form` decision for a host is `ddi`, the service component writes `RootImage=/var/lib/machines/NAME.raw` instead of `RootMStack=`; a read-only root means every writable path the service needs is bound in, which the service and storage components already do for volumes and credentials, with `TemporaryFileSystem=` for scratch paths.

## Machines and virtual machines

A service whose image ships an init system, or that needs its own network namespace with an address on a bridge, macvlan, or ipvlan link, is better run as a machine. The plan records that choice per service (`machined.form`: `service`, `machine`, or `vm`), and this component renders a `.nspawn` file under `/etc/systemd/nspawn/` for the machine with the image as `--mstack=`, the service's command in `[Exec]` (`Parameters=`, `Environment=`, `WorkingDirectory=`, `User=`), `ProcessTwo=yes` where the source used an init shim, `PrivateUsers=pick`, the credentials as `LoadCredential=`, binds for volumes, and `[Network]` settings that attach it to the zone bridge the networkd component renders. The machine is started by `systemd-nspawn@NAME.service` and grouped into the stack target; `machinectl` manages it and `LinkJournal=try-guest` joins its journal to the host's. A virtual machine takes the same image as a bootable DDI and runs it with `systemd-vmspawn`.

## Files

- `scripts/pull-images.sh`: pulls every image in a rendered `images.json` on this host; `--host`, `--class`, `--read-only`, `--user`, `--dry-run`.
- `scripts/make-ddi.sh`: mount stack to DDI; `--squashfs`, `--verity`, `--definitions DIR`.
- `scripts/component.ts`: the component module the render driver composes (images, machines, VMs).
- `references/mstack-layout.md`: the `.mstack/` directory format, versioning with `.v/`, and what `RootMStack=` and `--mstack=` do with it.
- `references/repart.d/10-root.conf`: the partition definition, a single erofs root with `CopyFiles=/`.
