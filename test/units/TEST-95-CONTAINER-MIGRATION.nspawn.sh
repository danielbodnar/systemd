#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The machine form: the plan in plan-machine.yaml runs web_app under
# systemd-nspawn, so the rendered tree holds a .nspawn file and a drop-in for
# systemd-nspawn@web_app.service instead of web_app.service. The image is the
# same acme-app mount stack the mstack subtest builds from two dummy container
# layers; the machine runs unmodified apart from its ConditionHost= guard.
# The payload runs as uid 1000 with the credentials the drop-in loads, the
# volume bound in, and the tmpfs mounted; machinectl sees it registered.

if ! command -v systemd-mstack >/dev/null || ! command -v systemd-nspawn >/dev/null; then
    echo "no systemd-mstack or systemd-nspawn" >&2
    exit 77
fi

# A writable overlay layer needs FSCONFIG_SET_FD support in overlayfs.
if systemd-analyze condition 'ConditionVersion= < 6.13'; then
    echo "Kernel too old for FSCONFIG_SET_FD support on overlayfs, skipping"
    exit 77
fi

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
HOST="$FIXTURE/rendered/machine/hosts/swarm-wrk-1"
UNIT=systemd-nspawn@web_app.service
IMAGE=/var/lib/machines/acme-app_2026.09.mstack
BASE=/var/lib/machines/.acme-app-base
LAYER=/var/lib/machines/.acme-app-layer

at_exit() {
    set +e
    systemctl stop "$UNIT" web.target
    machinectl status web_app &>/dev/null && machinectl terminate web_app
    rm -rf "/run/systemd/system/$UNIT.d"
    rm -f /run/systemd/system/web.target /run/systemd/system/stack-web.slice /run/systemd/nspawn/web_app.nspawn
    systemctl daemon-reload
    rm -rf "$IMAGE" "$BASE" "$LAYER" /etc/credstore.encrypted/web_app_signing_key \
           /etc/credstore.encrypted/web_app-app-secret-key /var/lib/web
}

trap at_exit EXIT

# Layer 0: the dummy container; layer 1: the application the machine starts,
# plus the user the .nspawn file names, which systemd-nspawn resolves in the
# container's own user database.
create_dummy_container "$BASE"
mkdir -p "$LAYER/usr/bin" "$LAYER/srv/app" "$LAYER/cache" "$LAYER/tmp" "$LAYER/etc"
cp "$BASE/etc/passwd" "$LAYER/etc/passwd"
cp "$BASE/etc/group" "$LAYER/etc/group"
echo "app:x:1000:1000:app:/srv/app:/bin/sh" >>"$LAYER/etc/passwd"
echo "app:x:1000:" >>"$LAYER/etc/group"
cat >"$LAYER/usr/bin/app" <<'EOF2'
#!/usr/bin/env bash
set -e
echo "app started with $* as $(id -u) in $(pwd)"
test "$(id -u)" -eq 1000
test -r "$CREDENTIALS_DIRECTORY/web_app_signing_key"
test -r "$APP_SECRET_KEY_FILE"
test "$(cat "$CREDENTIALS_DIRECTORY/web_app_signing_key")" = "test signing key"
test -d /cache
touch /tmp/scratch
# The volume is bound with idmap, so uid 1000 owns it here as it does on the host.
echo "$*" >/cache/started
exec sleep infinity
EOF2
chmod +x "$LAYER/usr/bin/app"

mkdir -p "$IMAGE/rw"
ln -s "$BASE" "$IMAGE/layer@0"
ln -s "$LAYER" "$IMAGE/layer@1"
systemd-mstack "$IMAGE"

# Credentials: the drop-in loads them encrypted from /etc/credstore.encrypted
# and hands them to the machine with --load-credential=.
mkdir -p -m 0700 /etc/credstore.encrypted
echo -n "test signing key" | systemd-creds encrypt --name=web_app_signing_key - /etc/credstore.encrypted/web_app_signing_key
echo -n "test app secret" | systemd-creds encrypt --name=web_app-app-secret-key - /etc/credstore.encrypted/web_app-app-secret-key
chmod 0600 /etc/credstore.encrypted/web_app_signing_key /etc/credstore.encrypted/web_app-app-secret-key

# The local volume the machine binds, owned by the machine's user.
systemd-tmpfiles --create "$HOST/etc/tmpfiles.d/web-machines.conf"
test -d /var/lib/web/web_cache
assert_eq "$(stat -c %u:%g /var/lib/web/web_cache)" "1000:1000"

# Install the machine as rendered: the .nspawn file (trusted from /run/systemd/nspawn
# like /etc/systemd/nspawn), the drop-in, the stack target, and the slice.
mkdir -p /run/systemd/nspawn "/run/systemd/system/$UNIT.d"
cp "$HOST/etc/systemd/nspawn/web_app.nspawn" /run/systemd/nspawn/
cp "$HOST/etc/systemd/system/$UNIT.d/10-migration.conf" "/run/systemd/system/$UNIT.d/"
cp "$HOST/etc/systemd/system/web.target" "$HOST/etc/systemd/system/stack-web.slice" /run/systemd/system/
cat >"/run/systemd/system/$UNIT.d/test.conf" <<EOF2
[Unit]
ConditionHost=
EOF2
systemctl daemon-reload

# The rendered files are what this test relies on.
grep "^Bind=/var/lib/web/web_cache:/cache:idmap$" /run/systemd/nspawn/web_app.nspawn >/dev/null
grep "^User=1000$" /run/systemd/nspawn/web_app.nspawn >/dev/null
grep "^NoNewPrivileges=yes$" /run/systemd/nspawn/web_app.nspawn >/dev/null
grep -- "--mstack=$IMAGE --machine=%i" "/run/systemd/system/$UNIT.d/10-migration.conf" >/dev/null
grep "^LoadCredentialEncrypted=web_app_signing_key:" "/run/systemd/system/$UNIT.d/10-migration.conf" >/dev/null
systemd-analyze verify --recursive-errors=no "$UNIT"

systemctl start "$UNIT"
systemctl is-active "$UNIT"

# The payload ran its checks and wrote through the bound volume.
timeout 30 bash -c 'until test -e /var/lib/web/web_cache/started; do sleep 1; done'
assert_eq "$(cat /var/lib/web/web_cache/started)" "serve --port 8080"
assert_eq "$(stat -c %u /var/lib/web/web_cache/started)" "1000"
systemctl is-active "$UNIT"

# machined knows the machine, and it lives in the stack's slice with the limits.
machinectl list --no-legend | grep "^web_app " >/dev/null
machinectl status web_app
assert_in "stack-web.slice" "$(systemctl show -p Slice --value "$UNIT")"
assert_eq "$(systemctl show -p MemoryMax --value "$UNIT")" "536870912"
assert_eq "$(systemctl show -p TasksMax --value "$UNIT")" "512"
assert_eq "$(systemctl show -p CPUQuotaPerSecUSec --value "$UNIT")" "1.500000s"

# The stack target wants the machine's unit.
systemctl start web.target
systemctl is-active web.target
assert_in "$UNIT" "$(systemctl show -p Wants --value web.target)"

systemctl stop "$UNIT"
(! systemctl is-active "$UNIT")
timeout 30 bash -c 'while machinectl status web_app >/dev/null 2>&1; do sleep .5; done'
(! machinectl list --no-legend | grep "^web_app " >/dev/null)
