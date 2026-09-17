#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# capture.sh: record the state of a Docker Swarm cluster from a manager node.
#
# The script is read-only. It runs `docker ... ls` and `docker ... inspect`
# for every object type Swarm manages and writes the JSON so that later steps
# (normalize.ts, render.ts) can be re-run against the same evidence. Swarm
# secret values are never readable through the API. Environment values whose
# names look secret-bearing are redacted before the raw file is written, and
# PreviousSpec (which repeats the environment) is dropped; pass --keep-env to
# retain every value, in which case store the capture accordingly.
#
# Usage: capture.sh [-o OUTDIR] [-H DOCKER_HOST] [--compose-dir DIR] [--no-tasks] [--keep-env]

set -euo pipefail

outdir="swarm-capture-$(date -u +%Y%m%dT%H%M%SZ)"
compose_dir=""
capture_tasks=1
keep_env=0
secret_env_re='(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|pwd|auth)'
# Values are tested too: URI userinfo with a password, key=value pairs inside
# a value, and command-line forms such as --password=x or -px. A bare
# --password flag hides the argument that follows it.
secret_value_re='://[^/@[:space:]]+:[^/@[:space:]]+@|(^|[;&?, ])(password|passwd|pwd|secret|token|api[_-]?key)='
secret_arg_re='^-{1,2}(password|passwd|pwd|secret|token|api[_-]?key|auth)=|^-p[^-[:space:]]{3,}$'
secret_flag_re='^-{1,2}(password|passwd|pwd|secret|token|api[_-]?key|auth)$'

usage() {
    cat <<USAGE
Usage: ${0##*/} [-o OUTDIR] [-H DOCKER_HOST] [--compose-dir DIR] [--no-tasks] [--keep-env]

  -o OUTDIR        directory to write into (default: ${outdir})
  -H DOCKER_HOST   docker host to talk to (default: \$DOCKER_HOST or the local socket)
  --compose-dir    directory holding the stack compose files (*.yml, *.yaml only; .env files are never copied)
  --no-tasks       skip per-service task listing (faster on very large clusters)
  --keep-env       keep every environment value in the raw capture (requires explicit intent)
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        -o) outdir="$2"; shift 2 ;;
        -H) export DOCKER_HOST="$2"; shift 2 ;;
        --compose-dir) compose_dir="$2"; shift 2 ;;
        --no-tasks) capture_tasks=0; shift ;;
        --keep-env) keep_env=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

command -v docker >/dev/null || { echo "docker CLI not found" >&2; exit 1; }
if [ "$keep_env" -eq 0 ] && ! command -v jq >/dev/null; then
    echo "jq is required to redact environment values; install it or pass --keep-env deliberately" >&2
    exit 1
fi

if [ "$(docker info --format '{{.Swarm.ControlAvailable}}')" != "true" ]; then
    echo "this node is not a swarm manager; run the capture on a manager" >&2
    exit 1
fi

# The capture holds config payloads and full service specs, so the tree is
# owner-only whatever the caller's umask.
umask 077
raw="$outdir/raw"
mkdir -p -m 0700 "$outdir" "$raw"

# inspect_all TYPE FILE: inspect every object of TYPE into FILE as a JSON array.
# A failing `ls` aborts the capture: an empty list must mean "none exist",
# never "the query failed".
inspect_all() {
    local type="$1" file="$2"
    local list
    list="$(docker "$type" ls -q)"
    if [ -z "$list" ]; then
        echo '[]' > "$file"
        return
    fi
    # shellcheck disable=SC2086
    docker "$type" inspect $list > "$file"
}

echo "capturing swarm state into $outdir"

docker version --format '{{json .}}' > "$raw/version.json"
docker info --format '{{json .}}' > "$raw/info.json"

docker node ls --format '{{json .}}' > "$raw/nodes.ls.jsonl"
inspect_all node "$raw/nodes.json"

docker stack ls --format '{{json .}}' > "$raw/stacks.jsonl"

