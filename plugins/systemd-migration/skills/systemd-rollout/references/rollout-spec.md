# The rollout specification

One file per stack per host, written by the rollout component into the
rendered tree at `etc/systemd-migration/rollout/<stack>.conf` and installed to
`/etc/systemd-migration/rollout/<stack>.conf` by `install.sh`. It is the only
thing `stackctl` knows about the estate.

The format is the ini-like shape systemd uses: `#` and `;` comments, blank
lines ignored, `[Section]` headers, `Key=Value` assignments, leading and
trailing blanks stripped from both sides. `Units=`, `Health=`, `Sockets=`,
`Credentials=` and `Configs=` are space-separated lists and follow
`systemd.unit(5)` list semantics, so a repeated assignment appends. Every
other key is a plain value and the last assignment wins.

`stackctl` validates the whole file before it acts on it and refuses with exit
code 3 and the offending line when a line is not a comment, a section header
or an assignment, when an assignment appears before any section, when a
section is neither `[Rollout]` nor `[Service NAME]`, when a `[Service NAME]`
section has no `Units=`, when `Order=`, `FailureAction=` or `Parallelism=`
carries a value it does not know, when `Delay=` or `Monitor=` is not a time
span, or when the `[Rollout]` section has no `Stack=` or no `Host=`.

## `[Rollout]`

| Key | Meaning |
|---|---|
| `Stack=` | the stack this file describes; also the file's name |
| `Host=` | the host the tree was rendered for. `drain` and `activate` refuse any other name, because this controller acts on one host and makes no remote calls |
| `Monitor=` | the estate's monitor window (`rollout.monitor.estate`), used by a service whose source named none |
| `StateDirectory=` | where a deploy records the image target it replaced, so a rollback has something to go back to (default `/var/lib/systemd-migration/rollout`) |
| `CredentialScript=` | the rendered `import-credentials.sh` as `install.sh` placed it; `rotate credential` re-runs it |
| `ConfigForm=` | `files` or `confext`, from `sysext.configs.<stack>`; `rotate config` refreshes a confext and otherwise names the file to replace |

## `[Service NAME]`

One section per service with instances on this host, in rollout order.
`deploy` and `activate` walk them from the top, `drain` from the bottom.
Reordering the sections reorders the walk; nothing else in the file depends on
their order, so an operator who knows that one service must come up before
another may move its section and re-run, and should record the same order in
the plan's runbook.

| Key | Source | What the controller does with it |
|---|---|---|
| `Units=` | the instances the plan placed here, in instance order | the units a batch is taken from; also what `drain`, `activate` and `scale` start and stop |
| `Health=` | the `<base>-health.service` units the service component rendered | during the monitor window the health unit of each instance must report `Result=success`. The health unit of an instance is `<base>-health.service`, where the base of `systemd-nspawn@NAME.service` is `NAME`; a service without a healthcheck has an empty list and only the unit's own state is watched |
| `Sockets=` | the socket units `expected.json` records for the instances, plus the `systemd-socket-proxyd` sockets the networkd component publishes for the service under `networkd:proxies` | stopped before the instances on `drain`, started after them on `activate`. The proxy sockets front the backends on other hosts too, so closing them is what stops this host taking traffic for the service |
| `Credentials=` | the credential names the units load on this host | `rotate credential NAME` restarts the services whose list contains `NAME` |
| `Configs=` | the configuration names the service mounts | `rotate config NAME` restarts the services whose list contains `NAME` |
| `Parallelism=` | `update_config.parallelism`, else `1` | how many instances change over at once |
| `Delay=` | `update_config.delay`, else `0s` | waited between batches, not after the last one |
| `Order=` | `rollout.order.<service>` | see below |
| `FailureAction=` | `rollout.failure.<service>` | `pause` stops the walk, `continue` goes on to the next batch, `rollback` restores the previous image target and walks the service back. Every one of them still ends the verb with exit code 1 |
| `Monitor=` | `update_config.monitor`, else `[Rollout] Monitor=` | how long a batch is watched |
| `MaxFailureRatio=` | `update_config.max_failure_ratio`, else `0` | recorded for the operator. The controller does not act on it: a batch that does not come back is a failure whatever fraction of the service it is |
| `Image=` | the root the machined component gave the instance (`RootMStack=` or `RootImage=`), or the machine's root directive | what `deploy --image` versions and `rollback` puts back; `status` prints it with the version it selects |
| `Form=` | `form.service.<name>` | `status` adds the machine's state from `machinectl` for a `machine` |

## `Order=`

systemd restarts a unit in place, so the two orders differ in what is
guaranteed about the instances outside the batch.

`stop-first` stops the batch and starts it again: `systemctl stop UNITS` then
`systemctl start UNITS`. The batch's capacity is gone in between. This is the
only order a service with one instance on the host can have, and it is the
default for a service whose source named none.

`start-first` confirms with `systemctl is-active` that every instance outside
the batch is active, and only then restarts the batch:
`systemctl restart UNITS`. Capacity never drops below the instance count minus
the parallelism. When an instance outside the batch is not active the
controller says so and the deploy fails rather than taking the service down
further. A service whose instance count on this host is not greater than its
parallelism cannot hold capacity; the controller says so and proceeds as
`stop-first`.

## An example

```ini
[Rollout]
Stack=web
Host=swarm-wrk-1
Monitor=30s
StateDirectory=/var/lib/systemd-migration/rollout
CredentialScript=/usr/local/lib/systemd-migration/import-credentials.sh
ConfigForm=files

[Service web_app]
Units=web_app-1.service web_app-2.service
Health=web_app-1-health.service web_app-2-health.service
Sockets=
Credentials=web_app-app-secret-key web_app_signing_key
Configs=
Parallelism=1
Delay=10s
Order=start-first
FailureAction=rollback
Monitor=30s
MaxFailureRatio=0
Image=/var/lib/machines/acme-app_2026.09.mstack
Form=service
```

`stackctl deploy web --dry-run` on that file prints:

```
+ systemctl restart web_app-1.service
+ systemd-run --quiet --wait --collect -p RuntimeMaxSec=30s --description=stackctl-monitor /usr/local/lib/systemd-migration/stackctl monitor-batch 30 web_app-1-health.service web_app-2-health.service web_app-1.service
+ sleep 10
+ systemctl restart web_app-2.service
+ systemd-run --quiet --wait --collect -p RuntimeMaxSec=30s --description=stackctl-monitor /usr/local/lib/systemd-migration/stackctl monitor-batch 30 web_app-1-health.service web_app-2-health.service web_app-2.service
```

`monitor-batch` is the controller's own internal verb: the poll that watches a
batch, run as a transient service so `RuntimeMaxSec=` ends it at the monitor
deadline. A lone `-` in its second argument is an empty health list. On a host
without `systemd-run` the same poll runs in the controller and counts the
seconds itself.
