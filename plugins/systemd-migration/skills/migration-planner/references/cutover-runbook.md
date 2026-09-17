# Cutover runbook skeleton

Fill this in once per stack in the plan. Every step is a command someone can paste, and every verification names the evidence that proves it worked.

## Ordering across stacks

Move stacks in dependency order: services nothing depends on first, shared services (databases, message brokers, caches) next, and the edge proxy last. The edge proxy is last because switching it is the moment production traffic changes paths; everything behind it should already be verified.

Within a stack, start data volumes and networks, then stateful services, then stateless ones. The `<stack>.target` orders nothing by itself; add `After=` lines to the `.container` files when one service must wait for another (for example `After=data_postgres.service` in `web_app.container`) and note it in the plan.

## Per-stack runbook

**Preflight.**
- Target host has Podman, the rendered units copied (not yet installed), and `/etc/swarm-migration/secrets/` populated (root-only, one file per secret, mode 0600).
- `verify.sh --expected rendered/expected.json --dry-run` from the `systemd-verify` skill passes on the target host.
- Volume copy completed (or first pass completed for the stop-copy pattern) and ownership restored.
- Cross-host transport is up and tested with `ping` and a TCP probe from a container on the bridge.
- Rollback owner named; rollback command sequence rehearsed.

**Cutover.**
1. Freeze changes to the stack on Swarm (`docker service update --replicas` is not run; nobody deploys).
2. Stop the Swarm services in the stack, or scale to zero, and take the final volume sync.
3. On each target host: `bash hosts/<host>/secrets/import-secrets.sh` then `bash hosts/<host>/install.sh --start`.
4. `systemctl status <stack>.target` and `systemctl list-units '<stack>*'` on each host.

**Verification.**
- `verify.sh --expected rendered/expected.json --live` on each host: units active, containers healthy, ports listening.
- An application-level check that proves the workload serves correctly (an HTTP request, a query, a login), written in the plan.
- Logs quiet: `journalctl -u <unit> --since -5m` shows no restart loops.

**Rollback trigger.** State the condition (health check failing after N minutes, error rate above a threshold, a data integrity check failing) that ends the attempt.

**Rollback.**
1. `systemctl stop <stack>.target` on the new hosts.
2. Restore the Swarm services (`docker service scale`, or `docker stack deploy` from the archived compose file).
3. If data changed on the new side after cutover, decide whether to copy it back; state the decision in the plan before the cutover so it is not made under pressure.

## Dual-run pattern

When both sides can serve simultaneously (stateless services, or a database with the application in read-only mode), keep Swarm running, bring the systemd hosts up as additional backends behind the load balancer, shift a fraction of traffic, and only then remove the Swarm backends. The stop window shrinks to the time it takes to change balancer weights. This pattern does not apply to a single-writer database; use the stop-copy sequence for those.

## After the last stack

Drain and remove Swarm nodes one at a time (`docker node update --availability drain`, `docker swarm leave`, `docker node rm` from a manager). Keep one manager until every stack has run on systemd for the agreed soak period, then dissolve the swarm (`docker swarm leave --force`) and archive the raw capture directory with the plan.
