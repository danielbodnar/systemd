#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Rendered by systemd-migration for swarm-mgr-1. Copies the rendered tree into place,
# runs each component's install steps, reloads the manager, verifies the
# units, and optionally starts the stack targets. Pull the images first
# (pull-images.sh) and import the credentials (secrets/import-credentials.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ "$(hostname)" = 'swarm-mgr-1' ] || echo "warning: this tree was rendered for swarm-mgr-1, not $(hostname)" >&2
for image in '/var/lib/machines/library-caddy_2.mstack'; do
    [ -e "$image" ] || echo "warning: $image is not present; run pull-images.sh" >&2
done
cp -a "$here/etc/." /etc/
while read -r path uid gid mode; do
    chown "$uid:$gid" "/etc/$path"
    chmod "$mode" "/etc/$path"
done <<'MANIFEST'
web/configs/web_caddyfile 0 0 0444
MANIFEST
cat /etc/hosts.d/systemd-migration.hosts >> /etc/hosts
systemctl daemon-reload
systemd-analyze verify '/etc/systemd/system/web_proxy.service' '/etc/systemd/system/web.target' '/etc/systemd/system/stack-web.slice'
if [ "${1:-}" = "--start" ]; then
    systemctl enable --now 'web.target'
else
    echo "installed; start with: systemctl enable --now web.target"
fi
