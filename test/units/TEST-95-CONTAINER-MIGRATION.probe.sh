#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The discover-systemd-hosts probe describes this machine for the planner.
# It must run read-only, produce JSON with the fields plan.yaml carries per
# host, and agree with what systemctl and uname report here.

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
PROBE="$FIXTURE/probe.sh"
OUT=/tmp/probe-test

rm -rf "$OUT"
bash "$PROBE" -o "$OUT"

HOST_FILE="$OUT/$(hostname).json"
test -f "$HOST_FILE"
jq -e . "$HOST_FILE" >/dev/null

VERSION="$(systemctl --version | sed -n 's/^systemd \([0-9][0-9]*\).*/\1/p')"
assert_eq "$(jq -r .systemd.version "$HOST_FILE")" "$VERSION"
assert_eq "$(jq -r .hostname "$HOST_FILE")" "$(hostname)"
assert_eq "$(jq -r .kernel.release "$HOST_FILE")" "$(uname -r)"
assert_eq "$(jq -r .arch "$HOST_FILE")" "$(uname -m)"

# The tree this test runs from ships every daemon and tool the components ask for.
for d in networkd resolved machined importd portabled journald; do
    assert_eq "$(jq -r ".daemons.$d" "$HOST_FILE")" "true"
done
for t in systemd-nspawn importctl machinectl systemd-repart systemd-creds systemd-dissect systemd-analyze; do
    assert_eq "$(jq -r ".tools[\"$t\"]" "$HOST_FILE")" "true"
done
assert_eq "$(jq -r .cgroup_v2 "$HOST_FILE")" "true"

# Features come from systemctl --version verbatim.
assert_in "+SECCOMP" "$(jq -r '.systemd.features | join(" ")' "$HOST_FILE")"

# The notes record each daemon's unit state, evidence the planner shows.
jq -e '.notes | map(select(startswith("systemd-networkd.service:"))) | length == 1' "$HOST_FILE" >/dev/null

rm -rf "$OUT"
