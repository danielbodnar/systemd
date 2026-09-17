#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Pull the images a rendered tree needs into mount stacks with importctl.
#
# Usage: pull-images.sh IMAGES.json [--host NAME] [--class machine|portable|sysext|confext]
#                                   [--read-only] [--user] [--dry-run]
#
# IMAGES.json is written by docker-image-to-service/scripts/render.ts: an
# object keyed by local image name with ref, digest, and hosts. Images whose
# mount stack already exists are skipped. When the inventory recorded a
# digest the image is pulled by that immutable reference (REPOSITORY@sha256:
# ...), never by the tag, so a re-pushed tag or a tampering registry cannot
# substitute content; an image without a digest is pulled by tag and said so.
# importctl itself verifies nothing beyond the TLS session, which is why the
# pin lives in the reference.

set -euo pipefail

images=""
host=""
class="machine"
read_only=0
user=0
dry_run=0

while [ $# -gt 0 ]; do
    case "$1" in
        --host) host="$2"; shift 2 ;;
        --class) class="$2"; shift 2 ;;
        --read-only) read_only=1; shift ;;
        --user) user=1; shift ;;
        --dry-run) dry_run=1; shift ;;
        -h|--help) sed -n '4,13p' "$0"; exit 0 ;;
        -*) echo "unknown argument: $1" >&2; exit 2 ;;
        *) images="$1"; shift ;;
    esac
done

[ -n "$images" ] && [ -f "$images" ] || { echo "usage: pull-images.sh IMAGES.json [options]" >&2; exit 2; }
command -v importctl >/dev/null || { echo "importctl not found; systemd 256 or later with systemd-importd is required, and pull-oci needs 260" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

case "$class" in
    machine) dir="/var/lib/machines" ;;
    portable) dir="/var/lib/portables" ;;
    sysext) dir="/var/lib/extensions" ;;
    confext) dir="/var/lib/confexts" ;;
    *) echo "unknown class $class" >&2; exit 2 ;;
esac
if [ "$user" -eq 1 ]; then
    dir="${XDG_STATE_HOME:-$HOME/.local/state}/${dir#/var/lib/}"
fi

flags=(--class="$class")
[ "$read_only" -eq 1 ] && flags+=(--read-only)
[ "$user" -eq 1 ] && flags+=(--user)

# immutable_ref REF DIGEST: the reference to pull. With a digest the tag is
# replaced by @DIGEST, so the registry can only serve the content the swarm
# ran; a tag alone is mutable and the caller is told so. A colon inside the
# last path component is a tag; one before it is a registry port.
immutable_ref() {
    local ref="$1" digest="$2" repo
    [ -n "$digest" ] || { printf '%s\n' "$ref"; return; }
    repo="${ref%%@*}"
    case "${repo##*/}" in
        *:*) repo="${repo%:*}" ;;
    esac
    printf '%s@%s\n' "$repo" "$digest"
}

pulled=0
skipped=0
failed=0
while IFS=$'\t' read -r name ref digest hosts; do
    # jq writes "-" for a missing digest: read collapses adjacent tabs, so an
    # empty field would shift the hosts column into $digest.
    [ "$digest" != "-" ] || digest=""
    if [ -n "$host" ] && ! grep -F -x -q -- "$host" <<< "${hosts//,/$'\n'}"; then
        continue
    fi
    if [ -d "$dir/$name.mstack" ]; then
        echo "skip  $name: $dir/$name.mstack exists"
        skipped=$((skipped + 1))
        continue
    fi
    pull_ref="$(immutable_ref "$ref" "$digest")"
    if [ -n "$digest" ]; then
        echo "pull  $name <- $pull_ref (pinned; the inventory saw $ref)"
    else
        echo "pull  $name <- $ref (no digest in the inventory; the tag is mutable)"
    fi
    if [ "$dry_run" -eq 1 ]; then
        echo "      importctl ${flags[*]} pull-oci $pull_ref $name"
        continue
    fi
    if importctl "${flags[@]}" pull-oci "$pull_ref" "$name" && [ -d "$dir/$name.mstack" ]; then
        pulled=$((pulled + 1))
    else
        echo "fail  $name: importctl pull-oci $pull_ref did not produce $dir/$name.mstack" >&2
        rm -rf "$dir/$name.mstack"
        failed=$((failed + 1))
    fi
done < <(jq -r 'to_entries[] | [.key, .value.ref, (.value.digest // "-"), (.value.hosts | join(","))] | @tsv' "$images")

if [ "$dry_run" -eq 0 ]; then
    importctl "${flags[@]}" list-images || true
fi
echo "pulled $pulled, skipped $skipped, failed $failed"
[ "$failed" -eq 0 ]
