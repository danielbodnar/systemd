#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The networkd component renders, for every service the committed
# plan-machine.yaml runs as a machine, the zone bridge's .network file with a
# static lease for the machine inside the decided range, and, for an overlay
# whose machines span hosts, a VXLAN netdev with the decided VNI. The harness
# suite checks the files against the directive catalogue; this subtest checks
# without Bun that the committed machine tree agrees with the committed
# inventory and plan: every address a bridge file carries lies inside the
# range the plan decided, the leases lie inside the range the source used,
# and every VXLAN names the VNI the plan decided.

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
RENDERED="$FIXTURE/rendered/machine"
PLAN="$FIXTURE/plan-machine.yaml"
INVENTORY="$FIXTURE/inventory.json"

if [[ ! -d "$RENDERED" || ! -f "$PLAN" ]]; then
    echo "no rendered/machine tree or plan-machine.yaml in the fixtures, skipping" >&2
    exit 77
fi

# decided ID: the value the committed plan chose for a decision, else its default.
decided() {
    awk -v id="$1" '
        $1 == "-" && $2 == "id:" { active = ($3 == id) }
        active && $1 == "default:" { def = $2 }
        active && $1 == "chosen:" { val = $2 }
        END { if (val == "" || val == "null") val = def; gsub(/"/, "", val); print val }
    ' "$PLAN"
}

ip2int() {
    local IFS=.
    # shellcheck disable=SC2034
    read -r a b c d <<<"$1"
    echo $(( (a << 24) | (b << 16) | (c << 8) | d ))
}

# in_cidr ADDRESS CIDR: succeeds when the address lies inside the range.
in_cidr() {
    local addr="$1" net="${2%/*}" prefix="${2#*/}" mask
    mask=$(( prefix == 0 ? 0 : (0xffffffff << (32 - prefix)) & 0xffffffff ))
    (( ($(ip2int "$addr") & mask) == ($(ip2int "$net") & mask) ))
}

# keys FILE KEY: every value of KEY= in the file, without a /prefix suffix.
keys() {
    sed -n "s/^$2=//p" "$1" | sed 's,/.*,,'
}

leases=0
vxlans=0
for host in "$RENDERED"/hosts/*/; do
    name="$(basename "$host")"
    netdir="$host/etc/systemd/network"
    [[ -d "$netdir" ]] || continue
    for file in "$netdir"/25-migration-vz-*.network; do
        [[ -f "$file" ]] || continue
        base="$(basename "$file")"
        net="${base#25-migration-vz-}"
        net="${net%.network}"
        source_subnet="$(jq -r --arg n "$net" '.networks[] | select(.name == $n) | .ipam.config[0].subnet' "$INVENTORY")"
        decided_subnet="$(decided "networkd.subnet.$net")"
        test -n "$source_subnet"
        test -n "$decided_subnet"
        grep -E "^Name=vz-$net\$" "$file" >/dev/null
        grep -E "^DHCPServer=yes\$" "$file" >/dev/null
        # No address in the bridge file leaves the decided range: the gateway, the leases, all of them.
        for addr in $(keys "$file" Address); do
            in_cidr "$addr" "$decided_subnet"
        done
        # The machines' static leases lie inside the range the source used, and each has a locally administered MAC.
        for addr in $(sed -n '/^\[DHCPServerStaticLease\]/,/^\[/{s/^Address=//p}' "$file"); do
            in_cidr "$addr" "$source_subnet"
            leases=$((leases + 1))
        done
        for mac in $(keys "$file" MACAddress); do
            assert_in '^[0-9a-f][26ae](:[0-9a-f]{2}){5}$' "$mac"
        done
        jq -e --arg f "$base" '.networks | index($f)' "$host/expected.json" >/dev/null
    done
    for file in "$netdir"/25-migration-vx-*.netdev; do
        [[ -f "$file" ]] || continue
        base="$(basename "$file")"
        net="${base#25-migration-vx-}"
        net="${net%.netdev}"
        grep -E "^Kind=vxlan\$" "$file" >/dev/null
        assert_eq "$(keys "$file" VNI)" "$(decided "networkd.vni.$net")"
        vxlans=$((vxlans + 1))
    done
    # A WireGuard netdev never carries a key value, only credential names.
    for file in "$netdir"/25-migration-wg-*.netdev; do
        [[ -f "$file" ]] || continue
        if grep -E '^(PrivateKey|PublicKey)=[^@]' "$file" >/dev/null; then
            echo "FAIL: $file carries a key value instead of a credential name" >&2
            exit 1
        fi
    done
    echo "checked $name"
done

# The committed plan runs at least one service as a machine on a zone, so at least one lease is rendered.
machine_count="$(grep -c '^ *chosen: machine$' "$PLAN")"
test "$machine_count" -gt 0
test "$leases" -gt 0
if [[ "$vxlans" -eq 0 ]]; then
    echo "no VXLAN netdev in the committed machine tree (its machines share one host); the VNI check ran on nothing"
fi
