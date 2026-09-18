#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The HAProxy adapter: when a published port's publish decision is "haproxy",
# the haproxy-ingress component renders /etc/haproxy/haproxy.cfg and a
# hardened haproxy-migration.service for every host in the ingress scope.
# This subtest takes the committed tree as it is. HAProxy itself validates
# every rendered configuration, and the first host's configuration is then
# started under the rendered unit against stub backends on the loopback
# interface, so the frontends, the health checks, and the runtime socket are
# exercised rather than described. The harness suite checks the same files
# against the directive catalogue; this runs them.

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
RENDERED="$FIXTURE/rendered/haproxy"
UNIT=haproxy-migration.service
SAVED=/run/haproxy-migration-test-saved.cfg

if ! command -v haproxy >/dev/null; then
    echo "no haproxy on this image, skipping" >&2
    exit 77
fi

if [[ ! -d "$RENDERED" ]]; then
    echo "no rendered/haproxy tree in the fixtures (no committed plan hands a port to HAProxy), skipping" >&2
    exit 77
fi

haproxy -v

# Every rendered configuration parses, whichever host it was rendered for.
configs=()
while read -r cfg; do
    configs+=("$cfg")
done < <(find "$RENDERED/hosts" -path '*/etc/haproxy/haproxy.cfg' | sort)
test "${#configs[@]}" -gt 0
for cfg in "${configs[@]}"; do
    haproxy -c -f "$cfg"
done

CFG="${configs[0]}"
HOST="$(dirname "$(dirname "$(dirname "$CFG")")")"
test -f "$HOST/etc/systemd/system/$UNIT"

# The rendered files say what this subtest then relies on.
grep -E '^frontend [A-Za-z0-9_.:-]+$' "$CFG" >/dev/null
grep -E '^backend [A-Za-z0-9_.:-]+$' "$CFG" >/dev/null
grep -E '^ +balance roundrobin$' "$CFG" >/dev/null
grep -E '^ +server [A-Za-z0-9_.:-]+ ' "$CFG" >/dev/null
grep -E '^Type=notify$' "$HOST/etc/systemd/system/$UNIT" >/dev/null
grep -E '^ExecStart=haproxy -Ws -f /etc/haproxy/haproxy.cfg ' "$HOST/etc/systemd/system/$UNIT" >/dev/null
grep -E '^ExecStartPre=haproxy -c -q -f /etc/haproxy/haproxy.cfg$' "$HOST/etc/systemd/system/$UNIT" >/dev/null
grep -E '^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$' "$HOST/etc/systemd/system/$UNIT" >/dev/null
grep -E '^AmbientCapabilities=CAP_NET_BIND_SERVICE$' "$HOST/etc/systemd/system/$UNIT" >/dev/null
grep -E '^NoNewPrivileges=yes$' "$HOST/etc/systemd/system/$UNIT" >/dev/null
grep -E '^ProtectSystem=strict$' "$HOST/etc/systemd/system/$UNIT" >/dev/null
jq -e --arg u "$UNIT" '.units | index($u)' "$HOST/expected.json" >/dev/null

# A configuration the renderer did not write is refused, which is what the
# unit's ExecStartPre= and its first ExecReload= run.
cp "$CFG" /run/haproxy-broken.cfg
echo "not-a-haproxy-keyword" >>/run/haproxy-broken.cfg
(! haproxy -c -q -f /run/haproxy-broken.cfg)
rm -f /run/haproxy-broken.cfg

# The addresses the frontends bind and the backends answer on belong to the
# fixture estate, so they go on the loopback interface for the duration.
addresses=()
while read -r addr; do
    addresses+=("$addr")
done < <(sed -n -e 's/^ *bind \([0-9.]*\):[0-9]*.*/\1/p' -e 's/^ *server [^ ]* \([0-9.]*\):[0-9]*.*/\1/p' "$CFG" | sort -u)
test "${#addresses[@]}" -gt 0

added=()
stubs=()

