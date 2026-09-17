#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Rendered by docker-image-to-service for swarm-mgr-1. Copies the rendered tree into place,
# fixes ownership and modes, reloads the manager, verifies the units, and
# optionally starts the stack targets. Pull the images first (pull-images.sh)
# and import the credentials (secrets/import-credentials.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ "$(hostname)" = swarm-mgr-1 ] || echo "warning: this tree was rendered for swarm-mgr-1, not $(hostname)" >&2
for image in /var/lib/machines/library-caddy_2.mstack; do
    [ -e "$image" ] || echo "warning: $image is not present; run pull-images.sh" >&2
done
cp -a "$here/etc/." /etc/
while read -r path uid gid mode; do
    chown "$uid:$gid" "/etc/$path"
    chmod "$mode" "/etc/$path"
done <<'MANIFEST'
web/configs/web_caddyfile 0 0 0444
MANIFEST
find /etc/web -maxdepth 1 -name '*.env' -exec chmod 0600 {} + 2>/dev/null || true
systemd-tmpfiles --create /etc/tmpfiles.d/web.conf || true
sysctl --system >/dev/null || true
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/web_proxy.service /etc/systemd/system/web.target
if [ "${1:-}" = "--start" ]; then
    systemctl enable --now web.target
else
    echo "installed; start with: systemctl enable --now web.target"
fi
