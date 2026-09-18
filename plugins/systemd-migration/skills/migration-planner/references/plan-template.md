# MIGRATION-PLAN.md template

Write the plan with exactly these top-level sections, in this order. Sections may be short; they may not be missing. Replace the guidance under each heading with content.

## 1. Scope

Which stacks and hosts are in scope, the inventory capture date, and what is explicitly out of scope (for example a stack that will be retired instead of migrated).

## 2. Decisions

Every decision in `plan.yaml` that had no default, as a table: decision id, subject, chosen value, and the user's reason. Then the defaulted decisions the user changed. Point at `plan.yaml` for the full list; this section is what future readers will look for first.

## 3. Host mapping

A table with one row per service: service, stack, mode and replica count on the source, target hosts (the `placement.hosts.<service>` decision), form (the `form.service.<service>` decision), state-bearing (yes or no), and the reason.

## 4. Networking

For each network in the inventory: whether it spans hosts, the replacement transport, subnet on each host, and how names resolve. Then the ingress replacement: what sits in front of published ports and how traffic reaches each host. Include the `systemd-networkd` and WireGuard unit shapes that will be installed, with placeholders for keys and endpoints.

## 5. Secrets and configs

A table of every credential: name, store (from the `creds.store.<name>` decision), consuming units, source of the value, importer, rotation owner. A second table for configs: name, file path on the host, consuming units, managed by which configuration tool.

## 6. Storage

A table of every volume and bind mount: name, host, size, copy method, stop window, ownership (uid:gid) to restore after copy, and verification command.

## 7. Cutover order

An ordered list of stacks with the dependency reason for the order. For each stack, the runbook from `cutover-runbook.md` filled in: preflight checks, the cutover commands, verification, rollback trigger and commands, and the person on point.

## 8. Risks and open items

One row per outstanding renderer note or capture warning: item, impact, mitigation, owner, status.

## 9. Decommissioning

When and how Swarm nodes leave the cluster (`docker node update --availability drain`, `docker swarm leave`), what evidence is archived (the raw capture directory), and when Docker itself is removed from the hosts.
