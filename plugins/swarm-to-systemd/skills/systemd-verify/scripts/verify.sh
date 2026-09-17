#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# verify.sh: check Quadlet units against expected.json, before or after install.
#
# Usage: verify.sh --expected expected.json [--units DIR] [--host NAME] [--dry-run | --live] [--json]
#
# --dry-run runs the Quadlet generator and systemd-analyze on the given units
# directory without touching the system. --live inspects the running system.

set -uo pipefail

expected=""
units_dir=""
host="$(hostname)"
mode="dry-run"
json=0

while [ $# -gt 0 ]; do
    case "$1" in
        --expected) expected="$2"; shift 2 ;;
        --units) units_dir="$2"; shift 2 ;;
        --host) host="$2"; shift 2 ;;
        --dry-run) mode="dry-run"; shift ;;
        --live) mode="live"; shift ;;
        --json) json=1; shift ;;
        -h|--help)
            sed -n '4,10p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$expected" ] || { echo "--expected is required" >&2; exit 2; }
[ -f "$expected" ] || { echo "expected file not found: $expected" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

if ! jq -e --arg h "$host" '.hosts[$h]' "$expected" >/dev/null; then
    echo "no plan for host $host in $expected (known: $(jq -r '.hosts | keys | join(", ")' "$expected"))" >&2
    exit 2
fi

results=()
fails=0
warns=0

record() {
    # record STATUS CHECK DETAIL
    local status="$1" check="$2" detail="$3"
    case "$status" in
        fail) fails=$((fails + 1)) ;;
        warn) warns=$((warns + 1)) ;;
    esac
    results+=("$(jq -cn --arg s "$status" --arg c "$check" --arg d "$detail" '{status:$s,check:$c,detail:$d}')")
    if [ "$json" -eq 0 ]; then
        printf '%-4s %-28s %s\n' "$status" "$check" "$detail"
    fi
}

find_generator() {
    local g
    for g in /usr/lib/systemd/system-generators/podman-system-generator \
             /usr/libexec/podman/quadlet \
             /usr/lib/podman/quadlet; do
        [ -x "$g" ] && { echo "$g"; return 0; }
    done
    return 1
}

mapfile -t exp_units < <(jq -r --arg h "$host" '.hosts[$h].units[]' "$expected")
mapfile -t exp_containers < <(jq -r --arg h "$host" '.hosts[$h].containers[]' "$expected")
mapfile -t exp_ports < <(jq -r --arg h "$host" '.hosts[$h].ports[] | "\(.port)/\(.protocol)"' "$expected")
mapfile -t exp_networks < <(jq -r --arg h "$host" '.hosts[$h].networks[]' "$expected")
mapfile -t exp_volumes < <(jq -r --arg h "$host" '.hosts[$h].volumes[]' "$expected")
mapfile -t exp_secrets < <(jq -r --arg h "$host" '.hosts[$h].secrets[]' "$expected")

