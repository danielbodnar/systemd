---
name: oci-image-to-ddi
description: Pack a pulled OCI image (a mount stack) into a discoverable disk image so a service can mount it with RootImage= on hosts older than systemd 260 or kernels older than 6.13, where RootMStack= and a writable overlay layer are not available. Use this whenever the user asks for RootImage=, a DDI, systemd-repart, systemd-dissect, erofs or squashfs images of a container, or needs the native service target on an older host.
---

# OCI image to DDI

`RootMStack=` needs systemd 260 and, for a writable layer, a kernel of 6.13 or later. On older hosts the same image runs as a service with `RootImage=`, which mounts a discoverable disk image (DDI, see `systemd-dissect(1)`) as the root. This skill merges a mount stack into one file system image with `systemd-repart(8)`.

## Building the image

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/oci-image-to-ddi/scripts/make-ddi.sh" /var/lib/machines/acme-app_2026.09.mstack /var/lib/machines/acme-app_2026.09.raw
```

The script mounts the stack read-only with `systemd-mstack --mount --read-only`, runs `systemd-repart` with the definition in `references/repart.d/` (`Type=root`, `Format=erofs`, `CopyFiles=/`, `Minimize=best`), and unmounts. The result is a GPT image with one root partition that `RootImage=` mounts read-only; add `--verity` to sign it with `systemd-repart --verity=` for `RootVerity=` hosts, and `--squashfs` when the host kernel has no erofs.

Then replace `RootMStack=` with `RootImage=` in the rendered unit, or render with `--root-image` so the renderer writes `RootImage=/var/lib/machines/NAME.raw` in the first place. A read-only root means every writable path the service needs must be bound in: the renderer already binds volumes and credentials, and `TemporaryFileSystem=` covers scratch paths.

## Files

- `scripts/make-ddi.sh`: mount stack to DDI; `--squashfs`, `--verity`, `--definitions DIR`.
- `references/repart.d/10-root.conf`: the partition definition, a single erofs root with `CopyFiles=/`.
