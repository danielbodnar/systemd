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
4. `systemctl status <stack>.target` and `systemctl list-units '<stack>*'` on each host, then `/usr/local/lib/systemd-migration/stackctl status <stack>`, which reports each instance's state, its image version, and its last health result from the rollout specification `install.sh` put in place.

**Verification.**
- `verify.sh --expected rendered/expected.json --live` on each host: units active, containers healthy, ports listening.
- An application-level check that proves the workload serves correctly (an HTTP request, a query, a login), written in the plan.
- Logs quiet: `journalctl -u <unit> --since -5m` shows no restart loops.

**Rollback trigger.** State the condition (health check failing after N minutes, error rate above a threshold, a data integrity check failing) that ends the attempt.

**Rollback.**
1. `stackctl drain <host>` on each new host, which stops the stack's sockets before its instances in rollout order, or `systemctl stop <stack>.target` when the stack is not yet under the controller.
2. Restore the Swarm services (`docker service scale`, or `docker stack deploy` from the archived compose file).
3. If data changed on the new side after cutover, decide whether to copy it back; state the decision in the plan before the cutover so it is not made under pressure.

## After the cutover: the rollout controller

Once a stack is installed, everything that used to be `docker service update`,
`docker service rollback`, `docker service scale`, and
`docker node update --availability` is a verb of the rollout controller the
systemd-rollout skill renders, `/usr/local/lib/systemd-migration/stackctl`. It
reads `/etc/systemd-migration/rollout/<stack>.conf`, which carries each
service's parallelism, delay, order, failure action and monitor window from the
source's own `update_config`, so a deploy on systemd restarts instances in the
batches the estate already used.

| Intent | Command on the host |
|---|---|
| deploy a new image | `stackctl deploy <stack> --image <local-name>=<ref>` |
| roll a service back | `stackctl rollback <stack> [<service>]` |
| take the host out of service | `stackctl drain <host>` |
| put it back | `stackctl activate <host>` |
| change the instance count within the plan | `stackctl scale <service> <n>` |
| replace a secret or a config | `stackctl rotate credential <name>`, `stackctl rotate config <name>` |
| see where a stack stands | `stackctl status <stack>` |

Every verb takes `--dry-run`, which prints the exact sequence of commands the
real run prints and changes nothing; run it that way first and put its output
in the change record. The exit code is the verdict: 0 done, 1 a batch did not
come back and the failure action was applied, 2 usage or something this host
does not run, 3 a malformed specification, 4 a missing tool or script.

Two things the controller deliberately will not do, because they change the
shape of the estate rather than its state: run more instances of a service on a
host than the plan rendered there, and run a service on a host the plan does not
place it on. Both are decisions in `plan.yaml` (`placement.hosts.<service>`,
`placement.scale_out.estate`) followed by a re-render and `install.sh`. Write
that into the stack's runbook so the person on call does not reach for a hand
edit under pressure.

Nothing reschedules a drained host's work. Before a drain, name the services
whose only instance on the estate is on that host, and say which host takes
them over first; `stackctl drain` stops them and the capacity is gone until
another host is activated or scaled. The socket units go down before the
instances, so a socket-activated or proxied backend stops accepting connections
before the process behind it stops.

The systemd-rollout skill's `references/runbook.md` maps each Swarm command
onto its verb in full, with the arguments.

## Dual-run pattern

When both sides can serve simultaneously (stateless services, or a database with the application in read-only mode), keep Swarm running, bring the systemd hosts up as additional backends behind the load balancer, shift a fraction of traffic, and only then remove the Swarm backends. The stop window shrinks to the time it takes to change balancer weights. This pattern does not apply to a single-writer database; use the stop-copy sequence for those.

## After the last stack

Drain and remove Swarm nodes one at a time (`docker node update --availability drain`, `docker swarm leave`, `docker node rm` from a manager). Keep one manager until every stack has run on systemd for the agreed soak period, then dissolve the swarm (`docker swarm leave --force`) and archive the raw capture directory with the plan.
