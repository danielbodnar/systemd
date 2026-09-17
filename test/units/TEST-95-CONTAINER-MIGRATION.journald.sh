#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The journal namespace path: plan-forms.yaml gives the web stack its own
# namespace, so every web service carries LogNamespace=web and the tree
# holds journald@web.conf. Installing the configuration and starting the
# namespace's journal instance must give a journal that only the stack's
# services write to.

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
HOST="$FIXTURE/rendered/forms/hosts/swarm-wrk-1"

at_exit() {
    set +e
    systemctl stop test95-web-writer.service
    systemctl stop systemd-journald@web.service systemd-journald@web.socket systemd-journald-varlink@web.socket
    rm -f /run/systemd/journald@web.conf
    systemctl daemon-reload
}

trap at_exit EXIT

test -f "$HOST/etc/systemd/journald@web.conf"
grep "^Storage=persistent$" "$HOST/etc/systemd/journald@web.conf" >/dev/null
grep "^LogNamespace=web$" "$HOST/etc/systemd/system/web_app.service" >/dev/null
# The data stack keeps the host journal.
(! grep "^LogNamespace=" "$HOST/etc/systemd/system/data_postgres.service")

cp "$HOST/etc/systemd/journald@web.conf" /run/systemd/journald@web.conf
systemctl daemon-reload

# A stand-in for a web service: the same LogNamespace= the rendered unit carries.
systemd-run --unit=test95-web-writer.service --wait -p LogNamespace=web \
    sh -c 'echo "test95 namespace message $$"'
systemctl is-active systemd-journald@web.service

journalctl --namespace=web --sync
journalctl --namespace=web -o cat --grep "test95 namespace message" >/dev/null
# The message did not land in the host journal.
(! journalctl -o cat -u test95-web-writer.service --grep "test95 namespace message" >/dev/null)
