#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Build a bootable discoverable disk image for systemd-vmspawn from a mount stack.
#
# Usage: make-vm-ddi.sh NAME.mstack OUT.raw (--uki FILE | --kernel FILE)
#                       [--modules DIR] [--arch ARCH] [--definitions DIR] [--dry-run]
#
# A virtual machine boots from firmware, so the image needs an EFI system
# partition with something bootable next to the root file system. Nothing
# is downloaded: the operator supplies a unified kernel image (--uki, a UKI
# built with ukify from the kernel, an initrd, and a command line naming the
# root), or a kernel image with an EFI stub (--kernel, which then needs a
# built-in command line and built-in virtio drivers), and optionally the
# matching kernel module tree (--modules /usr/lib/modules/VERSION), which is
# copied into the root at the same path. The mount stack is mounted read-only
# and never modified; the root partition is erofs, so a guest that must write
# boots with systemd.volatile=overlay on its command line.
#
# The bootable file is placed twice in the ESP: at the removable-media
# fallback path EFI/BOOT/BOOT<ARCH>.EFI, which every firmware starts without
# a boot loader, and under EFI/Linux/NAME.efi as a Boot Loader Specification
# type #2 entry. --arch picks the fallback name (x64, aa64, riscv64, ia32,
# arm; default from uname -m). --definitions replaces the shipped
# references/repart.d-vm/ directory. --dry-run prints what would be done,
# runs systemd-repart in its own dry-run mode, and writes nothing.

set -euo pipefail

stack=""
out=""
uki=""
kernel=""
modules=""
arch=""
definitions="$(cd "$(dirname "$0")/../references/repart.d-vm" && pwd)"
dry_run=0

while [ $# -gt 0 ]; do
    case "$1" in
        --uki) uki="$2"; shift 2 ;;
        --kernel) kernel="$2"; shift 2 ;;
        --modules) modules="$2"; shift 2 ;;
        --arch) arch="$2"; shift 2 ;;
        --definitions) definitions="$2"; shift 2 ;;
        --dry-run) dry_run=1; shift ;;
        -h|--help) sed -n '4,26p' "$0"; exit 0 ;;
        -*) echo "unknown argument: $1" >&2; exit 2 ;;
        *)
            if [ -z "$stack" ]; then stack="$1"; elif [ -z "$out" ]; then out="$1"; else echo "unexpected argument: $1" >&2; exit 2; fi
            shift ;;
    esac
done

usage() {
    echo "usage: make-vm-ddi.sh NAME.mstack OUT.raw (--uki FILE | --kernel FILE) [--modules DIR] [--arch ARCH] [--definitions DIR] [--dry-run]" >&2
    exit 2
}

[ -n "$stack" ] && [ -n "$out" ] || usage
if [ -n "$uki" ] && [ -n "$kernel" ]; then
    echo "--uki and --kernel are alternatives; pass one" >&2
    exit 2
fi
[ -n "$uki" ] || [ -n "$kernel" ] || { echo "a bootable image is required: --uki FILE or --kernel FILE" >&2; usage; }
boot="${uki:-$kernel}"
[ -f "$boot" ] || { echo "$boot is not a file" >&2; exit 1; }
[ -d "$stack" ] || { echo "$stack is not a directory" >&2; exit 1; }
[ -z "$modules" ] || [ -d "$modules" ] || { echo "$modules is not a directory" >&2; exit 1; }
[ -d "$definitions" ] || { echo "definitions directory $definitions not found" >&2; exit 1; }
command -v systemd-mstack >/dev/null || { echo "systemd-mstack not found (systemd 260 or later)" >&2; exit 1; }
command -v systemd-repart >/dev/null || { echo "systemd-repart not found" >&2; exit 1; }

# The fallback loader name the UEFI specification assigns to each architecture.
if [ -z "$arch" ]; then
    case "$(uname -m)" in
        x86_64) arch="x64" ;;
        aarch64) arch="aa64" ;;
        riscv64) arch="riscv64" ;;
        i?86) arch="ia32" ;;
        arm*) arch="arm" ;;
        *) echo "cannot derive the EFI architecture from $(uname -m); pass --arch" >&2; exit 1 ;;
    esac
fi
case "$arch" in
    x64|aa64|riscv64|ia32|arm) ;;
    *) echo "unknown EFI architecture $arch (x64, aa64, riscv64, ia32, arm)" >&2; exit 2 ;;
esac
fallback="EFI/BOOT/BOOT$(printf '%s' "$arch" | tr '[:lower:]' '[:upper:]').EFI"
name="$(basename "$stack" .mstack)"

if [ -n "$kernel" ]; then
    echo "note: $kernel is used as the boot image itself; it must carry an EFI stub, a built-in command line naming the root, and built-in virtio drivers (a UKI is the documented way, see ukify)" >&2
fi

# The copy source holds two trees: root/ (the merged stack, read-only) and
# esp/ (what the firmware boots). The definitions copy each into its partition.
source="$(mktemp -d --tmpdir="${TMPDIR:-/var/tmp}" make-vm-ddi.XXXXXX)"
cleanup() {
    systemd-mstack --umount "$source/root" 2>/dev/null || true
    rm -rf "$source"
}
trap cleanup EXIT

mkdir -p "$source/root" "$source/esp/EFI/BOOT" "$source/esp/EFI/Linux"
args=(--definitions="$definitions" --empty=create --size=auto --copy-source="$source")

if [ "$dry_run" -eq 1 ]; then
    echo "would mount $stack read-only at $source/root"
    echo "would copy $boot to esp/$fallback and esp/EFI/Linux/$name.efi"
    [ -z "$modules" ] || echo "would add $modules to the root at /usr/lib/modules/$(basename "$modules") through an extra CopyFiles= line"
    echo "would run: systemd-repart ${args[*]} --dry-run=yes $out"
    systemd-repart "${args[@]}" --dry-run=yes "$out" || echo "systemd-repart's dry run did not complete; read its output above (the definitions in $definitions, the file system tools it needs, or the target)" >&2
    exit 0
fi

systemd-mstack --mount --read-only "$stack" "$source/root"
install -m 0644 "$boot" "$source/esp/$fallback"
install -m 0644 "$boot" "$source/esp/EFI/Linux/$name.efi"
if [ -n "$modules" ]; then
    # The stack is mounted read-only, so the module tree is layered on at copy
    # time through a second CopyFiles= source next to the merged root.
    mkdir -p "$source/modules/usr/lib/modules"
    cp -a "$modules" "$source/modules/usr/lib/modules/$(basename "$modules")"
    extra="$(mktemp -d --tmpdir="$source" definitions.XXXXXX)"
    cp "$definitions"/*.conf "$extra/"
    printf '\nCopyFiles=/modules:/\n' >>"$extra/10-root.conf"
    args=(--definitions="$extra" --empty=create --size=auto --copy-source="$source")
fi
rm -f "$out"
systemd-repart "${args[@]}" --dry-run=no "$out"
echo "wrote $out from $stack with $boot in the ESP ($fallback, EFI/Linux/$name.efi)"
echo "start it with: systemd-vmspawn --image=$out --machine=$name, or through systemd-vmspawn@$name.service with the rendered drop-in"
systemd-dissect "$out" || true
