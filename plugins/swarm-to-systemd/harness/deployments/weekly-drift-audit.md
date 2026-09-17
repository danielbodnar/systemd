---
name: Weekly swarm drift audit
agent: ../agents/swarm-auditor.md
environment_id: ../environments/production-host.yaml
resources:
  - path: ../memory_stores/migration-journal.yaml
    access: read_write
schedule:
  type: cron
  expression: "0 6 * * 1"
  timezone: UTC
budget:
  type: limit
  max_list_cost:
    amount: "1500"
    currency: USD
metadata:
  harness: swarm-to-systemd
---

Re-capture the swarm into a fresh directory under `capture/` named with today's date, normalize it, and compare it with the inventory recorded in the journal's most recent entry. Report new, removed, and changed services, networks, secrets, and node labels, then append the comparison to the journal. Do not modify the cluster.
