#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The generator path of the migration (plugins/PLAN.md 10.3). When
# generator.stacks.estate is "generator" the rendered tree carries no
# <stack>.target and no stack-<stack>.slice: it carries a description under
# etc/systemd-migration/stacks.d/ and the generator itself. This subtest runs
# that generator the way the service manager does, first into a temporary
# directory so systemd-analyze can verify what it wrote, then from
# /run/systemd/system-generators/ so the booted manager loads the result and
# systemctl can be asked what it got. The harness suite checks the rendered
# files; nothing here needs Bun.

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
RENDERED="$FIXTURE/rendered/generator"

if [[ ! -d "$RENDERED" ]]; then
    echo "no rendered/generator tree in the fixtures, skipping" >&2
    exit 77
fi

# The host whose tree holds both stacks of the fixture estate.
HOST="$RENDERED/hosts/swarm-wrk-1"
GENERATOR="$HOST/usr/lib/systemd/system-generators/systemd-migration-generator"
DESCRIPTIONS="$HOST/etc/systemd-migration/stacks.d"

test -x "$GENERATOR" || test -f "$GENERATOR"
test -d "$DESCRIPTIONS"

WORK="$(mktemp -d)"
STAGED=/run/systemd-migration/stacks.d
INSTALLED=/run/systemd/system-generators/systemd-migration-generator

at_exit() {
    set +e
    rm -f "$INSTALLED"
    rm -rf "$STAGED"
    rmdir /run/systemd-migration 2>/dev/null
    systemctl daemon-reload
    rm -rf "$WORK"
}

trap at_exit EXIT

# The rendered tree carries no grouping unit: that is the whole point of the
# decision, and it is what the service and resource-control components skip.
test -z "$(find "$HOST/etc/systemd/system" -maxdepth 1 \( -name '*.target' -o -name 'stack-*.slice' \) -print -quit)"

# A description per stack, each naming the units the components registered.
test -f "$DESCRIPTIONS/web.conf"
test -f "$DESCRIPTIONS/data.conf"
grep '^Name=data$' "$DESCRIPTIONS/data.conf" >/dev/null
grep '^Units=data_postgres.service$' "$DESCRIPTIONS/data.conf" >/dev/null
grep '^WantedBy=multi-user.target$' "$DESCRIPTIONS/data.conf" >/dev/null

# 1. Run it by hand, the way systemd.generator(7) documents a test invocation,
#    with the three output directories distinct so the choice of argv[1] shows.
install -D -m 0755 "$GENERATOR" "$WORK/systemd-migration-generator"
mkdir -p "$WORK/normal" "$WORK/early" "$WORK/late"
SYSTEMD_MIGRATION_STACKS_DIRS="$DESCRIPTIONS" \
    "$WORK/systemd-migration-generator" "$WORK/normal" "$WORK/early" "$WORK/late"

test -f "$WORK/normal/data.target"
test -f "$WORK/normal/web.target"
test -f "$WORK/normal/stack-data.slice"
test -f "$WORK/normal/stack-web.slice"
test -L "$WORK/normal/multi-user.target.wants/data.target"
test -L "$WORK/normal/multi-user.target.wants/web.target"
# argv[1] is where a generator's output belongs unless it must override /etc.
test -z "$(ls -A "$WORK/early")"
test -z "$(ls -A "$WORK/late")"

grep '^Wants=data_postgres.service$' "$WORK/normal/data.target" >/dev/null
grep "^SourcePath=$DESCRIPTIONS/data.conf\$" "$WORK/normal/data.target" >/dev/null

# The manager's own view of what the generator wrote.
systemd-analyze verify "$WORK/normal/data.target" "$WORK/normal/web.target" \
    "$WORK/normal/stack-data.slice" "$WORK/normal/stack-web.slice"

# 2. A description the generator cannot use must not cost the boot: the good
#    stacks still appear, the bad one is reported, and the status is 0.
mkdir -p "$WORK/broken" "$WORK/broken-out"
cp "$DESCRIPTIONS/data.conf" "$WORK/broken/data.conf"
echo "this is not an ini line" >"$WORK/broken/broken.conf"
SYSTEMD_MIGRATION_STACKS_DIRS="$WORK/broken" \
    "$WORK/systemd-migration-generator" "$WORK/broken-out" 2>"$WORK/broken.err"
test -f "$WORK/broken-out/data.target"
test ! -e "$WORK/broken-out/broken.target"
grep 'skipping the file' "$WORK/broken.err" >/dev/null

# 3. Install it where the booted manager runs generators from, stage the
#    descriptions under /run/, and reload so the units come from the generator
#    and not from any file this test wrote under /etc.
mkdir -p "$STAGED"
install -m 0644 "$DESCRIPTIONS/data.conf" "$STAGED/data.conf"
install -m 0644 "$DESCRIPTIONS/web.conf" "$STAGED/web.conf"
install -D -m 0755 "$GENERATOR" "$INSTALLED"

systemctl daemon-reload

# The manager loaded the generated target with the units the description lists.
systemctl show -p Wants --value data.target | tr ' ' '\n' | grep '^data_postgres\.service$' >/dev/null
systemctl show -p Wants --value web.target | tr ' ' '\n' | grep '^web_proxy\.service$' >/dev/null
systemctl show -p Description --value data.target | grep '^stack data$' >/dev/null
systemctl show -p SourcePath --value data.target | grep "^$STAGED/data.conf\$" >/dev/null
# WantedBy= in the description became the .wants/ symlink the manager reads.
systemctl show -p WantedBy --value data.target | tr ' ' '\n' | grep '^multi-user\.target$' >/dev/null

# The slice came out with the accounting the description asked for.
systemctl show -p Description --value stack-data.slice | grep '^stack data slice$' >/dev/null
if grep '^Accounting=yes$' "$STAGED/data.conf" >/dev/null; then
    test "$(systemctl show -p MemoryAccounting --value stack-data.slice)" = "yes"
    test "$(systemctl show -p TasksAccounting --value stack-data.slice)" = "yes"
fi

# A generated unit has no fragment under /etc/systemd/system: it lives only in
# the generator directory, and it is gone after the next reload without it.
systemctl show -p FragmentPath --value data.target | grep '^/run/systemd/generator/data\.target$' >/dev/null

rm -f "$INSTALLED"
rm -rf "$STAGED"
systemctl daemon-reload
test "$(systemctl show -p LoadState --value data.target)" != "loaded"
