#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# capture.sh: record the state of a Docker Swarm cluster from a manager node.
#
# The script is read-only. It runs `docker ... ls` and `docker ... inspect`
# for every object type Swarm manages and writes the JSON verbatim so that
# later steps (normalize.ts, render.ts) can be re-run against the same
# evidence. Secret values are never readable through the API and are not
# captured; config payloads are.
#
# Usage: capture.sh [-o OUTDIR] [-H DOCKER_HOST] [--compose-dir DIR] [--no-tasks]

set -euo pipefail

outdir="swarm-capture-$(date -u +%Y%m%dT%H%M%SZ)"
compose_dir=""
capture_tasks=1

usage() {
    cat <<USAGE
Usage: ${0##*/} [-o OUTDIR] [-H DOCKER_HOST] [--compose-dir DIR] [--no-tasks]

  -o OUTDIR        directory to write into (default: ${outdir})
  -H DOCKER_HOST   docker host to talk to (default: \$DOCKER_HOST or the local socket)
  --compose-dir    directory holding the stack compose files; copied for reference
  --no-tasks       skip per-service task listing (faster on very large clusters)
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        -o) outdir="$2"; shift 2 ;;
        -H) export DOCKER_HOST="$2"; shift 2 ;;
        --compose-dir) compose_dir="$2"; shift 2 ;;
        --no-tasks) capture_tasks=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

command -v docker >/dev/null || { echo "docker CLI not found" >&2; exit 1; }

if [ "$(docker info --format '{{.Swarm.ControlAvailable}}')" != "true" ]; then
    echo "this node is not a swarm manager; run the capture on a manager" >&2
    exit 1
fi

raw="$outdir/raw"
mkdir -p "$raw"

# ids TYPE: print every object id of TYPE, one per line, or nothing.
ids() {
    docker "$1" ls -q 2>/dev/null || true
}

# inspect_all TYPE FILE: inspect every object of TYPE into FILE as a JSON array.
inspect_all() {
    local type="$1" file="$2"
    local list
    list="$(ids "$type")"
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

docker network ls --format '{{json .}}' > "$raw/networks.ls.jsonl"
inspect_all network "$raw/networks.json"

docker volume ls --format '{{json .}}' > "$raw/volumes.ls.jsonl"
inspect_all volume "$raw/volumes.json"

docker secret ls --format '{{json .}}' > "$raw/secrets.ls.jsonl"
inspect_all secret "$raw/secrets.json"

docker config ls --format '{{json .}}' > "$raw/configs.ls.jsonl"
inspect_all config "$raw/configs.json"

docker plugin ls --format '{{json .}}' > "$raw/plugins.jsonl" 2>/dev/null || echo -n > "$raw/plugins.jsonl"

if [ "$capture_tasks" -eq 1 ]; then
    : > "$raw/tasks.jsonl"
    while IFS= read -r svc; do
        [ -n "$svc" ] || continue
        docker service ps --no-trunc --format '{{json .}}' "$svc" >> "$raw/tasks.jsonl" || true
    done < <(docker service ls --format '{{.Name}}')
fi

if [ -n "$compose_dir" ]; then
    if [ -d "$compose_dir" ]; then
        mkdir -p "$outdir/compose"
        find "$compose_dir" -maxdepth 2 \( -name '*.yml' -o -name '*.yaml' -o -name '.env' \) -exec cp --parents {} "$outdir/compose/" \;
    else
        echo "compose dir $compose_dir does not exist; skipping" >&2
    fi
fi

cat > "$outdir/manifest.json" <<JSON
{
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "captured_on": "$(hostname)",
  "docker_host": "${DOCKER_HOST:-local}",
  "tasks_captured": $capture_tasks,
  "compose_dir": "${compose_dir}",
  "tool": "swarm-to-systemd/swarm-capture/capture.sh"
}
JSON

echo "services: $(wc -l < "$raw/services.ls.jsonl")  nodes: $(wc -l < "$raw/nodes.ls.jsonl")  stacks: $(wc -l < "$raw/stacks.jsonl")"
echo "done: $outdir"
