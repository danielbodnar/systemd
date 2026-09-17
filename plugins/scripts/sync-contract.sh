#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Vendor the inventory contract into every plugin that consumes it.
#
# Claude Code copies each plugin into its own cache directory on install, so
# plugins cannot share a file. The contract (the inventory JSON Schema, its
# TypeScript types, and the validator) is authored once, under
# docker-swarm-to-systemd/contract/, and copied byte for byte into
# <plugin>/contract/ for every plugin that carries a CHECKSUMS file there.
# The harness test suite fails when a vendored copy drifts from the source.
#
# Usage: sync-contract.sh [--check]
#   --check   verify every vendored copy instead of rewriting it; exit 1 on drift

set -euo pipefail

plugins_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$plugins_dir/docker-swarm-to-systemd/contract"
files=(inventory-schema.json types.ts schema.ts directives.json catalog.ts placement.ts unit.ts)
mode="sync"
[ "${1:-}" = "--check" ] && mode="check"

for f in "${files[@]}"; do
    [ -f "$source_dir/$f" ] || { echo "missing source file $source_dir/$f" >&2; exit 1; }
done

status=0
for marker in "$plugins_dir"/*/contract/CHECKSUMS; do
    [ -f "$marker" ] || continue
    target_dir="$(dirname "$marker")"
    [ "$target_dir" = "$source_dir" ] && continue
    plugin="$(basename "$(dirname "$target_dir")")"
    if [ "$mode" = "check" ]; then
        for f in "${files[@]}"; do
            if ! cmp -s "$source_dir/$f" "$target_dir/$f"; then
                echo "drift: $plugin/contract/$f differs from the source; run scripts/sync-contract.sh" >&2
                status=1
            fi
        done
        (cd "$target_dir" && sha256sum --check --quiet --strict CHECKSUMS) || status=1
        continue
    fi
    for f in "${files[@]}"; do
        install -m 0644 "$source_dir/$f" "$target_dir/$f"
    done
    {
        echo "# Vendored from docker-swarm-to-systemd/contract by scripts/sync-contract.sh."
        echo "# Do not edit these files here; change the source and run the script."
        (cd "$target_dir" && sha256sum "${files[@]}")
    } > "$marker"
    echo "synced contract into $plugin/contract"
done
exit $status
