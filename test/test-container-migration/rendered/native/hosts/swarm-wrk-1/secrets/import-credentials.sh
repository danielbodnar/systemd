#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Rendered by systemd-service. Encrypts each secret value into a systemd credential
# that the units load with LoadCredentialEncrypted=. Values are read from one
# file per credential under /etc/swarm-migration/secrets/ (root-only, mode
# 0600), which the operator fills from the old cluster; nothing here prints one.
set -euo pipefail
src="${1:-/etc/swarm-migration/secrets}"
dst="/etc/credstore.encrypted"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
install -d -m 0700 "$dst"
missing=0
for name in 'data_postgres_password' 'web_app-app-secret-key' 'web_app_signing_key'; do
    if [ ! -f "$src/$name" ]; then echo "missing $src/$name" >&2; missing=$((missing + 1)); continue; fi
    systemd-creds encrypt --name="$name" "$src/$name" "$dst/$name"
    chmod 0600 "$dst/$name"
    echo "encrypted $name"
done
[ "$missing" -eq 0 ] || { echo "$missing credential(s) missing" >&2; exit 1; }
