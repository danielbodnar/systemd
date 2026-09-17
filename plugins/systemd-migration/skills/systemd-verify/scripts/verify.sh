#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# verify.sh: check a host's rendered or installed units against expected.json.
#
# Usage: verify.sh --expected expected.json [--units DIR] [--host NAME]
#                  [--engine native|quadlet] [--dry-run | --live] [--json]
#
# expected.json comes from the render driver: one entry per host with the
# units, targets, slices, timers, mounts, sockets, machines, images,
# credentials, volumes, and ports the host should carry (native engine), or
# the units, containers, networks, volumes, and secrets of a Quadlet tree
# (quadlet engine). The engine is read from the host's entry unless --engine
# says otherwise.
#
# --dry-run checks the rendered tree without touching the system: every
# expected file is present, systemd-analyze verify accepts the units (under
# a temporary root with a stub for every command they name, so images that
# are not pulled yet do not fail the check), and the images, credentials,
# and volumes the units need are reported as present or still to import.
# --live inspects the running system after install.sh: unit and machine
# state, health results, listening ports, credentials, volumes, restart loops.

set -uo pipefail

expected=""
units_dir=""
host="$(hostname)"
mode="dry-run"
engine=""
json=0

while [ $# -gt 0 ]; do
    case "$1" in
        --expected) expected="$2"; shift 2 ;;
        --units) units_dir="$2"; shift 2 ;;
        --host) host="$2"; shift 2 ;;
        --engine) engine="$2"; shift 2 ;;
        --dry-run) mode="dry-run"; shift ;;
        --live) mode="live"; shift ;;
        --json) json=1; shift ;;
        -h|--help)
            sed -n '4,22p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$expected" ] || { echo "--expected is required" >&2; exit 2; }
[ -f "$expected" ] || { echo "expected file not found: $expected" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

# The native render driver keys hosts at the top level; the Quadlet renderer
# keeps them under .hosts. Either way the host's entry is what is checked.
host_entry='(if has("hosts") then .hosts else . end)[$h]'
if ! jq -e --arg h "$host" "$host_entry" "$expected" >/dev/null; then
    echo "no plan for host $host in $expected (known: $(jq -r '(if has("hosts") then .hosts else . end) | keys | join(", ")' "$expected"))" >&2
    exit 2
fi
if [ -z "$engine" ]; then
    if jq -e --arg h "$host" "$host_entry | has(\"containers\")" "$expected" >/dev/null; then
        engine="quadlet"
    else
        engine="native"
    fi
fi
case "$engine" in
    native|quadlet) ;;
    *) echo "unknown engine: $engine (native or quadlet)" >&2; exit 2 ;;
esac

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

expect_list() {
    # expect_list FIELD: the host's array FIELD, one entry per line, empty when absent
    jq -r --arg h "$host" "$host_entry | .$1 // [] | .[]" "$expected"
}

mapfile -t exp_units < <(expect_list units)
mapfile -t exp_ports < <(jq -r --arg h "$host" "$host_entry | .ports // [] | .[] | \"\(.port)/\(.protocol)\"" "$expected")
mapfile -t exp_volumes < <(expect_list volumes)

check_ports() {
    local listening p port proto
    listening="$(ss -ltunSH 2>/dev/null | awk '{print $1, $5}')"
    for p in "${exp_ports[@]}"; do
        port="${p%/*}"; proto="${p#*/}"
        if echo "$listening" | awk -v port="$port" -v proto="$proto" '$1==proto && $2 ~ (":" port "$") {found=1} END{exit !found}'; then
            record ok "port-listening" "$p"
        else
            record fail "port-listening" "$p not listening"
        fi
    done
}

check_restart_loops() {
    local u restarts
    for u in "${exp_units[@]}"; do
        restarts="$(systemctl show -p NRestarts --value "$u" 2>/dev/null || echo 0)"
        if [ "${restarts:-0}" -gt 3 ]; then
            record warn "restart-loop" "$u restarted $restarts times"
        fi
    done
}

# ---------------------------------------------------------------- native ----

