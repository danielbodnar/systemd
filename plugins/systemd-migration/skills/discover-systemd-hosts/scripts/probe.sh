#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Probe what a target host's systemd can do and write it as JSON for the
# planner: systemd version and compile-time features, kernel, architecture,
# OS, cgroup hierarchy, overlayfs mount-stack support, which daemons and
# tools are installed, which image directories exist, and the host's
# addresses. The planner reads the file as plan.yaml's hosts.<name> and
# picks targets from it (mount stacks or disk images, whether networkd or
# resolved are available, which forms a service may take).
#
# Usage: probe.sh [-o DIR] [--ssh USER@HOST]...
#
#   -o DIR       write <hostname>.json into DIR (default: .)
#   --ssh HOST   run the probe on HOST over ssh (repeatable) instead of here;
#                the script is sent on stdin, nothing is installed remotely
#
# Read-only: the probe runs no command that changes the host. It needs only a
# POSIX shell, coreutils, and systemctl; ip(8) is used when present.

set -euo pipefail

outdir="."
remotes=()
while [ $# -gt 0 ]; do
    case "$1" in
        -o) outdir="$2"; shift 2 ;;
        --ssh) remotes+=("$2"); shift 2 ;;
        -h|--help) sed -n '4,19p' "$0"; exit 0 ;;
        --local) shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

json_str() {
    # Escape backslashes, double quotes, and control characters for a JSON string.
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr -d '\r\n'
}

json_list() {
    local first=1 item
    printf '['
    for item in "$@"; do
        [ "$first" -eq 1 ] || printf ', '
        first=0
        printf '"%s"' "$(json_str "$item")"
    done
    printf ']'
}

has_bin() { command -v "$1" >/dev/null 2>&1; }

has_daemon() {
    local name="$1" dir
    for dir in /usr/lib/systemd /lib/systemd /usr/libexec/systemd; do
        [ -x "$dir/systemd-$name" ] && return 0
    done
    return 1
}

unit_state() {
    local unit="$1" enabled active
    enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    printf '%s/%s' "${enabled:-absent}" "${active:-inactive}"
}

probe_local() {
    local hostname version_line features_line version kernel major minor arch
    local os_id="" os_version="" os_pretty="" cgroup2 fsconfig
    hostname="$(hostname)"
    version_line="$(systemctl --version 2>/dev/null | sed -n 1p)"
    features_line="$(systemctl --version 2>/dev/null | sed -n 2p)"
    version="$(printf '%s' "$version_line" | sed -n 's/^systemd \([0-9][0-9]*\).*/\1/p')"
    kernel="$(uname -r)"
    major="$(printf '%s' "$kernel" | cut -d. -f1)"
    minor="$(printf '%s' "$kernel" | cut -d. -f2 | sed 's/[^0-9].*//')"
    arch="$(uname -m)"
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        os_id="$(. /etc/os-release; printf '%s' "${ID:-}")"
        os_version="$(. /etc/os-release; printf '%s' "${VERSION_ID:-}")"
        os_pretty="$(. /etc/os-release; printf '%s' "${PRETTY_NAME:-}")"
    fi
    if [ "$(stat -f -c %T /sys/fs/cgroup 2>/dev/null)" = "cgroup2fs" ]; then cgroup2=true; else cgroup2=false; fi
    # Writable mount stacks need overlayfs FSCONFIG_SET_FD, which arrived in 6.13;
    # there is no cheap way to ask the kernel from a shell, so the version decides.
    if [ -n "$major" ] && [ -n "$minor" ]; then
        if [ "$major" -gt 6 ] || { [ "$major" -eq 6 ] && [ "$minor" -ge 13 ]; }; then fsconfig=true; else fsconfig=false; fi
    else
        fsconfig=null
    fi

    local features=()
    for f in $features_line; do
        case "$f" in
            +*|-*) features+=("$f") ;;
        esac
    done

    local daemons=() notes=()
    for d in networkd resolved machined importd portabled journald homed timesyncd oomd userdbd logind udevd; do
        if has_daemon "$d"; then daemons+=("\"$d\": true"); else daemons+=("\"$d\": false"); fi
    done
    for u in systemd-networkd.service systemd-resolved.service systemd-machined.service systemd-importd.service systemd-portabled.service systemd-sysext.service systemd-confext.service; do
        notes+=("$u: $(unit_state "$u")")
    done

    local tools=()
    for t in systemd-nspawn systemd-vmspawn importctl machinectl portablectl systemd-repart systemd-creds systemd-sysext systemd-confext systemd-dissect systemd-mstack systemd-analyze systemd-tmpfiles systemd-sysusers resolvectl networkctl podman docker jq bun; do
        if has_bin "$t"; then tools+=("\"$t\": true"); else tools+=("\"$t\": false"); fi
    done

    local image_dirs=()
    for d in /var/lib/machines /var/lib/portables /var/lib/extensions /var/lib/confexts; do
        [ -d "$d" ] && image_dirs+=("$d")
    done

    local addresses=()
    if has_bin ip; then
        while read -r a; do [ -n "$a" ] && addresses+=("${a%%/*}"); done < <(ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}')
    fi

    [ -n "$version" ] || { echo "cannot read the systemd version from systemctl --version" >&2; exit 1; }

    printf '{\n'
    printf '  "hostname": "%s",\n' "$(json_str "$hostname")"
    printf '  "probed_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "systemd": { "version": %s, "features": %s },\n' "$version" "$(json_list "${features[@]}")"
    printf '  "kernel": { "release": "%s", "major": %s, "minor": %s },\n' "$(json_str "$kernel")" "${major:-0}" "${minor:-0}"
    printf '  "arch": "%s",\n' "$(json_str "$arch")"
    printf '  "os": { "id": "%s", "version_id": "%s", "pretty_name": "%s" },\n' "$(json_str "$os_id")" "$(json_str "$os_version")" "$(json_str "$os_pretty")"
    printf '  "cgroup_v2": %s,\n' "$cgroup2"
    printf '  "overlayfs_fsconfig": %s,\n' "$fsconfig"
    printf '  "daemons": { %s },\n' "$(IFS=,; printf '%s' "${daemons[*]}" | sed 's/,/, /g')"
    printf '  "tools": { %s },\n' "$(IFS=,; printf '%s' "${tools[*]}" | sed 's/,/, /g')"
    printf '  "image_dirs": %s,\n' "$(json_list "${image_dirs[@]}")"
    printf '  "addresses": %s,\n' "$(json_list "${addresses[@]}")"
    printf '  "notes": %s\n' "$(json_list "${notes[@]}")"
    printf '}\n'
}

mkdir -p "$outdir"
if [ "${#remotes[@]}" -eq 0 ]; then
    name="$(hostname)"
    probe_local > "$outdir/$name.json"
    echo "wrote $outdir/$name.json"
    exit 0
fi

status=0
for host in "${remotes[@]}"; do
    # The script itself is the payload; the remote side needs nothing installed.
    # The file is named after the host as the operator gave it, never after
    # anything the remote side printed: the JSON is data from another machine.
    name="${host##*@}"
    name="${name//[^A-Za-z0-9._-]/_}"
    [ -n "$name" ] && [ "$name" != "." ] && [ "$name" != ".." ] || name="remote"
    if out="$(ssh -o BatchMode=yes "$host" bash -s -- --local < "$0" 2>/dev/null)" && [ -n "$out" ]; then
        printf '%s\n' "$out" > "$outdir/$name.json"
        echo "wrote $outdir/$name.json (from $host)"
    else
        echo "probe of $host failed" >&2
        status=1
    fi
done
exit $status
