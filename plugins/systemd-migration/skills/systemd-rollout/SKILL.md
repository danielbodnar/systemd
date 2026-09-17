---
name: systemd-rollout
description: The rollout component. Renders a rollout specification per stack and a POSIX sh controller, stackctl, that performs on a systemd host what docker service update, docker stack deploy, docker service rollback, docker service scale, and docker node update --availability drain perform on a Swarm node: rolling restarts in batches with the source's parallelism, delay, order, failure action and monitor window, image versions under a systemd.v directory, credential and configuration rotation, drain and activate. Use this whenever the user asks how to deploy a new image, roll a stack forward or back, take a host out of service or put it back, scale a service, rotate a secret or a config on a migrated host, or what happened to update_config, rollback_config, and node availability.
---

# systemd rollout

Swarm rolls a service over for you: `docker service update --image` restarts tasks in batches, watches them for `update_config.monitor`, and applies `failure_action` when a batch does not come up. systemd restarts a unit, and stops there. This component supplies the part in between: a description of how each service is allowed to change over, rendered from the source's own `update_config` and `rollback_config`, and one controller per host that reads it.

Nothing about the estate is built into the controller. Unit names, socket names, credential names, configuration names, image paths, batch sizes, delays, orders, failure actions and monitor windows all come from `/etc/systemd-migration/rollout/<stack>.conf`, which the renderer writes from the plan and from `expected.json`. A service the plan does not place on a host has no section on that host, and a verb aimed at it says so rather than guessing.

## What is rendered

Per host, one specification per stack the host runs:

```
/etc/systemd-migration/rollout/<stack>.conf
```

