#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
set -eux
set -o pipefail

# shellcheck source=test/units/util.sh
. "$(dirname "$0")"/util.sh

# The confext path: plan-forms.yaml ships the web stack's config files as a
# configuration extension, so the rendered tree for swarm-mgr-1 holds
# var/lib/confexts/web/ with an extension-release and the files under etc/,
# and install.sh applies the recorded ownership and runs systemd-confext
# refresh. Merging the rendered extension must put the config file into
# /etc with the recorded mode, and unmerging must take it away again.

command -v systemd-confext >/dev/null || {
    echo "no systemd-confext" >&2
    exit 77
}

FIXTURE=/usr/lib/systemd/tests/testdata/test-container-migration
HOST="$FIXTURE/rendered/forms/hosts/swarm-mgr-1"
EXT="$HOST/var/lib/confexts/web"

at_exit() {
    set +e
    systemd-confext unmerge
    umount -l -R /run/confexts 2>/dev/null
    rm -rf /run/confexts
}

trap at_exit EXIT

test -f "$EXT/etc/extension-release.d/extension-release.web"
grep "^ID=_any$" "$EXT/etc/extension-release.d/extension-release.web" >/dev/null
grep "^CONFEXT_LEVEL=1$" "$EXT/etc/extension-release.d/extension-release.web" >/dev/null
test -f "$EXT/etc/web/configs/web_caddyfile"

# The service binds the merged file into the container at the path the
# source mounted the config, and install.sh records the ownership to apply.
grep "^BindReadOnlyPaths=/etc/web/configs/web_caddyfile:/etc/caddy/Caddyfile$" "$HOST/etc/systemd/system/web_proxy.service" >/dev/null
grep "^var/lib/confexts/web/etc/web/configs/web_caddyfile 0 0 0444$" "$HOST/install.sh" >/dev/null
grep "^systemd-confext refresh$" "$HOST/install.sh" >/dev/null

# Stage the extension where systemd-confext looks without touching /var.
mkdir -p /run/confexts
mount -t tmpfs tmpfs /run/confexts -o mode=755
cp -a "$EXT" /run/confexts/web
while read -r path uid gid mode; do
    chown "$uid:$gid" "/run/confexts/${path#var/lib/confexts/}"
    chmod "$mode" "/run/confexts/${path#var/lib/confexts/}"
done < <(sed -n "/^done <<'MANIFEST'$/,/^MANIFEST$/p" "$HOST/install.sh" | grep '^var/lib/confexts/')

systemd-confext list | grep "web" >/dev/null
systemd-confext merge
systemd-confext status
test -f /etc/web/configs/web_caddyfile
cmp /etc/web/configs/web_caddyfile "$EXT/etc/web/configs/web_caddyfile"
test "$(stat -c '%a %u %g' /etc/web/configs/web_caddyfile)" = "444 0 0"

systemd-confext unmerge
test ! -e /etc/web/configs/web_caddyfile
