#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# Every rendered unit for every host must pass systemd-analyze verify, and
# the tmpfiles and sysctl fragments must parse. The renderer's directive
# catalogue check runs in the harness suite; this is the manager's own view.
#
# The units run their commands inside the image (RootMStack=), which is not
# present on a host that has not pulled it, so each host's tree is verified
# under a temporary root that holds the units and a stub for every command
# the units name. That keeps the executable check meaningful for the
# commands that live on the host (systemctl, sh) without pulling images.

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
RENDERED="$FIXTURE/rendered/native"
WORK="$(mktemp -d)"

at_exit() {
    rm -rf "$WORK"
}

trap at_exit EXIT

# stub_commands ROOT UNIT...: create an executable under ROOT for the first
# word of every Exec*= line; a bare name goes to /usr/bin.
stub_commands() {
    local root="$1" line cmd
    shift
    for unit in "$@"; do
        while IFS= read -r line; do
            cmd="${line#*=}"
            cmd="${cmd#[-+:!@]}"
            cmd="${cmd%% *}"
            [[ -n "$cmd" ]] || continue
            if [[ "$cmd" != /* ]]; then
                cmd="/usr/bin/$cmd"
            fi
            mkdir -p "$root$(dirname "$cmd")"
            printf '#!/bin/sh\nexit 0\n' >"$root$cmd"
            chmod +x "$root$cmd"
        done < <(grep -E '^Exec(Start|StartPre|StartPost|Stop|StopPost|Reload|Condition)=' "$unit" || true)
    done
}

for host in "$RENDERED"/hosts/*/; do
    name="$(basename "$host")"
    units="$host/etc/systemd/system"
    test -d "$units"
    root="$WORK/$name"
    mkdir -p "$root/etc/systemd/system"
    cp "$units"/* "$root/etc/systemd/system/"
    stub_commands "$root" "$units"/*.service
    names=()
    for unit in "$units"/*; do
        case "$unit" in
            *.service|*.timer|*.mount|*.target|*.slice) names+=("$(basename "$unit")") ;;
            *) echo "unexpected file $unit" >&2; exit 1 ;;
        esac
    done
    systemd-analyze --root="$root" verify --recursive-errors=no "${names[@]}"

    # Every service unit records where it came from.
    for unit in "$units"/*.service; do
        case "$(basename "$unit")" in
            *-health.service|*-restart.service) continue ;;
        esac
        grep "^\[X-Migration\]" "$unit" >/dev/null
        grep "^Renderer=docker-image-to-service" "$unit" >/dev/null
        grep -E "^Root(MStack|Image)=/var/lib/machines/" "$unit" >/dev/null
    done
    if compgen -G "$host/etc/tmpfiles.d/*.conf" >/dev/null; then
        systemd-tmpfiles --dry-run --create "$host"/etc/tmpfiles.d/*.conf
    fi
    if compgen -G "$host/etc/sysctl.d/*.conf" >/dev/null; then
        for f in "$host"/etc/sysctl.d/*.conf; do
            grep -E '^[a-z][a-z0-9._-]+ = ' "$f" >/dev/null
        done
    fi
    bash -n "$host/install.sh"
    bash -n "$host/secrets/import-credentials.sh"
    jq -e '.units | length > 0' "$host/expected.json" >/dev/null
    echo "verified $name"
done