and one controller, installed by `install.sh` with mode 0755 (the rendered tree's `etc/` is copied wholesale, everything outside it is installed by name):

```
/usr/local/lib/systemd-migration/stackctl
```

`references/rollout-spec.md` documents every key. The short version: a `[Rollout]` section naming the stack, the host, the estate's monitor window, the state directory, the credential import script and whether configurations ship as files or as a confext; then one `[Service NAME]` section per service with instances on this host, carrying `Units=`, `Health=`, `Sockets=`, `Credentials=`, `Configs=`, `Parallelism=`, `Delay=`, `Order=`, `FailureAction=`, `Monitor=`, `MaxFailureRatio=`, `Image=` and `Form=`. The sections are in rollout order: `deploy` and `activate` walk them from the top, `drain` from the bottom. Reordering the sections reorders the walk and nothing else.

## Decisions

Three decisions reach `plan.yaml`. The first two are raised for every service whose source described an update or a rollback, or that has more than one replica:

| Decision | Options | Default |
|---|---|---|
| `rollout.order.<service>` | `start-first`, `stop-first` | `update_config.order` when the source named one, else `stop-first` |
| `rollout.failure.<service>` | `pause`, `continue`, `rollback` | `update_config.failure_action` when the source named one, else `pause` |
| `rollout.monitor.estate` | a `systemd.time(7)` span | the longest `monitor` any service's `update_config` names, else `30s` |

`parallelism`, `delay` and `max_failure_ratio` are not decisions: they come straight from the source into the specification, and a service whose source described no update gets `Parallelism=1`, `Delay=0s` and `MaxFailureRatio=0` with a note saying so. `MaxFailureRatio=` is recorded for the operator; the controller does not act on it, because a batch that does not come back is a failure whatever fraction of the service it is.

## The verbs

```bash
stackctl status <stack>
stackctl deploy <stack> [--image NAME=REF]...
stackctl rollback <stack> [<service>]
stackctl drain <host>
stackctl activate <host>
stackctl scale <service> <n>
stackctl rotate credential <name>
stackctl rotate config <name>
```

Every verb takes `--dry-run`, which prints the commands that would change something and runs only the queries. Every command that changes something is printed with a leading `+ ` whether or not it runs, so a dry run and a real run print the same sequence and the output of a real run is an audit trail.

**deploy** stages the images named by `--image NAME=REF` (below), then walks the specification's services from the top. Each service's instances are taken in batches of `Parallelism`, `Delay` is waited between batches, and each batch is watched for `Monitor`: every unit in it must stay `active` and, where the service has one, its health unit must keep reporting `Result=success`. The wait is bounded by systemd rather than by the script, through a transient `systemd-run --wait -p RuntimeMaxSec=` service, so a health unit that never returns cannot hang a deploy. A batch that does not come back applies `FailureAction`.

**rollback** puts back the image target the last deploy replaced, recorded under `/var/lib/systemd-migration/rollout/`, and walks the service through the same batches. Without a recorded previous target it says so and restarts the instances on whatever the image path now selects. A rollback never rolls back further: a batch that fails during one stops the walk.

**drain** and **activate** are `docker node update --availability drain` and `active` for this host. Drain stops the socket units first, so nothing new arrives, then the instances, walking the services from the bottom of each specification and the specifications in reverse; activate is the exact mirror. The socket names come from the `Sockets=` line, which the renderer fills from two places: the sockets `expected.json` records for the host's instances (socket activation and `reuseport`), and the `systemd-socket-proxyd` sockets the networkd component publishes under `networkd:proxies`, which also front the backends on other hosts. A host whose render carries no proxy table gets a note saying the line covers the local sockets only.

**scale** starts the first N of the rendered instances and stops the rest. It never invents an instance: N above the number of instances the plan rendered on this host is a re-render, and the controller says which decision to change (`placement.hosts.<service>`, and `placement.scale_out.estate` for more than one instance on a host).

**rotate credential** re-runs the rendered `import-credentials.sh`, which re-encrypts every credential from the values under `/etc/swarm-migration/secrets/`, then restarts the services whose `Credentials=` names the credential, in rollout order and in their own batches. **rotate config** refreshes a confext with `systemd-confext refresh` when the stack ships its configuration that way, or points at the file under `/etc/<stack>/configs/` when it does not, then restarts the consumers the same way.

**status** prints, per service, its form, order, failure action and parallelism, the image path with the version it currently selects, and per instance the unit's state and its last health result.

## Image versions

The unit's `RootMStack=` or `RootImage=` never changes. The versions live in the `systemd.v(7)` directory next to it and the path itself is the symlink that selects one:

```
/var/lib/machines/acme-app_2026.09.mstack            -> .v/acme-app_2026.09_2026.10.mstack
/var/lib/machines/acme-app_2026.09.mstack.v/
    acme-app_2026.09_2026.09.mstack
    acme-app_2026.09_2026.10.mstack
```

`systemd.v(7)` matches `NAME_*.SUFFIX` inside `NAME.SUFFIX.v/`, so the entries are variants of the name the renderer gave the image, version and all. `deploy --image NAME=REF` writes a one-entry `images.json` under `/run/systemd-migration/`, hands it to the machined skill's `pull-images.sh` (at `/usr/local/lib/systemd-migration/pull-images.sh`, or `SYSTEMD_MIGRATION_PULL_SCRIPT`), moves the result into the `.v/` directory, records the symlink's old target, and swaps the symlink through a temporary name so no unit ever sees a half-written path. An image path that is a real directory rather than a symlink is left alone with an explanation: the operator moves it into the `.v/` directory once, and versions are swappable from then on. A host with no pull script is told which reference to pull by hand.

An operator who would rather have systemd pick the newest version itself can point the unit at the `.v/` directory instead (`RootMStack=/var/lib/machines/acme-app_2026.09.mstack.v/`); that is a re-render of the image path, not something the controller does.

## What needs a re-render

The controller changes state, never the shape of the estate. These are decisions in `plan.yaml` followed by `render.ts` and `install.sh`:

- more instances of a service on a host than the plan rendered (`placement.hosts.<service>`, `placement.scale_out.estate`)
- a service on a host that does not run it, or a stack that is not installed there
- a different order, failure action or monitor window than the specification carries (`rollout.order.<service>`, `rollout.failure.<service>`, `rollout.monitor.estate`)
- a different published port, publish mode or ingress decision, which is what determines the socket units drain stops
- a new credential, configuration, volume or network

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the verb finished; for deploy and rollback every batch came back active and healthy within its monitor window |
| 1 | a batch did not come back and `FailureAction` was applied, or a verb could not finish what it started |
| 2 | usage: an unknown verb, a missing or malformed argument, a stack or service this host does not run, a scale beyond the rendered instances |
| 3 | the rollout specification is missing or malformed, with the file and line |
| 4 | something the specification names is not on this host: the credential import script, `systemd-confext`, the image pull script |

## Files

- `scripts/component.ts`: the decisions and the rendering.
- `scripts/stackctl`: the controller, installed per host. POSIX sh, `set -eu`, no Bun and no Python; it calls `systemctl`, `systemd-run`, `journalctl`, `machinectl`, `systemd-confext` (only for a confext stack), the credential import script and the image pull script.
- `references/rollout-spec.md`: every key of the specification, and what the controller does with it.
- `references/runbook.md`: `docker service update`, `docker stack deploy`, `docker service rollback`, `docker service scale` and `docker node update --availability drain` mapped onto the verbs.
