#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# The container migration tooling under plugins/ renders the fixture estate
# in test/test-container-migration/ into systemd units. These subtests check
# the committed inventory, mount a rendered image as a service's root, and
# verify every rendered unit with systemd-analyze.

if [[ ! -d /usr/lib/systemd/tests/testdata/test-container-migration ]]; then
    echo "test-container-migration fixtures not installed" >/skipped
    exit 77
fi

# shellcheck source=test/units/test-control.sh
. "$(dirname "$0")"/test-control.sh

run_subtests_and_exit