at_exit() {
    set +e
    systemctl stop "$UNIT"
    for stub in ${stubs[@]+"${stubs[@]}"}; do
        systemctl stop "$stub"
    done
    for addr in ${added[@]+"${added[@]}"}; do
        ip addr del "$addr/32" dev lo
    done
    rm -f "/run/systemd/system/$UNIT" /etc/haproxy/haproxy.cfg /run/haproxy-stub-responder
    rm -rf "/run/systemd/system/$UNIT.d"
    if [[ -f "$SAVED" ]]; then
        mv "$SAVED" /etc/haproxy/haproxy.cfg
    else
        rmdir /etc/haproxy
    fi
    systemctl daemon-reload
}

trap at_exit EXIT

for addr in "${addresses[@]}"; do
    if ip -4 -oneline addr show dev lo | grep -F " $addr/" >/dev/null; then
        continue
    fi
    ip addr add "$addr/32" dev lo
    added+=("$addr")
done

# One stub per server line: an inetd-style listener that answers anything
# with a minimal HTTP response, which satisfies a TCP connect check and an
# HTTP check alike.
cat >/run/haproxy-stub-responder <<'EOF'
#!/usr/bin/env bash
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n'
EOF
chmod 0755 /run/haproxy-stub-responder

index=0
while read -r endpoint; do
    index=$((index + 1))
    stub="haproxy-stub-$index.service"
    systemd-run --unit="$stub" --service-type=exec \
        systemd-socket-activate --listen="$endpoint" --accept --inetd /run/haproxy-stub-responder
    stubs+=("$stub")
done < <(sed -n 's/^ *server [^ ]* \([0-9.]*:[0-9]*\).*/\1/p' "$CFG" | sort -u)
test "${#stubs[@]}" -gt 0
for stub in "${stubs[@]}"; do
    systemctl is-active "$stub"
done

# Install the unit as rendered, apart from its ConditionHost= guard, and the
# configuration where the unit reads it.
if [[ -f /etc/haproxy/haproxy.cfg ]]; then
    mv /etc/haproxy/haproxy.cfg "$SAVED"
fi
mkdir -p /etc/haproxy "/run/systemd/system/$UNIT.d"
cp "$CFG" /etc/haproxy/haproxy.cfg
cp "$HOST/etc/systemd/system/$UNIT" /run/systemd/system/
cat >"/run/systemd/system/$UNIT.d/test.conf" <<EOF
[Unit]
ConditionHost=
EOF
systemctl daemon-reload
systemd-analyze verify --recursive-errors=no "$UNIT"

systemctl start "$UNIT"
systemctl is-active "$UNIT"

# Type=notify means the unit went active only once the master signalled
# readiness, and the runtime directory holds the socket the rollout
# controller drains servers through.
assert_eq "$(systemctl show -p Type --value "$UNIT")" "notify"
assert_eq "$(systemctl show -p DynamicUser --value "$UNIT")" "yes"
test -S /run/haproxy-migration/admin.sock

# Every frontend answers on the address and port it binds, and the answer
# came from a stub through the backend.
while read -r bind; do
    addr="${bind%:*}"
    port="${bind##*:}"
    response=""
    for _ in $(seq 1 30); do
        if response="$(timeout 10 bash -c "exec 3<>/dev/tcp/$addr/$port; printf 'GET /healthz HTTP/1.0\r\nHost: $addr\r\n\r\n' >&3; cat <&3")"; then
            break
        fi
        sleep 1
    done
    assert_in "HTTP/1.1 200 OK" "$response"
    assert_in "ok" "$response"
done < <(sed -n 's/^ *bind \([0-9.]*:[0-9]*\).*/\1/p' "$CFG" | sort -u)

# The health checks bring the servers up; HAProxy reports one line per server
# on the runtime socket, with 2 as the operational state of a running server.
if command -v socat >/dev/null; then
    timeout 60 bash -c 'until echo "show servers state" | socat stdio /run/haproxy-migration/admin.sock | grep -E " 2 [0-9]+ " >/dev/null; do sleep 1; done'
fi

# A reload re-reads the file the renderer wrote and keeps the frontends up.
systemctl reload "$UNIT"
systemctl is-active "$UNIT"

systemctl stop "$UNIT"
(! systemctl is-active "$UNIT")
