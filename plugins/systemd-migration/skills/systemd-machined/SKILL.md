---
name: systemd-machined
description: The machines component. Pull the OCI images an estate uses into systemd mount stacks with importctl pull-oci (pinned to the inventory's digests, versioned for rollback), pack them into discoverable disk images for hosts without mount stacks, run a service as a machine (systemd-nspawn with a .nspawn file carrying its binds, credentials, capabilities and limits, registered with machined) or as a virtual machine (systemd-vmspawn over a bootable DDI built by make-vm-ddi.sh) when the plan selects that form. Use this whenever the user asks about importctl, pull-oci, .mstack, systemd-mstack, RootMStack=, RootImage=, DDIs, systemd-repart, systemd-dissect, nspawn, .nspawn files, vmspawn, machinectl, --load-credential, or how to get an image onto a host and run it in its own namespaces.
---

# systemd-machined

The machines component owns three things: images (how an OCI image becomes something systemd can mount), machines (a service that runs under `systemd-nspawn` in its own PID and network namespace), and virtual machines (`systemd-vmspawn`). The planner decides per service which form it takes (`form.service.<name>`: `service`, `machine`, or `vm`); this skill renders the chosen form and provides the scripts that put the images in place.

## Images: mount stacks

`importctl pull-oci` (systemd 260 and later) downloads an OCI image from a registry into the image directory of a class and writes a mount stack: a directory `NAME.mstack/` holding one `layer@N` symlink per image layer and, unless the image was imported read-only, a writable `rw/` layer on top. `systemd-nspawn --mstack=` and `RootMStack=` in a service consume it directly; nothing unpacks or flattens the image. The writable layer needs overlayfs `FSCONFIG_SET_FD` support, which means a kernel of 6.13 or later; `discover-systemd-hosts` records whether a host has it, and the planner falls back to a DDI (below) where it does not.

The render driver writes `images.json` next to the rendered tree: one entry per distinct image reference with the local name the units expect, the digest the inventory recorded, the hosts that need it, and the services that use it. On each host:

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

The script mounts the stack read-only with `systemd-mstack --mount --read-only`, runs `systemd-repart` with the definition in `references/repart.d/` (`Type=root`, `Format=erofs`, `CopyFiles=/`, `Minimize=best`), and unmounts. The result is a GPT image with one root partition that `RootImage=` mounts read-only; add `--verity` to sign it with `systemd-repart --verity=` for `RootVerity=` hosts, and `--squashfs` when the host kernel has no erofs. When the plan's `machined.root_form` decision for a host is `ddi`, the service component writes `RootImage=/var/lib/machines/NAME.raw` instead of `RootMStack=`, and a machine on that host runs with `--image=` instead of `--mstack=`; a read-only root means every writable path the service needs is bound in, which the service and storage components already do for volumes and credentials, with `TemporaryFileSystem=` for scratch paths.

## Machines

A service whose image ships an init system, or that needs its own network namespace with an address on a bridge, macvlan, or ipvlan link, is better run as a machine. When the plan chooses `machine` for a service, this component renders two files per instance and the stack target wants the second:

- `/etc/systemd/nspawn/<name>.nspawn`, read by `systemd-nspawn` for the machine of that name. Placed under `/etc/systemd/nspawn/` it is trusted, so the privileged settings (`Bind=`, `Capability=`, `PrivateUsers=`, `Zone=`) take effect.
- `/etc/systemd/system/systemd-nspawn@<name>.service.d/10-migration.conf`, a drop-in on the shipped template unit that resets `ExecStart=` to `systemd-nspawn --quiet --keep-unit --mstack=<image> --machine=%i --settings=override` (or `--image=` on a DDI host), groups the unit into the stack (`PartOf=<stack>.target`, `ConditionHost=`, `Slice=stack-<stack>.slice`), loads the credentials, and sets the limits.

The `.nspawn` file's `[Exec]` section holds the service's command as `Parameters=` (the payload runs as PID 1, since the command line carries no `--boot`), `ProcessTwo=yes` where the source used an init shim, `PrivateUsers=pick`, `Hostname=`, `WorkingDirectory=`, `User=` (the uid part of a Docker `uid:gid`; the group comes from the container's user database), `Environment=` for the image's and the service's plain variables, `Capability=` from `cap_add`, `DropCapability=` from `cap_drop` (`ALL` becomes `all`), `Limit*=` from the ulimits, and `LinkJournal=try-guest` so the machine's journal joins the host's. `[Files]` holds `ReadOnly=yes` for a read-only container, `Bind=` or `BindReadOnly=` for each volume at `<storage state dir>/<stack>/<volume>` (the storage component's `storage.state_dir.estate` decision; the directory is created by `/etc/tmpfiles.d/<stack>-machines.conf` owned by the machine's uid), for each host bind mount, and for each config at `/etc/<stack>/configs/<name>`, and `TemporaryFileSystem=` for tmpfs mounts. Volumes are bound with the `idmap` option so the machine's users own them as they did in the container; the source file system must support ID-mapped mounts. A device bind is also allowed on the drop-in with `DeviceAllow=`, because the template runs with `DevicePolicy=closed`. `[Network]` carries only what the networkd component decided for the service (`networkd.zone.<service>`): `Zone=<name>` attaches the machine to that zone bridge, the value `host` renders `Private=no` so the machine shares the host's network namespace, and no decision leaves the section empty, which also means the host's namespace. The networkd component adds its own lines to the same files afterwards (`Port=` for the published ports of a zoned machine, the bridge's `.network` file, a fixed MAC on the drop-in for the DHCP lease); this component never raises network decisions itself.

Credentials use the mechanism the man pages document: `systemd.nspawn(5)` has no credential setting, and `systemd-nspawn(1)` takes `--load-credential=ID:PATH` and `--set-credential=ID:VALUE` on the command line, propagating credentials it received itself as a service into the machine. The drop-in therefore loads each credential on `systemd-nspawn@<name>.service` with `LoadCredentialEncrypted=NAME:/etc/credstore.encrypted/NAME` (or `LoadCredential=NAME:/etc/credstore/NAME` when the plan's `creds.store.NAME` decision is `credstore`), and the `ExecStart=` line passes `--load-credential=NAME:%d/NAME`, where `%d` is the unit's own credentials directory holding the decrypted value. Inside the machine the payload finds each credential at `/run/host/credentials/NAME`, which is also `$CREDENTIALS_DIRECTORY`; a redacted environment variable gets `Environment=VAR_FILE=/run/host/credentials/NAME`, and a Docker secret's mount path (`/run/secrets/...`) is not reproduced, which the notes say. Because `systemd-nspawn` can only make credentials readable to a non-root payload when it runs as PID 1 with no new privileges, a machine that loads credentials and runs as a user gets `NoNewPrivileges=yes` and no `ProcessTwo=yes` even when the source used an init shim; the notes record that too. Resource limits (`CPUQuota=`, `MemoryMax=`, `MemoryLow=`, `TasksMax=`) go on the drop-in's `[Service]` section, since `systemd.resource-control(5)` applies to the unit, not to the `.nspawn` file. A healthcheck is not rendered for a machine; the notes suggest a timer running `machinectl shell` or `sd_notify` from the payload.

`machinectl` manages the running machine (`machinectl list`, `status`, `shell`, `terminate`), and `expected.json` lists it under `machines` so the verifier can check it is registered. The rendered `.nspawn` files use only directives that `systemd.nspawn(5)` documents; the harness checks every one against the directive catalogue as type `nspawn` and every drop-in as type `service`.

## Virtual machines

When the plan chooses `vm`, the same service runs under `systemd-vmspawn` from a bootable DDI, and this component renders `/etc/systemd/system/systemd-vmspawn@<name>.service.d/10-migration.conf`: `ExecStart=` is reset to `systemd-vmspawn --quiet --register=yes --keep-unit --network-tap --image=<image dir>/<name>-vm.raw --machine=%i`, with `--cpus=` (the service's CPU limit rounded up to whole CPUs) and `--ram=` (its memory limit) when the source set limits, both documented in `systemd-vmspawn(1)`; the `[Unit]` section carries `PartOf=`, `ConditionHost=`, and `RequiresMountsFor=` the image directory, and `[Service]` the stack slice. The bootable image is named `<name>-vm.raw` so it never collides with the application DDI `<name>.raw` that `make-ddi.sh` builds for `RootImage=` hosts.

A virtual machine boots from firmware, so the application image alone cannot run: `make-vm-ddi.sh` builds a bootable DDI from the mount stack and boot material the operator supplies (nothing is downloaded):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-machined/scripts/make-vm-ddi.sh" /var/lib/machines/acme-app_2026.09.mstack /var/lib/machines/acme-app_2026.09-vm.raw --uki /path/to/acme-app.efi --modules /usr/lib/modules/6.15.0
bash "${CLAUDE_PLUGIN_ROOT}/skills/systemd-machined/scripts/make-vm-ddi.sh" NAME.mstack OUT.raw --uki FILE --dry-run   # print the steps and repart's plan only
```

The script mounts the stack read-only, stages the UKI (or, with `--kernel`, an EFI-stub kernel image with a built-in command line and drivers) in an ESP tree at the removable-media fallback path `EFI/BOOT/BOOT<ARCH>.EFI`, which every firmware starts without a boot loader, and at `EFI/Linux/<name>.efi` as a Boot Loader Specification type #2 entry, then runs `systemd-repart` with `references/repart.d-vm/` (an ESP with `Format=vfat` copying the staged tree, and an erofs root copying the merged stack plus the optional kernel module tree). The mount stack is never modified. The result is what the drop-in's `--image=` names; the guest still needs an init system and a service that starts the payload, and it needs `systemd.volatile=overlay` on its command line if it must write to the root, which the rendered decision note spells out. Mounts and credentials of a virtual machine are not rendered; the notes say which `systemd-vmspawn` options (`--bind=`, `--load-credential=`) carry them once the guest reads them.

## Files

- `scripts/pull-images.sh`: pulls every image in a rendered `images.json` on this host; `--host`, `--class`, `--read-only`, `--user`, `--dry-run`.
- `scripts/make-ddi.sh`: mount stack to an application DDI for `RootImage=` and `--image=`; `--squashfs`, `--verity`, `--definitions DIR`.
- `scripts/make-vm-ddi.sh`: mount stack plus an operator-supplied UKI (`--uki FILE`) or EFI-stub kernel (`--kernel FILE`) and optional module tree (`--modules DIR`) to a bootable DDI for `systemd-vmspawn`; `--arch`, `--definitions DIR`, `--dry-run`. Read-only on the stack; writes only the output image.
- `scripts/component.ts`: the component module the render driver composes (images, machines, virtual machines).
- `references/mstack-layout.md`: the `.mstack/` directory format, versioning with `.v/`, and what `RootMStack=` and `--mstack=` do with it.
- `references/repart.d/10-root.conf`: the partition definition for `make-ddi.sh`, a single erofs root with `CopyFiles=/`.
- `references/repart.d-vm/00-esp.conf`, `references/repart.d-vm/10-root.conf`: the definitions for `make-vm-ddi.sh`, a vfat ESP copying the staged boot tree and an erofs root copying the merged stack.
