#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Merge a mount stack into a discoverable disk image for RootImage=.
#
# Usage: make-ddi.sh NAME.mstack OUT.raw [--squashfs] [--verity] [--definitions DIR]
#
# Mounts the stack read-only with systemd-mstack, copies the merged tree into
# a single root partition with systemd-repart, and unmounts. --squashfs picks
# squashfs over erofs; --verity adds a signed Verity partition (systemd-repart
# --verity=); --definitions replaces the shipped repart.d directory.

set -euo pipefail

stack=""
out=""
fs="erofs"
verity=0
definitions="$(cd "$(dirname "$0")/../references/repart.d" && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --squashfs) fs="squashfs"; shift ;;
        --verity) verity=1; shift ;;
        --definitions) definitions="$2"; shift 2 ;;
        -h|--help) sed -n '4,11p' "$0"; exit 0 ;;
        -*) echo "unknown argument: $1" >&2; exit 2 ;;
        *)
            if [ -z "$stack" ]; then stack="$1"; elif [ -z "$out" ]; then out="$1"; else echo "unexpected argument: $1" >&2; exit 2; fi
            shift ;;
    esac
done

[ -n "$stack" ] && [ -n "$out" ] || { echo "usage: make-ddi.sh NAME.mstack OUT.raw [options]" >&2; exit 2; }
[ -d "$stack" ] || { echo "$stack is not a directory" >&2; exit 1; }
command -v systemd-mstack >/dev/null || { echo "systemd-mstack not found (systemd 260 or later)" >&2; exit 1; }
command -v systemd-repart >/dev/null || { echo "systemd-repart not found" >&2; exit 1; }
[ -d "$definitions" ] || { echo "definitions directory $definitions not found" >&2; exit 1; }

mnt="$(mktemp -d --tmpdir="${TMPDIR:-/var/tmp}" make-ddi.XXXXXX)"
cleanup() {
    systemd-mstack --umount "$mnt" 2>/dev/null || true
    rmdir "$mnt" 2>/dev/null || true
}
trap cleanup EXIT

systemd-mstack --mount --read-only "$stack" "$mnt"

args=(--definitions="$definitions" --empty=create --size=auto --copy-source="$mnt" --dry-run=no)
if [ "$fs" = "squashfs" ]; then
    args+=(--defer-partitions=no)
    export SYSTEMD_REPART_FORMAT_OVERRIDE=squashfs
fi
if [ "$verity" -eq 1 ]; then
    args+=(--verity=yes)
fi
rm -f "$out"
systemd-repart "${args[@]}" "$out"
echo "wrote $out from $stack ($fs)"
systemd-dissect "$out" || true
