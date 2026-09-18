#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# capture.sh: record the state of a Podman host (its containers, pods,
# networks, volumes, secret names, and images) so normalize.ts can turn it
# into inventory.json. It mirrors discover-docker-swarm/scripts/capture.sh.
#
# The script is read-only. Every Podman call goes through pm(), which
# accepts only listing and inspection verbs and aborts on anything else, so
# no edit can slip a mutating command into the capture. Secret values are
# never read: `podman secret ls` lists names and drivers, and `podman secret
# inspect` is refused because it accepts --showsecret. Environment values
# whose names or values look secret-bearing are redacted before the raw
# file is written, in Config.Env and in the recorded create command; there
# is no switch to keep them, because a capture is read by agents and
# archived. Existing Quadlet files are copied with their Environment= lines
# redacted the same way.
#
# Usage: capture.sh [-o OUTDIR] [-c CONNECTION] [--no-quadlet]

set -euo pipefail

outdir="podman-capture-$(date -u +%Y%m%dT%H%M%SZ)"
connection=""
capture_quadlet=1
secret_env_re='(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|pwd|auth)'
# Values are tested too: URI userinfo with a password, key=value pairs inside
# a value, and command-line forms such as --password=x or -px. A bare
# --password flag hides the argument that follows it.
secret_value_re='://[^/@[:space:]]+:[^/@[:space:]]+@|(^|[;&?, ])(password|passwd|pwd|secret|token|api[_-]?key)='
secret_arg_re='^-{1,2}(password|passwd|pwd|secret|token|api[_-]?key|auth)=|^-p[^-[:space:]]{3,}$'
secret_flag_re='^-{1,2}(password|passwd|pwd|secret|token|api[_-]?key|auth)$'

usage() {
    cat <<USAGE
Usage: ${0##*/} [-o OUTDIR] [-c CONNECTION] [--no-quadlet]

  -o OUTDIR        directory to write into (default: ${outdir})
  -c CONNECTION    a podman remote connection name (podman --connection); default: the local service
  --no-quadlet     do not copy the existing Quadlet files under /etc/containers/systemd and ~/.config/containers/systemd
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        -o) outdir="$2"; shift 2 ;;
        -c) connection="$2"; shift 2 ;;
        --no-quadlet) capture_quadlet=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

command -v podman >/dev/null || { echo "podman CLI not found" >&2; exit 1; }
if ! command -v jq >/dev/null; then
    echo "jq is required to redact environment values; install it" >&2
    exit 1
fi

# pm VERB [SUBVERB] ARGS...: run a read-only podman command. Anything that is
# not a listing or an inspection is refused before podman sees it.
pm() {
    case "$1" in
        info|version|ps) ;;
        container|pod|network|volume|image)
            case "${2:-}" in
                inspect|ls|ps) ;;
                *) echo "refusing to run podman $*: not a read-only command" >&2; exit 1 ;;
            esac ;;
        secret)
            [ "${2:-}" = "ls" ] || { echo "refusing to run podman $*: only 'secret ls' is read-only (inspect accepts --showsecret)" >&2; exit 1; } ;;
        *) echo "refusing to run podman $*: not a read-only command" >&2; exit 1 ;;
    esac
    if [ -n "$connection" ]; then
        podman --connection "$connection" "$@"
    else
        podman "$@"
    fi
}

# The capture holds full container specs, so the tree is owner-only whatever
# the caller's umask.
umask 077
raw="$outdir/raw"
mkdir -p -m 0700 "$outdir" "$raw"

