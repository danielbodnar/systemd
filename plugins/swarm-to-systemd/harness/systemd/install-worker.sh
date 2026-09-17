#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Install the swarm-agent worker on a production host.
#
# Usage: install-worker.sh --environment-id env_... [--source DIR] [--bun /usr/local/bin/bun]
#
# Reads the environment key from stdin (paste it, or pipe it from a secret
# manager) and stores it encrypted with systemd-creds bound to this host. The
# key never lands in a plain file.

set -euo pipefail

environment_id=""
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
bun_bin="${BUN_BIN:-/usr/local/bin/bun}"
prefix="/opt/swarm-agent"

while [ $# -gt 0 ]; do
    case "$1" in
        --environment-id) environment_id="$2"; shift 2 ;;
        --source) source_dir="$2"; shift 2 ;;
        --bun) bun_bin="$2"; shift 2 ;;
        -h|--help) sed -n '4,12p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -n "$environment_id" ] || { echo "--environment-id is required" >&2; exit 2; }
[ -x "$bun_bin" ] || { echo "bun not found at $bun_bin (install it, or pass --bun)" >&2; exit 1; }
command -v systemd-creds >/dev/null || { echo "systemd-creds not available" >&2; exit 1; }

echo "installing harness from $source_dir to $prefix/harness"
install -m 0644 "$source_dir/systemd/swarm-agent.sysusers.conf" /etc/sysusers.d/swarm-agent.conf
systemd-sysusers /etc/sysusers.d/swarm-agent.conf
install -d -m 0755 "$prefix" /etc/swarm-agent /etc/credstore.encrypted
install -d -m 0750 -o swarm-agent -g swarm-agent /var/lib/swarm-agent
# The workspace and memory mounts are shared between the worker and the tool
# executor through the group; setgid keeps new files in that group.
install -d -m 2770 -o swarm-agent -g swarm-agent /var/lib/swarm-agent/workspace /mnt/memory
install -d -m 0700 /etc/swarm-migration/secrets
if [ -S /var/run/docker.sock ]; then
    echo "note: swarm-agent is deliberately not in the docker group (that is root-equivalent);"
    echo "      set DOCKER_HOST in /etc/swarm-agent/worker.env to a read-only socket proxy,"
    echo "      or run the capture yourself and copy it into the workspace"
fi
rm -rf "$prefix/harness"
cp -a "$source_dir" "$prefix/harness"
# The plugin's skills are referenced relative to the harness; keep them adjacent.
if [ -d "$source_dir/../skills" ]; then
    rm -rf "$prefix/skills"
    cp -a "$source_dir/../skills" "$prefix/skills"
fi
# The lockfile is the single source of truth for what runs here: a mismatch
# fails the install rather than resolving fresh from the registry.
(cd "$prefix/harness" && "$bun_bin" install --frozen-lockfile --production)

[ -f /etc/swarm-agent/swarm-agent.yaml ] || install -m 0640 -g swarm-agent "$source_dir/swarm-agent.yaml" /etc/swarm-agent/swarm-agent.yaml
[ -f /etc/swarm-agent/approvals.yaml ] || install -m 0640 -g swarm-agent "$source_dir/approvals.yaml" /etc/swarm-agent/approvals.yaml
printf 'ANTHROPIC_ENVIRONMENT_ID=%s\n' "$environment_id" > /etc/swarm-agent/worker.env
chown root:swarm-agent /etc/swarm-agent/worker.env
chmod 0640 /etc/swarm-agent/worker.env
chown -R root:swarm-agent "$prefix"
chmod -R g+rX "$prefix"

if [ ! -f /etc/credstore.encrypted/swarm-agent.environment-key ]; then
    echo "paste the environment key (sk-ant-oat01-...) and press Enter; input is not echoed:"
    IFS= read -r -s key
    [ -n "$key" ] || { echo "empty key" >&2; exit 1; }
    printf '%s' "$key" | systemd-creds encrypt --name=environment-key - /etc/credstore.encrypted/swarm-agent.environment-key
    unset key
    echo "environment key stored encrypted"
fi

sed "s#/opt/swarm-agent/harness#$prefix/harness#; s#/usr/local/bin/bun#$bun_bin#" \
    "$source_dir/systemd/swarm-agent-worker.service" > /etc/systemd/system/swarm-agent-worker.service
sed "s#/opt/swarm-agent/harness#$prefix/harness#; s#/usr/local/bin/bun#$bun_bin#" \
    "$source_dir/systemd/swarm-agent-tools.service" > /etc/systemd/system/swarm-agent-tools.service
install -m 0644 "$source_dir/systemd/swarm-agent.slice" /etc/systemd/system/swarm-agent.slice
systemctl daemon-reload
systemd-analyze verify swarm-agent-tools.service swarm-agent-worker.service || true
echo "installed. start with: systemctl enable --now swarm-agent-tools.service swarm-agent-worker.service"
echo "check with:            $bun_bin run $prefix/harness/src/cli.ts doctor --host --config /etc/swarm-agent/swarm-agent.yaml"
