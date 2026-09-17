#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Regenerate the committed fixtures under test/test-container-migration/ from
# the capture: inventory.json (normalized) and rendered/native/ (the native
# service tree). The integration test consumes the committed files, so it
# needs no Bun; the harness test suite fails when they drift from a fresh
# render. Run this after changing the capture, the normalizer, or a renderer.
#
# Usage: render-fixtures.sh [--check]

set -euo pipefail

plugins_dir="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$plugins_dir/../test/test-container-migration"
normalize="$plugins_dir/systemd-migration/skills/discover-docker-swarm/scripts/normalize.ts"
render_native="$plugins_dir/systemd-migration/skills/systemd-service/scripts/render.ts"
mode="write"
[ "${1:-}" = "--check" ] && mode="check"

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }

work="$(mktemp -d --tmpdir="${TMPDIR:-$plugins_dir/../.tmp}" fixtures.XXXXXX 2>/dev/null || mktemp -d)"
trap 'rm -rf "$work"' EXIT

bun "$normalize" "$fixture/capture" -o "$work/inventory.json" >/dev/null
bun "$render_native" "$work/inventory.json" -o "$work/native" >/dev/null

if [ "$mode" = "check" ]; then
    status=0
    cmp -s "$work/inventory.json" "$fixture/inventory.json" || { echo "drift: inventory.json differs from a fresh normalize" >&2; status=1; }
    diff -r "$work/native" "$fixture/rendered/native" >/dev/null || { echo "drift: rendered/native differs from a fresh render" >&2; status=1; }
    exit $status
fi

install -m 0644 "$work/inventory.json" "$fixture/inventory.json"
rm -rf "$fixture/rendered/native"
mkdir -p "$fixture/rendered"
cp -a "$work/native" "$fixture/rendered/native"
echo "wrote $fixture/inventory.json and $fixture/rendered/native"
