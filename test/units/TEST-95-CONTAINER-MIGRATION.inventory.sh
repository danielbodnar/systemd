#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
INVENTORY="$FIXTURE/inventory.json"
RENDERED="$FIXTURE/rendered/native"

# The committed inventory is what the normalizer produced from the capture;
# the harness test suite checks that it is fresh, this checks its content.
jq -e . "$INVENTORY" >/dev/null

assert_eq "$(jq -r .version "$INVENTORY")" "1"
assert_eq "$(jq '.nodes | length' "$INVENTORY")" "2"
assert_eq "$(jq '.stacks | length' "$INVENTORY")" "2"
assert_eq "$(jq '.services | length' "$INVENTORY")" "4"
assert_eq "$(jq '.networks | length' "$INVENTORY")" "4"
assert_eq "$(jq '.volumes | length' "$INVENTORY")" "3"
assert_eq "$(jq '.secrets | length' "$INVENTORY")" "2"
assert_eq "$(jq '.configs | length' "$INVENTORY")" "1"
assert_eq "$(jq '.images | length' "$INVENTORY")" "2"

# Every service belongs to a stack, and every stack lists its services.
assert_eq "$(jq '[.services[] | select(.stack == null)] | length' "$INVENTORY")" "0"
assert_eq "$(jq -r '.stacks[] | select(.name == "web") | .services | join(",")' "$INVENTORY")" "web_app,web_proxy"

# Secret values never reach the inventory: the capture's placeholder value is
# redacted, the secret objects carry names only, and a *_FILE variable that
# points at a secret keeps its path.
(! grep -F "fixture-placeholder-not-a-secret" "$INVENTORY")
assert_eq "$(jq -r '.services[] | select(.name == "web_app") | .env.APP_SECRET_KEY' "$INVENTORY")" "<redacted>"
assert_eq "$(jq -r '.services[] | select(.name == "data_postgres") | .env.POSTGRES_PASSWORD_FILE' "$INVENTORY")" "/run/secrets/postgres_password"
assert_eq "$(jq '[.secrets[] | has("value")] | any' "$INVENTORY")" "false"

# The warnings the renderers act on.
jq -r '.warnings[]' "$INVENTORY" | grep "ingress routing mesh" >/dev/null
jq -r '.warnings[]' "$INVENTORY" | grep "encrypted overlay" >/dev/null
jq -r '.warnings[]' "$INVENTORY" | grep "is failed" >/dev/null
jq -r '.warnings[]' "$INVENTORY" | grep "not pinned" >/dev/null

# Image configuration recorded on the capturing node, used for ExecStart=.
assert_eq "$(jq -r '.images[] | select(.ref == "registry.example.com/acme/app:2026.09") | .entrypoint | join(" ")' "$INVENTORY")" "/usr/bin/app"
assert_eq "$(jq -r '.images[] | select(.ref == "docker.io/library/caddy:2") | .cmd[0]' "$INVENTORY")" "caddy"

# The rendered tree names every image the units expect.
assert_eq "$(jq 'keys | length' "$RENDERED/images.json")" "4"
assert_eq "$(jq -r '."acme-app_2026.09".hosts | join(",")' "$RENDERED/images.json")" "swarm-wrk-1"
test -f "$RENDERED/MIGRATION-NOTES.md"
grep "## Needs a human decision" "$RENDERED/MIGRATION-NOTES.md" >/dev/null
