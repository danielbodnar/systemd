#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Rendered by systemd-migration for swarm-wrk-1. Copies the rendered tree into place,
# runs each component's install steps, reloads the manager, verifies the
# units, and optionally starts the stack targets. Pull the images first
# (pull-images.sh) and import the credentials (secrets/import-credentials.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ "$(hostname)" = 'swarm-wrk-1' ] || echo "warning: this tree was rendered for swarm-wrk-1, not $(hostname)" >&2
for image in '/var/lib/machines/prometheuscommunity-postgres-exporter_v0.15.0.mstack' '/var/lib/machines/library-postgres_16.4.mstack' '/var/lib/machines/acme-app_2026.09.mstack'; do
    [ -e "$image" ] || echo "warning: $image is not present; run pull-images.sh" >&2
done
cp -a "$here/etc/." /etc/
systemd-tmpfiles --create '/etc/tmpfiles.d/web-machines.conf' || true
sysctl --system >/dev/null || true
systemd-tmpfiles --create '/etc/tmpfiles.d/data.conf' || true
cat /etc/hosts.d/systemd-migration.hosts >> /etc/hosts
install -D -m 0755 "$here/usr/local/lib/systemd-migration/stackctl" '/usr/local/lib/systemd-migration/stackctl'
install -d -m 0755 '/var/lib/systemd-migration/rollout'
install -D -m 0700 "$here/secrets/import-credentials.sh" '/usr/local/lib/systemd-migration/import-credentials.sh'
systemctl daemon-reload
networkctl reload
systemctl enable 'data.target' 'web.target'
systemd-analyze verify '/etc/systemd/system/data_exporter.service' '/etc/systemd/system/data_postgres-health.service' '/etc/systemd/system/data_postgres-restart.service' '/etc/systemd/system/data_postgres.service' '/etc/systemd/system/data_postgres-health.timer' '/etc/systemd/system/var-lib-data-data_backups.mount' '/etc/systemd/system/data.target' '/etc/systemd/system/web.target' '/etc/systemd/system/stack-data.slice' '/etc/systemd/system/stack-web.slice'
if [ "${1:-}" = "--start" ]; then
    systemctl enable --now 'data.target' 'web.target'
else
    echo "installed; start with: systemctl enable --now 'data.target' 'web.target'"
fi
