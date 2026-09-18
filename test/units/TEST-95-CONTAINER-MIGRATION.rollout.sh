#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The rollout controller reads the rendered rollout specification and drives
# systemctl with it. This subtest installs the web stack's unit the way
# TEST-95-CONTAINER-MIGRATION.mstack.sh does, points the rendered
# specification at this host, and exercises the read-only verbs (status,
# deploy --dry-run) and then a real drain and activate, checking the
# manager's view of the unit after each step.

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
HOST="$FIXTURE/rendered/native/hosts/swarm-wrk-1"
SPEC="$HOST/etc/systemd-migration/rollout/web.conf"
CTL="$HOST/usr/local/lib/systemd-migration/stackctl"

# The coordinator regenerates the committed tree; until it has, neither file
# is there and there is nothing to exercise.
if [[ ! -f "$SPEC" ]] || [[ ! -f "$CTL" ]]; then
    echo "rendered rollout specification or controller not present in the fixture tree" >&2
    exit 77
fi

# The controller is POSIX sh and must parse as such.
sh -n "$CTL"
bash -n "$CTL"

if ! command -v systemd-mstack >/dev/null; then
    echo "no systemd-mstack" >&2
    exit 77
fi

# A writable overlay layer needs FSCONFIG_SET_FD support in overlayfs.
if systemd-analyze condition 'ConditionVersion= < 6.13'; then
    echo "Kernel too old for FSCONFIG_SET_FD support on overlayfs, skipping"
    exit 77
fi

IMAGE=/var/lib/machines/acme-app_2026.09.mstack
BASE=/var/lib/machines/.rollout-base
LAYER=/var/lib/machines/.rollout-layer
WORK="$(mktemp -d)"

at_exit() {
    set +e
    systemctl stop web_app-health.timer web_app.service
    rm -rf /run/systemd/system/web_app.service.d /run/systemd/system/web_app-health.service.d
    rm -f /run/systemd/system/web_app.service /run/systemd/system/web_app-health.service \
          /run/systemd/system/web_app-health.timer /run/systemd/system/web_app-restart.service \
          /run/systemd/system/stack-web.slice
    systemctl daemon-reload
    rm -rf "$IMAGE" "$BASE" "$LAYER" "$WORK" /etc/swarm-migration \
           /etc/credstore.encrypted/web_app_signing_key \
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
systemd-mstack "$IMAGE"

# Credentials and the local volume, as the runbook places them.
mkdir -p -m 0700 /etc/swarm-migration/secrets
echo "test signing key" >/etc/swarm-migration/secrets/web_app_signing_key
echo "test app secret" >/etc/swarm-migration/secrets/web_app-app-secret-key
chmod 0600 /etc/swarm-migration/secrets/*
bash "$HOST/secrets/import-credentials.sh"
systemd-tmpfiles --create "$HOST/etc/tmpfiles.d/web.conf"

# The web stack's units as rendered, with the host condition and the
# healthcheck's command (which the fixture image cannot run) taken out.
for unit in web_app.service web_app-health.service web_app-health.timer web_app-restart.service stack-web.slice; do
    cp "$HOST/etc/systemd/system/$unit" /run/systemd/system/
done
mkdir -p /run/systemd/system/web_app.service.d /run/systemd/system/web_app-health.service.d
cat >/run/systemd/system/web_app.service.d/test.conf <<'EOF2'
[Unit]
ConditionHost=
EOF2
cat >/run/systemd/system/web_app-health.service.d/test.conf <<'EOF2'
[Service]
ExecStart=
ExecStart=/usr/bin/env test -x /usr/bin/app
EOF2
systemctl daemon-reload

# The rendered specification, with this host's name in it so the controller
# accepts drain and activate. Nothing else about it is edited: the units, the
# health unit, the order, the parallelism and the monitor window are what the
# renderer wrote from the source's update_config.
mkdir -p "$WORK/rollout"
sed "s/^Host=.*/Host=$(hostname)/" "$SPEC" >"$WORK/rollout/web.conf"
grep '^\[Service web_app\]$' "$WORK/rollout/web.conf" >/dev/null
grep '^Units=web_app.service$' "$WORK/rollout/web.conf" >/dev/null
grep '^Order=start-first$' "$WORK/rollout/web.conf" >/dev/null

export SYSTEMD_MIGRATION_ROLLOUT_DIR="$WORK/rollout"
export SYSTEMD_MIGRATION_STATE_DIR="$WORK/state"

systemctl start web_app.service
systemctl is-active web_app.service
systemctl start web_app-health.service
assert_eq "$(systemctl show -p Result --value web_app-health.service)" "success"

# status reports the instance and its health result, and changes nothing.
sh "$CTL" status web >"$WORK/status.txt"
grep "^stack web on $(hostname)$" "$WORK/status.txt" >/dev/null
grep '^  web_app (service, order start-first, failure rollback, parallelism 1)$' "$WORK/status.txt" >/dev/null
grep "^    image $IMAGE\$" "$WORK/status.txt" >/dev/null
grep '^    web_app.service active, health success$' "$WORK/status.txt" >/dev/null
assert_eq "$(systemctl show -p ActiveState --value web_app.service)" "active"
assert_eq "$(systemctl show -p NRestarts --value web_app.service)" "0"

# A dry run prints the commands it would run and runs none of them. One
# instance cannot hold capacity, so start-first falls back to stop-first and
# the controller says so.
sh "$CTL" deploy web --dry-run >"$WORK/deploy.txt" 2>"$WORK/deploy.err"
grep '^+ systemctl stop web_app.service$' "$WORK/deploy.txt" >/dev/null
grep '^+ systemctl start web_app.service$' "$WORK/deploy.txt" >/dev/null
grep 'start-first cannot hold capacity' "$WORK/deploy.err" >/dev/null
assert_eq "$(systemctl show -p NRestarts --value web_app.service)" "0"
systemctl is-active web_app.service

# A real drain stops this host's instances, and prints the same sequence the
# dry run printed.
sh "$CTL" drain "$(hostname)" --dry-run >"$WORK/drain-dry.txt"
sh "$CTL" drain "$(hostname)" >"$WORK/drain.txt"
diff "$WORK/drain-dry.txt" "$WORK/drain.txt"
grep '^+ systemctl stop web_app.service$' "$WORK/drain.txt" >/dev/null
(! systemctl is-active web_app.service)
assert_eq "$(systemctl show -p ActiveState --value web_app.service)" "inactive"

# activate brings them back.
sh "$CTL" activate "$(hostname)" >"$WORK/activate.txt"
grep '^+ systemctl start web_app.service$' "$WORK/activate.txt" >/dev/null
systemctl is-active web_app.service
assert_eq "$(systemctl show -p ActiveState --value web_app.service)" "active"

# The controller acts on the host it was rendered for, and on no other.
(! sh "$CTL" drain not-this-host --dry-run)
systemctl is-active web_app.service

# A scale beyond the instances the plan rendered is a re-render, and says so.
set +e
sh "$CTL" scale web_app 2 --dry-run >"$WORK/scale.txt" 2>&1
rc=$?
set -e
assert_eq "$rc" "2"
grep 'is a re-render, not a scale' "$WORK/scale.txt" >/dev/null
systemctl is-active web_app.service

# Scaling to the one instance that exists is a no-op that leaves it running.
sh "$CTL" scale web_app 1 >"$WORK/scale-1.txt"
grep '^+ systemctl start web_app.service$' "$WORK/scale-1.txt" >/dev/null
systemctl is-active web_app.service

systemctl stop web_app.service
(! systemctl is-active web_app.service)