# inspect_all TYPE FILE IDS...: inspect the named objects into FILE as a JSON
# array. No ids means "none exist", which is recorded as an empty list; a
# failing inspect aborts the capture so an empty list never means "failed".
inspect_all() {
    local type="$1" file="$2"
    shift 2
    if [ $# -eq 0 ]; then
        echo '[]' > "$file"
        return
    fi
    pm "$type" inspect "$@" | jq 'if type == "array" then . else [.] end' > "$file"
}

echo "capturing podman state into $outdir"

pm version --format json > "$raw/version.json"
pm info --format json > "$raw/info.json"

# Containers, including stopped ones and pod infra containers (normalize.ts
# skips the infra containers but reads their networks and ports for the pod).
pm ps -a --format json > "$raw/containers.ls.json"
mapfile -t container_ids < <(jq -r '.[].Id' "$raw/containers.ls.json")
inspect_all container "$raw/containers.json" "${container_ids[@]}"
jq --arg re "$secret_env_re" --arg vre "$secret_value_re" --arg are "$secret_arg_re" --arg fre "$secret_flag_re" '
        def redact_assignment:
          # KEY=VALUE, optionally behind --env=, with a *_FILE path kept as is.
          if test("^(--env=)?[A-Za-z_][A-Za-z0-9_]*=") then
            (capture("^(?<p>(--env=)?)(?<k>[A-Za-z_][A-Za-z0-9_]*)=(?<v>.*)$")
             | if ((((.k | test("_FILE$")) and (.v | startswith("/"))) | not) and ((.k | test($re; "i")) or (.v | test($vre; "i"))))
               then (.p + .k + "=<redacted>") else (.p + .k + "=" + .v) end)
          else . end;
        def redact_argv:
          if . == null then . else
            reduce .[] as $a ({out: [], hide: false};
              if .hide then {out: (.out + ["<redacted>"]), hide: false}
              elif ($a | test($fre; "i")) then {out: (.out + [$a]), hide: true}
              elif ($a | test($are; "i")) or ($a | test($vre; "i")) then {out: (.out + ["<redacted>"]), hide: false}
              else {out: (.out + [$a | redact_assignment]), hide: false} end) | .out
          end;
        map(
          .Config.Env |= (if . then map(redact_assignment) else . end)
          | .Config.CreateCommand |= redact_argv
        )' "$raw/containers.json" > "$raw/containers.json.tmp"
mv "$raw/containers.json.tmp" "$raw/containers.json"

pm pod ps --format json > "$raw/pods.ls.json"
mapfile -t pod_ids < <(jq -r '.[].Id' "$raw/pods.ls.json")
inspect_all pod "$raw/pods.json" "${pod_ids[@]}"

pm network ls --format json > "$raw/networks.ls.json"
mapfile -t network_names < <(jq -r '.[] | (.name // .Name)' "$raw/networks.ls.json")
inspect_all network "$raw/networks.json" "${network_names[@]}"

pm volume ls --format json > "$raw/volumes.ls.json"
mapfile -t volume_names < <(jq -r '.[].Name' "$raw/volumes.ls.json")
inspect_all volume "$raw/volumes.json" "${volume_names[@]}"

# Names, ids, and drivers only; the values stay in Podman's store.
pm secret ls --format json > "$raw/secrets.json"

# Image configuration (entrypoint, command, environment, working directory,
# user) for every image a container uses, with the same redaction as above.
: > "$raw/images.jsonl"
while IFS= read -r img; do
    [ -n "$img" ] || continue
    pm image inspect "$img" 2>/dev/null | jq -c 'if type == "array" then .[] else . end' >> "$raw/images.jsonl" || true
done < <(jq -r '.[] | (.ImageID // .Image)' "$raw/containers.ls.json" | sort -u)
jq -s --arg re "$secret_env_re" --arg vre "$secret_value_re" '
    map(.Config.Env |= (if . then map(
            (split("=")[0]) as $k | (.[($k | length) + 1:]) as $v
            | if ((($k | test("_FILE$")) and ($v | startswith("/"))) | not) and (($k | test($re; "i")) or ($v | test($vre; "i"))) then ($k + "=<redacted>") else . end
        ) else . end))' "$raw/images.jsonl" > "$raw/images.json"
rm -f "$raw/images.jsonl"

# Existing Quadlet files are evidence of how the containers are run today.
# Environment= lines that look secret-bearing are redacted in the copy.
quadlet_dirs=()
if [ "$capture_quadlet" -eq 1 ]; then
    for d in /etc/containers/systemd /usr/share/containers/systemd "${HOME:-/nonexistent}/.config/containers/systemd"; do
        [ -d "$d" ] || continue
        quadlet_dirs+=("$d")
        while IFS= read -r f; do
            rel="${f#/}"
            mkdir -p "$outdir/quadlet/$(dirname "$rel")"
            # A *_FILE variable whose value is a path names where a secret lives and is kept.
            sed -E "/^Environment=[^=]*_FILE=\//! s/^(Environment=[^=]*($secret_env_re)[^=]*)=.*/\\1=<redacted>/I" "$f" > "$outdir/quadlet/$rel"
        done < <(find "$d" -type f \( -name '*.container' -o -name '*.pod' -o -name '*.volume' -o -name '*.network' -o -name '*.kube' -o -name '*.image' -o -name '*.build' -o -name '*.conf' \) 2>/dev/null | sort)
    done
fi

captured_on="$(jq -r '.host.hostname // empty' "$raw/info.json")"
[ -n "$captured_on" ] || captured_on="$(hostname)"
quadlet_json="$(printf '%s\n' "${quadlet_dirs[@]+"${quadlet_dirs[@]}"}" | jq -R . | jq -s 'map(select(. != ""))')"
cat > "$outdir/manifest.json" <<JSON
{
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "captured_on": "$captured_on",
  "connection": "${connection:-local}",
  "quadlet_captured": $capture_quadlet,
  "quadlet_dirs": $quadlet_json,
  "env_redacted": 1,
  "tool": "systemd-migration/discover-podman/capture.sh"
}
JSON

echo "containers: $(jq 'length' "$raw/containers.json")  pods: $(jq 'length' "$raw/pods.json")  networks: $(jq 'length' "$raw/networks.json")  volumes: $(jq 'length' "$raw/volumes.json")  secrets: $(jq 'length' "$raw/secrets.json")"
echo "done: $outdir"
