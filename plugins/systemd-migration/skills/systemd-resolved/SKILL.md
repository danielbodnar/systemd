---
name: systemd-resolved
description: The name resolution component. Replaces the orchestrator's embedded DNS (service names, network aliases, dnsrr endpoints) with one of three mechanisms chosen in plan.yaml: rendered /etc/hosts entries that point at a host or at a machine's static lease on its zone bridge, systemd-resolved with DNS-SD announcements per host (.dnssd files, mDNS and LLMNR on the zone), or records in the site's DNS. Use this whenever the user asks how services find each other after the migration, how a machine on a zone bridge is named, about resolved.conf, resolvectl, DNS-SD, mDNS, LLMNR, LocalLeaseDomain, service aliases, or /etc/hosts.
---

# systemd-resolved

Inside an orchestrator network a service is reachable by its name because the runtime answers DNS for it. On a systemd host the resolver is `systemd-resolved`, and a name has to come from somewhere real: a hosts file, a multicast announcement, or the site's DNS.

## Decisions it raises

`resolved.discovery.estate`, one for the estate, no default: `hosts` (a rendered fragment maps every service name and alias to the address of the host that runs it; static and daemon-free), `dnssd` (each host announces its services with `.dnssd` files and resolves peers by mDNS or LLMNR; needs resolved), or `site-dns` (the plan lists the records to create; nothing is rendered).

## What it renders

- `hosts`: `/etc/hosts.d/systemd-migration.hosts` with one line per service and host, from the plan's placement; `install.sh` appends it to `/etc/hosts` (re-installs need a manual dedupe, which is noted). A plain service is listed at its host's address, from the host probes or, failing that, the inventory's node addresses. A machine on a zone bridge is listed at the static lease the networkd component rendered for it, under its machine name, the service name, and the aliases, so `web_app-2` and `app` both resolve to the lease; a machine on a macvlan or ipvlan segment is listed at the address the guest is meant to configure, which is noted as a decision. On the host itself the lease names also resolve under the bridge's `LocalLeaseDomain=` (decision `networkd.domain.<network>`, `_dhcp` by default) once the lease is handed out; the fragment does not depend on that.
- `dnssd`: `/etc/systemd/dnssd/<unit>-<port>.dnssd` per published port with the stack and service in `TxtText=`, `/etc/systemd/resolved.conf.d/10-migration.conf` turning on multicast DNS and LLMNR, and a `try-restart` of resolved after install. A machine's published port is forwarded from the host by `Port=` in its `.nspawn` file, so the announcement on the host's address is right for machines too; nothing else is rendered for them, and `resolved.conf.d` settings appear only when the mechanism needs them.
- `site-dns`: a decision note listing name, host, and port per service.

Per-service `dns` settings from the source are not applied to a plain service, which uses the host's resolver; a machine can carry them in its `.nspawn` file.

## Files

- `scripts/component.ts`: the component module.
