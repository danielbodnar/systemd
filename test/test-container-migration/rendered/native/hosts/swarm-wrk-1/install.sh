#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Rendered by docker-image-to-service for swarm-wrk-1. Copies the rendered tree into place,
# fixes ownership and modes, reloads the manager, verifies the units, and
# optionally starts the stack targets. Pull the images first (pull-images.sh)
# and import the credentials (secrets/import-credentials.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ "$(hostname)" = swarm-wrk-1 ] || echo "warning: this tree was rendered for swarm-wrk-1, not $(hostname)" >&2
for image in /var/lib/machines/prometheuscommunity-postgres-exporter_v0.15.0.mstack /var/lib/machines/library-postgres_16.4.mstack /var/lib/machines/acme-app_2026.09.mstack; do
    [ -e "$image" ] || echo "warning: $image is not present; run pull-images.sh" >&2
done
cp -a "$here/etc/." /etc/
find /etc/data -maxdepth 1 -name '*.env' -exec chmod 0600 {} + 2>/dev/null || true
find /etc/web -maxdepth 1 -name '*.env' -exec chmod 0600 {} + 2>/dev/null || true
systemd-tmpfiles --create /etc/tmpfiles.d/data.conf /etc/tmpfiles.d/web.conf || true
sysctl --system >/dev/null || true
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/data_exporter.service /etc/systemd/system/data_postgres-health.service /etc/systemd/system/data_postgres-restart.service /etc/systemd/system/data_postgres.service /etc/systemd/system/web_app-health.service /etc/systemd/system/web_app-restart.service /etc/systemd/system/web_app.service /etc/systemd/system/data_postgres-health.timer /etc/systemd/system/web_app-health.timer /etc/systemd/system/var-lib-data-data_backups.mount /etc/systemd/system/data.target /etc/systemd/system/web.target
if [ "${1:-}" = "--start" ]; then
    systemctl enable --now data.target web.target
else
    echo "installed; start with: systemctl enable --now data.target web.target"
fi