if [ "$mode" = "dry-run" ]; then
    [ -n "$units_dir" ] || units_dir="/etc/containers/systemd"
    [ -d "$units_dir" ] || { echo "units directory not found: $units_dir" >&2; exit 2; }

    for u in "${exp_units[@]}"; do
        base="${u%.service}"
        if ls "$units_dir/$base.container" >/dev/null 2>&1; then
            record ok "unit-file" "$base.container present"
        else
            record fail "unit-file" "$base.container missing from $units_dir"
        fi
    done

    if gen="$(find_generator)"; then
        tmp="$(mktemp -d)"
        if QUADLET_UNIT_DIRS="$units_dir" "$gen" --dryrun > "$tmp/generated.txt" 2> "$tmp/generator.err"; then
            record ok "quadlet-generator" "generated $(grep -c '^---' "$tmp/generated.txt" 2>/dev/null || echo 0) units"
        else
            record fail "quadlet-generator" "$(tr '\n' ' ' < "$tmp/generator.err" | cut -c1-300)"
        fi
        if command -v systemd-analyze >/dev/null; then
            # Split the dry-run output into files so systemd-analyze can read them.
            awk -v dir="$tmp" '/^---[^-]/{ f=$2; sub(/^.*\//,"",f); out=dir "/" f; next } out { print > out }' "$tmp/generated.txt"
            for u in "${exp_units[@]}"; do
                if [ -f "$tmp/$u" ]; then
                    if err="$(systemd-analyze verify "$tmp/$u" 2>&1)"; then
                        record ok "systemd-analyze" "$u"
                    else
                        record warn "systemd-analyze" "$u: $(echo "$err" | head -1 | cut -c1-200)"
                    fi
                fi
            done
        else
            record warn "systemd-analyze" "not installed; skipping"
        fi
        rm -rf "$tmp"
    else
        record warn "quadlet-generator" "podman-system-generator not found; is Podman installed?"
    fi

    if command -v podman >/dev/null; then
        record ok "podman" "$(podman --version)"
        for s in "${exp_secrets[@]}"; do
            if podman secret exists "$s" 2>/dev/null; then
                record ok "secret" "$s exists"
            else
                record warn "secret" "$s not yet imported (run secrets/import-secrets.sh before starting)"
            fi
        done
    else
        record fail "podman" "podman not installed on this host"
    fi
fi

if [ "$mode" = "live" ]; then
    command -v podman >/dev/null || { record fail "podman" "podman not installed"; }
    for u in "${exp_units[@]}"; do
        state="$(systemctl is-active "$u" 2>/dev/null || true)"
        if [ "$state" = "active" ]; then
            record ok "unit-active" "$u"
        else
            record fail "unit-active" "$u is $state ($(systemctl show -p Result --value "$u" 2>/dev/null))"
        fi
    done
    for c in "${exp_containers[@]}"; do
        if podman container exists "$c" 2>/dev/null; then
            health="$(podman inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null)"
            running="$(podman inspect --format '{{.State.Running}}' "$c" 2>/dev/null)"
            case "$health" in
                healthy) record ok "container-health" "$c healthy" ;;
                none) [ "$running" = "true" ] && record ok "container-health" "$c running (no healthcheck)" || record fail "container-health" "$c not running" ;;
                starting) record warn "container-health" "$c still starting" ;;
                *) record fail "container-health" "$c is $health" ;;
            esac
        else
            record fail "container-exists" "$c not found"
        fi
    done
    listening="$(ss -ltunH 2>/dev/null | awk '{print $1, $5}')"
    for p in "${exp_ports[@]}"; do
        port="${p%/*}"; proto="${p#*/}"
        if echo "$listening" | awk -v port="$port" -v proto="$proto" '$1==proto && $2 ~ (":" port "$") {found=1} END{exit !found}'; then
            record ok "port-listening" "$p"
        else
            record fail "port-listening" "$p not listening"
        fi
    done
    for n in "${exp_networks[@]}"; do
        podman network exists "$n" 2>/dev/null && record ok "network" "$n" || record fail "network" "$n missing"
    done
    for v in "${exp_volumes[@]}"; do
        podman volume exists "$v" 2>/dev/null && record ok "volume" "$v" || record fail "volume" "$v missing"
    done
    for s in "${exp_secrets[@]}"; do
        podman secret exists "$s" 2>/dev/null && record ok "secret" "$s" || record fail "secret" "$s missing"
    done
    for u in "${exp_units[@]}"; do
        restarts="$(systemctl show -p NRestarts --value "$u" 2>/dev/null || echo 0)"
        if [ "${restarts:-0}" -gt 3 ]; then
            record warn "restart-loop" "$u restarted $restarts times"
        fi
    done
fi

if [ "$json" -eq 1 ]; then
    printf '%s\n' "${results[@]}" | jq -s --arg host "$host" --arg mode "$mode" --argjson fails "$fails" --argjson warns "$warns" \
        '{host:$host, mode:$mode, failures:$fails, warnings:$warns, checks:.}'
else
    echo "host=$host mode=$mode checks=${#results[@]} failures=$fails warnings=$warns"
fi

[ "$fails" -eq 0 ]
