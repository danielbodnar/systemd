#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Rendered by systemd-service. Turns each secret value into a systemd credential the
# units load: encrypted ones with systemd-creds encrypt into
# /etc/credstore.encrypted, plain ones copied into /etc/credstore. Values are
# read from one file per credential under /etc/swarm-migration/secrets/
# (root-only, mode 0600), which the operator fills from the old cluster;
# nothing here prints one.
set -euo pipefail
src="${1:-/etc/swarm-migration/secrets}"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
missing=0
install -d -m 0700 /etc/credstore.encrypted
for name in 'data_postgres_password' 'web_app-app-secret-key' 'web_app_signing_key'; do
    if [ ! -f "$src/$name" ]; then echo "missing $src/$name" >&2; missing=$((missing + 1)); continue; fi
    systemd-creds encrypt --name="$name" "$src/$name" "/etc/credstore.encrypted/$name"
    chmod 0600 "/etc/credstore.encrypted/$name"
    echo "encrypted $name"
done
[ "$missing" -eq 0 ] || { echo "$missing credential(s) missing" >&2; exit 1; }