# stub_commands ROOT UNIT...: create an executable under ROOT for the first
# word of every Exec*= line so systemd-analyze --root can resolve it; a bare
# name goes to /usr/bin. The units run inside an image that need not be
# present on the host at verification time.
stub_commands() {
    local root="$1" line cmd unit
    shift
    for unit in "$@"; do
        while IFS= read -r line; do
            cmd="${line#*=}"
            cmd="${cmd#[-+:!@]}"
            cmd="${cmd%% *}"
            [ -n "$cmd" ] || continue
            case "$cmd" in
                /*) ;;
                *) cmd="/usr/bin/$cmd" ;;
            esac
            mkdir -p "$root$(dirname "$cmd")"
            printf '#!/bin/sh\nexit 0\n' > "$root$cmd"
            chmod +x "$root$cmd"
        done < <(grep -E '^Exec(Start|StartPre|StartPost|Stop|StopPost|Reload|Condition)=' "$unit" 2>/dev/null || true)
    done
}

native_dry_run() {
    local tree u kind names=() tmp err m img c v
    [ -n "$units_dir" ] || units_dir="/etc/systemd/system"
    [ -d "$units_dir" ] || { echo "units directory not found: $units_dir" >&2; exit 2; }
    tree="$(cd "$units_dir/../.." && pwd)"   # the host's etc/

    for kind in units targets slices timers mounts sockets; do
        while IFS= read -r u; do
            [ -n "$u" ] || continue
            if [ -f "$units_dir/$u" ]; then
                record ok "unit-file" "$u present"
                names+=("$u")
            else
                record fail "unit-file" "$u missing from $units_dir"
            fi
        done < <(expect_list "$kind")
    done
    while IFS= read -r m; do
        [ -n "$m" ] || continue
        if [ -f "$tree/systemd/nspawn/$m.nspawn" ]; then
            record ok "machine-file" "$m.nspawn present"
        else
            record fail "machine-file" "$m.nspawn missing from $tree/systemd/nspawn"
        fi
    done < <(expect_list machines)

    if command -v systemd-analyze >/dev/null; then
        if [ "${#names[@]}" -gt 0 ]; then
            tmp="$(mktemp -d)"
            mkdir -p "$tmp/etc/systemd/system"
            cp -a "$units_dir/." "$tmp/etc/systemd/system/"
            stub_commands "$tmp" "$units_dir"/*.service
            if err="$(systemd-analyze --root="$tmp" verify --recursive-errors=no "${names[@]}" 2>&1)"; then
                record ok "systemd-analyze" "${#names[@]} units verified"
            else
                # Every line names the unit and the directive; an unknown key on an
                # older systemd is the usual cause and the root-form decision the fix.
                record fail "systemd-analyze" "$(echo "$err" | grep -v '^$' | sed "s|^$tmp||" | tr '\n' ';' | cut -c1-400)"
            fi
            rm -rf "$tmp"
        fi
    else
        record warn "systemd-analyze" "not installed; skipping"
    fi

    while IFS= read -r img; do
        [ -n "$img" ] || continue
        if [ -e "$img" ]; then
            record ok "image" "$img present"
        else
            record warn "image" "$img not pulled yet (run pull-images.sh before install.sh)"
        fi
    done < <(expect_list images)
    while IFS= read -r c; do
        [ -n "$c" ] || continue
        if [ -e "/etc/credstore.encrypted/$c" ] || [ -e "/etc/credstore/$c" ]; then
            record ok "credential" "$c in the credential store"
        else
            record warn "credential" "$c not yet imported (run secrets/import-credentials.sh before starting)"
        fi
    done < <(expect_list credentials)
    for v in "${exp_volumes[@]}"; do
        if [ -d "$v" ]; then
            record ok "volume" "$v present"
        else
            record warn "volume" "$v absent; install.sh creates it through tmpfiles, move the data before starting"
        fi
    done
    if [ -f "$tree/../install.sh" ]; then
        if bash -n "$tree/../install.sh" 2>/dev/null; then
            record ok "install-script" "install.sh parses"
        else
            record fail "install-script" "install.sh does not parse"
        fi
    fi
}

native_live() {
    local u kind state result m c v
    for kind in units targets slices timers mounts sockets; do
        while IFS= read -r u; do
            [ -n "$u" ] || continue
            case "$u" in
                *-health.service|*-restart.service)
                    # Oneshot units driven by a timer are inactive between runs; their last result is what matters.
                    result="$(systemctl show -p Result --value "$u" 2>/dev/null)"
                    if [ "$result" = "success" ]; then
                        record ok "unit-result" "$u last run succeeded"
                    else
                        record fail "unit-result" "$u last result is ${result:-unknown}"
                    fi
                    ;;
                *)
                    state="$(systemctl is-active "$u" 2>/dev/null || true)"
                    if [ "$state" = "active" ]; then
                        record ok "unit-active" "$u"
                    else
                        record fail "unit-active" "$u is ${state:-unknown} ($(systemctl show -p Result --value "$u" 2>/dev/null))"
                    fi
                    ;;
            esac
        done < <(expect_list "$kind")
    done
    while IFS= read -r m; do
        [ -n "$m" ] || continue
        state="$(machinectl show -p State --value "$m" 2>/dev/null || true)"
        if [ "$state" = "running" ]; then
            record ok "machine-running" "$m"
        else
            record fail "machine-running" "$m is ${state:-not registered}"
        fi
    done < <(expect_list machines)
    check_ports
    while IFS= read -r c; do
        [ -n "$c" ] || continue
        if [ -e "/etc/credstore.encrypted/$c" ] || [ -e "/etc/credstore/$c" ]; then
            record ok "credential" "$c"
        else
            record fail "credential" "$c missing from the credential store"
        fi
    done < <(expect_list credentials)
    for v in "${exp_volumes[@]}"; do
        [ -d "$v" ] && record ok "volume" "$v" || record fail "volume" "$v missing"
    done
    check_restart_loops
}

# --------------------------------------------------------------- quadlet ----

find_generator() {
    local g
    for g in /usr/lib/systemd/system-generators/podman-system-generator \
             /usr/libexec/podman/quadlet \
             /usr/lib/podman/quadlet; do
        [ -x "$g" ] && { echo "$g"; return 0; }
    done
    return 1
}

quadlet_dry_run() {
    local u base gen tmp err s
    mapfile -t exp_secrets < <(expect_list secrets)
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
                        record fail "systemd-analyze" "$u: $(echo "$err" | head -1 | cut -c1-200)"
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
}

quadlet_live() {
    local u state c health running n v s
    mapfile -t exp_containers < <(expect_list containers)
    mapfile -t exp_networks < <(expect_list networks)
    mapfile -t exp_secrets < <(expect_list secrets)
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
    check_ports
    for n in "${exp_networks[@]}"; do
        podman network exists "$n" 2>/dev/null && record ok "network" "$n" || record fail "network" "$n missing"
    done
    for v in "${exp_volumes[@]}"; do
        podman volume exists "$v" 2>/dev/null && record ok "volume" "$v" || record fail "volume" "$v missing"
    done
    for s in "${exp_secrets[@]}"; do
        podman secret exists "$s" 2>/dev/null && record ok "secret" "$s" || record fail "secret" "$s missing"
    done
    check_restart_loops
}

case "$engine-$mode" in
    native-dry-run) native_dry_run ;;
    native-live) native_live ;;
    quadlet-dry-run) quadlet_dry_run ;;
    quadlet-live) quadlet_live ;;
esac

if [ "$json" -eq 1 ]; then
    printf '%s\n' "${results[@]}" | jq -s --arg host "$host" --arg mode "$mode" --arg engine "$engine" --argjson fails "$fails" --argjson warns "$warns" \
        '{host:$host, mode:$mode, engine:$engine, failures:$fails, warnings:$warns, checks:.}'
else
    echo "host=$host engine=$engine mode=$mode checks=${#results[@]} failures=$fails warnings=$warns"
fi

[ "$fails" -eq 0 ]
