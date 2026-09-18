#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The DNS-SD discovery path: plan-forms.yaml announces every published port
# with a .dnssd file and enables multicast resolution in a resolved.conf.d
# drop-in. Installing the rendered files for swarm-wrk-1 must make resolved
# register one DNS-SD service per file and turn mDNS and LLMNR on.

if ! command -v resolvectl >/dev/null || ! systemctl list-unit-files systemd-resolved.service >/dev/null 2>&1; then
    echo "no systemd-resolved" >&2
    exit 77
fi

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
HOST="$FIXTURE/rendered/forms/hosts/swarm-wrk-1"

at_exit() {
    set +e
    rm -f /run/systemd/dnssd/web_app-8080.dnssd /run/systemd/dnssd/data_exporter-9187.dnssd \
          /run/systemd/resolved.conf.d/10-migration.conf
    systemctl restart systemd-resolved.service
}

trap at_exit EXIT

# One announcement per published port, typed after the service, with the
# stack and service recorded in the TXT data; %H stands for the host.
for f in "$HOST"/etc/systemd/dnssd/*.dnssd; do
    grep "^Name=.* on %H$" "$f" >/dev/null
    grep -E "^Type=_[a-z0-9-]+\._(tcp|udp)$" "$f" >/dev/null
    grep -E "^Port=[0-9]+$" "$f" >/dev/null
    grep "^TxtText=stack=.* service=.*$" "$f" >/dev/null
done
grep "^MulticastDNS=yes$" "$HOST/etc/systemd/resolved.conf.d/10-migration.conf" >/dev/null
grep "^LLMNR=yes$" "$HOST/etc/systemd/resolved.conf.d/10-migration.conf" >/dev/null
grep "^systemctl try-restart systemd-resolved.service$" "$HOST/install.sh" >/dev/null

mkdir -p /run/systemd/dnssd /run/systemd/resolved.conf.d
cp "$HOST"/etc/systemd/dnssd/*.dnssd /run/systemd/dnssd/
cp "$HOST/etc/systemd/resolved.conf.d/10-migration.conf" /run/systemd/resolved.conf.d/
systemctl restart systemd-resolved.service

[[ "$(resolvectl mdns)" =~ :\ (yes|resolve)$ ]]
[[ "$(resolvectl llmnr)" =~ :\ (yes|resolve)$ ]]

# resolved exposes one object per registered service; the rendered files
# give two on this host.
tree="$(busctl tree org.freedesktop.resolve1)"
expected="$(ls "$HOST"/etc/systemd/dnssd/*.dnssd | wc -l)"
registered="$(echo "$tree" | grep -c "/org/freedesktop/resolve1/dnssd/" || true)"
test "$registered" -eq "$expected"
