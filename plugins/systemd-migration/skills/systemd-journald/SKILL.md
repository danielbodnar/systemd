---
name: systemd-journald
description: The logging component. Every migrated service logs to the journal under its own SyslogIdentifier= with the stack and service recorded as journal fields (LogExtraFields=), and a stack can get its own journal namespace (LogNamespace=, journald@.conf) with separate retention. Use this whenever the user asks where container logs go on systemd, how to filter logs per stack, about journald namespaces, log drivers, journalctl fields, or forwarding with systemd-journal-upload.
---

# systemd-journald

Docker's logging drivers write a container's stdout and stderr somewhere; on systemd the somewhere is the journal, structured, indexed, and rotated by `journald.conf(5)`. This component makes the migrated services easy to find in it and, when asked, keeps a stack's logs apart.

## Decisions it raises

`journald.namespace.<stack>`: `shared` (default; one journal, filter with `SWARM_STACK=<stack>` or the unit name) or `namespace` (`LogNamespace=<stack>` on every unit of the stack, `journald@<stack>.service` with its own storage and retention from `/etc/systemd/journald@<stack>.conf`).

## What it renders

- `SyslogIdentifier=<unit base name>` and `LogExtraFields=SWARM_STACK=<stack> SWARM_SERVICE=<service>` on every service unit, so `journalctl SWARM_STACK=web` or `journalctl -u web_app` finds the lines.
- With a namespace: `LogNamespace=<stack>` on the units and `/etc/systemd/journald@<stack>.conf` with persistent storage; read with `journalctl --namespace=<stack>`.
- A log driver other than `json-file`, `journald`, or `local` is noted: its destination (a syslog server, a cloud sink) becomes `systemd-journal-upload` or a forwarder you configure on the host.

## Files

- `scripts/component.ts`: the component module.
