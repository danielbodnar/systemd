#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# A rendered service runs with the image as its root through RootMStack=.
# The image is a mount stack assembled from two dummy container layers under
# the name the rendered unit expects, so the unit runs unmodified apart from
# its ConditionHost= guard and the healthcheck command, which the fixture
# image cannot run.

if ! command -v systemd-mstack >/dev/null; then
    echo "no systemd-mstack" >&2
    exit 77
fi

# A writable overlay layer needs FSCONFIG_SET_FD support in overlayfs.
if systemd-analyze condition 'ConditionVersion= < 6.13'; then
    echo "Kernel too old for FSCONFIG_SET_FD support on overlayfs, skipping"
    exit 77
fi

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
HOST="$FIXTURE/rendered/native/hosts/swarm-wrk-1"
IMAGE=/var/lib/machines/acme-app_2026.09.mstack
BASE=/var/lib/machines/.acme-app-base
LAYER=/var/lib/machines/.acme-app-layer

at_exit() {
    set +e
    systemctl stop web_app-health.timer web_app.service web.target
    rm -rf /run/systemd/system/web_app.service.d /run/systemd/system/web_app-health.service.d
    rm -f /run/systemd/system/web_app.service /run/systemd/system/web_app-health.service \
          /run/systemd/system/web_app-health.timer /run/systemd/system/web_app-restart.service \
          /run/systemd/system/web.target /run/systemd/system/stack-web.slice
    systemctl daemon-reload
    rm -rf "$IMAGE" "$BASE" "$LAYER" /etc/swarm-migration /etc/credstore.encrypted/web_app_signing_key \
           /etc/credstore.encrypted/web_app-app-secret-key /var/lib/web
}

trap at_exit EXIT

# Layer 0: the dummy container; layer 1: the application the rendered unit starts.
create_dummy_container "$BASE"
mkdir -p "$LAYER/usr/bin" "$LAYER/srv/app" "$LAYER/cache" "$LAYER/run/secrets"
cat >"$LAYER/usr/bin/app" <<'EOF2'
#!/usr/bin/env bash
echo "app started with $*"
test -f /run/secrets/signing_key
test -f "$APP_SECRET_KEY_FILE"
exec sleep infinity
EOF2
chmod +x "$LAYER/usr/bin/app"

mkdir -p "$IMAGE/rw"
ln -s "$BASE" "$IMAGE/layer@0"
ln -s "$LAYER" "$IMAGE/layer@1"

# The stack mounts, and the merged tree has both layers.
systemd-mstack "$IMAGE"
MERGED="$(mktemp -d)"
systemd-mstack --mount --read-only "$IMAGE" "$MERGED"
test -x "$MERGED/usr/bin/app"
test -x "$MERGED/sbin/init"
systemd-mstack --umount "$MERGED"
rmdir "$MERGED"

# Credentials: the operator places one file per secret, the rendered script encrypts them.
mkdir -p -m 0700 /etc/swarm-migration/secrets
echo "test signing key" >/etc/swarm-migration/secrets/web_app_signing_key
echo "test app secret" >/etc/swarm-migration/secrets/web_app-app-secret-key
chmod 0600 /etc/swarm-migration/secrets/*
bash "$HOST/secrets/import-credentials.sh"
test -f /etc/credstore.encrypted/web_app_signing_key
test -f /etc/credstore.encrypted/web_app-app-secret-key

# The local volume the unit binds.
systemd-tmpfiles --create "$HOST/etc/tmpfiles.d/web.conf"
test -d /var/lib/web/web_cache

# Install the web stack's units as rendered.
for unit in web_app.service web_app-health.service web_app-health.timer web_app-restart.service web.target stack-web.slice; do
    cp "$HOST/etc/systemd/system/$unit" /run/systemd/system/
done
mkdir -p /run/systemd/system/web_app.service.d /run/systemd/system/web_app-health.service.d
cat >/run/systemd/system/web_app.service.d/test.conf <<EOF2
[Unit]
ConditionHost=
EOF2
cat >/run/systemd/system/web_app-health.service.d/test.conf <<EOF2
[Service]
ExecStart=
ExecStart=/usr/bin/env test -x /usr/bin/app
EOF2
systemctl daemon-reload

grep "^RootMStack=$IMAGE$" /run/systemd/system/web_app.service >/dev/null

systemctl start web_app.service
systemctl is-active web_app.service
timeout 30 bash -c 'until journalctl -u web_app.service --no-pager | grep "app started with serve --port 8080" >/dev/null; do sleep 1; done'

# The process runs in the merged tree with the credentials and the volume in place.
PID="$(systemctl show -p MainPID --value web_app.service)"
test "$PID" -gt 0
test -x "/proc/$PID/root/usr/bin/app"
test -f "/proc/$PID/root/run/secrets/signing_key"
test -d "/proc/$PID/root/cache"
assert_in "stack-web.slice" "$(systemctl show -p Slice --value web_app.service)"
assert_eq "$(systemctl show -p MemoryMax --value web_app.service)" "536870912"

# The healthcheck timer and its check run in the same root.
systemctl start web_app-health.timer
systemctl start web_app-health.service
systemctl is-active web_app-health.timer

systemctl stop web_app.service
(! systemctl is-active web_app.service)