docker service ls --format '{{json .}}' > "$raw/services.ls.jsonl"
inspect_all service "$raw/services.json"
if [ "$keep_env" -eq 0 ]; then
    jq --arg re "$secret_env_re" --arg vre "$secret_value_re" --arg are "$secret_arg_re" --arg fre "$secret_flag_re" '
        def redact_argv:
          if . == null then . else
            reduce .[] as $a ({out: [], hide: false};
              if .hide then {out: (.out + ["<redacted>"]), hide: false}
              elif ($a | test($fre; "i")) then {out: (.out + [$a]), hide: true}
              elif ($a | test($are; "i")) or ($a | test($vre; "i")) then {out: (.out + ["<redacted>"]), hide: false}
              else {out: (.out + [$a]), hide: false} end) | .out
          end;
        map(
          del(.PreviousSpec)
          | .Spec.TaskTemplate.ContainerSpec.Env |=
              (if . then map(
                  (split("=")[0]) as $k | (.[($k | length) + 1:]) as $v
                  | if ((($k | test("_FILE$")) and ($v | startswith("/"))) | not) and (($k | test($re; "i")) or ($v | test($vre; "i"))) then ($k + "=<redacted>") else . end
                ) else . end)
          | .Spec.TaskTemplate.ContainerSpec.Command |= redact_argv
          | .Spec.TaskTemplate.ContainerSpec.Args |= redact_argv
        )' "$raw/services.json" > "$raw/services.json.tmp"
    mv "$raw/services.json.tmp" "$raw/services.json"
fi

# Image configuration (entrypoint, command, environment, working directory,
# user) is not part of a service spec and is dropped by importctl pull-oci,
# so record it for every image that is present on this node. Images that
# only exist on other nodes are skipped; normalize.ts warns about them.
: > "$raw/images.jsonl"
while IFS= read -r img; do
    [ -n "$img" ] || continue
    docker image inspect "$img" 2>/dev/null | jq -c ".[]" >> "$raw/images.jsonl" || true
done < <(docker service ls --format "{{.Image}}" | sort -u)
jq -s --arg re "$secret_env_re" --arg vre "$secret_value_re" --argjson keep "$keep_env" '
    map(.Config.Env |= (if . and $keep == 0 then map(
            (split("=")[0]) as $k | (.[($k | length) + 1:]) as $v
            | if ((($k | test("_FILE$")) and ($v | startswith("/"))) | not) and (($k | test($re; "i")) or ($v | test($vre; "i"))) then ($k + "=<redacted>") else . end
        ) else . end))' "$raw/images.jsonl" > "$raw/images.json"
rm -f "$raw/images.jsonl"

docker network ls --format '{{json .}}' > "$raw/networks.ls.jsonl"
inspect_all network "$raw/networks.json"

# Volumes are node-local: this lists the capturing node's volumes only.
# normalize.ts flags service mounts whose volume is not in this file.
docker volume ls --format '{{json .}}' > "$raw/volumes.ls.jsonl"
inspect_all volume "$raw/volumes.json"

docker secret ls --format '{{json .}}' > "$raw/secrets.ls.jsonl"
inspect_all secret "$raw/secrets.json"

docker config ls --format '{{json .}}' > "$raw/configs.ls.jsonl"
inspect_all config "$raw/configs.json"

# Plugins are optional on a swarm; a failure here is not evidence of anything.
docker plugin ls --format '{{json .}}' > "$raw/plugins.jsonl" 2>/dev/null || echo -n > "$raw/plugins.jsonl"

if [ "$capture_tasks" -eq 1 ]; then
    : > "$raw/tasks.jsonl"
    while IFS= read -r svc; do
        [ -n "$svc" ] || continue
        docker service ps --no-trunc --format '{{json .}}' "$svc" >> "$raw/tasks.jsonl"
    done < <(docker service ls --format '{{.Name}}')
fi

if [ -n "$compose_dir" ]; then
    if [ -d "$compose_dir" ]; then
        mkdir -p "$outdir/compose"
        # Only *.yml and *.yaml are copied; .env files are excluded by pattern.
        # Compose files themselves often carry inline credentials under
        # environment:, and nothing redacts them here, so the compose/ copy
        # is secret material and the tree is owner-only for that reason.
        echo "warning: compose files may hold inline credentials; treat $outdir/compose as secret material" >&2
        find "$compose_dir" -maxdepth 2 -type f \( -name '*.yml' -o -name '*.yaml' \) -exec cp --parents {} "$outdir/compose/" \;
    else
        echo "compose dir $compose_dir does not exist; skipping" >&2
    fi
fi

cat > "$outdir/manifest.json" <<JSON
{
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "captured_on": "$(hostname)",
  "captured_node_id": "$(docker info --format '{{.Swarm.NodeID}}')",
  "docker_host": "${DOCKER_HOST:-local}",
  "tasks_captured": $capture_tasks,
  "env_redacted": $((1 - keep_env)),
  "compose_dir": "${compose_dir}",
  "tool": "docker-swarm-to-systemd/docker-swarm-to-inventory/capture.sh"
}
JSON

echo "services: $(wc -l < "$raw/services.ls.jsonl")  nodes: $(wc -l < "$raw/nodes.ls.jsonl")  stacks: $(wc -l < "$raw/stacks.jsonl")"
echo "done: $outdir"
