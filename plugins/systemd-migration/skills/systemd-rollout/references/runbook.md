# From Swarm commands to the controller

Every line below is what an operator used to type on a manager, and what the
same intent is on a migrated host. The controller acts on one host, so a
command a manager ran once for the cluster becomes the same command on each
host that runs the service, in the order the plan's cutover runbook names.
Run each of them with `--dry-run` first: it prints exactly the commands the
real run will print, and changes nothing.

`stackctl` is `/usr/local/lib/systemd-migration/stackctl`.

## Deploying a new image

```bash
# Swarm
docker service update --image registry.example.com/acme/app:2026.10 web_app

# systemd, on each host that runs web_app
stackctl deploy web --image acme-app_2026.09=registry.example.com/acme/app:2026.10 --dry-run
stackctl deploy web --image acme-app_2026.09=registry.example.com/acme/app:2026.10
```

`NAME` is the local image name, the one in `images.json` and in the unit's
`RootMStack=`, not the service name: one image can be the root of several
services, and the specification says which services use it. The batching,
delay, order, failure action and monitor window come from the specification,
so `--update-parallelism`, `--update-delay`, `--update-order`,
`--update-failure-action` and `--update-monitor` have no equivalent on the
command line. Changing one of them is a decision in `plan.yaml`
(`rollout.order.<service>`, `rollout.failure.<service>`,
`rollout.monitor.estate`) or a value the source carried, followed by a
re-render.

## Re-applying a stack

```bash
# Swarm
docker stack deploy -c web.yml web

# systemd, on each host in the stack
bash hosts/<host>/install.sh          # the shape of the estate
stackctl deploy web                   # the rolling restart
```

The two halves of `docker stack deploy` are separate here on purpose.
`install.sh` puts the current render in place and reloads the manager; it does
not restart anything. `stackctl deploy` rolls the services over in the
specification's batches. A change that alters the shape of the estate (a new
service, a new port, a new credential) is a re-render and an `install.sh`; a
change that only swaps an image is a `deploy --image`.

## Rolling back

```bash
# Swarm
docker service rollback web_app

# systemd
stackctl rollback web web_app        # one service
stackctl rollback web                # every service in the stack
```

The image target the last deploy replaced is recorded under
`/var/lib/systemd-migration/rollout/`. A rollback puts it back and walks the
service through the same batches with the same order. It is also what
`FailureAction=rollback` does on its own when a batch does not come back, which
is the equivalent of Swarm's `--update-failure-action rollback`.

## Draining a node

```bash
# Swarm, from a manager
docker node update --availability drain wrk-1
docker node update --availability active wrk-1

# systemd, on that host
stackctl drain swarm-wrk-1 --dry-run
stackctl drain swarm-wrk-1
stackctl activate swarm-wrk-1
```

Swarm reschedules the drained node's tasks elsewhere. Nothing reschedules
here: the instances the plan placed on this host stop, and the capacity is gone
until another host is scaled up or the host is activated again. Plan the drain
against the placement: a service whose only instance is on the host being
drained is a stack outage, and the plan should say which host takes it over
first. The socket units go down before the instances, so a `socket-proxyd` or
socket-activated backend stops accepting connections before the process behind
it stops.

## Scaling

```bash
# Swarm
docker service scale web_app=3

# systemd, on the host
stackctl scale web_app 1     # within the instances the plan rendered here
```

`scale` starts or stops instances that already exist as units. A count above
the instances the plan rendered on the host is a re-render:
`placement.hosts.<service>` decides which hosts run a service and how many
instances each one gets, and `placement.scale_out.estate` decides whether more
than one instance may share a host. Change the decision, re-render, install,
then scale.

## Rotating a secret or a config

```bash
# Swarm: a secret is immutable, so a rotation is a new secret and an update
docker secret create web_app_signing_key_v2 ./key
docker service update --secret-rm web_app_signing_key \
    --secret-add source=web_app_signing_key_v2,target=signing_key web_app

# systemd: the credential keeps its name and its value is replaced
install -m 0600 ./key /etc/swarm-migration/secrets/web_app_signing_key
stackctl rotate credential web_app_signing_key
```

The rotation re-runs the rendered `import-credentials.sh`, which re-encrypts
every credential from the values under `/etc/swarm-migration/secrets/`, then
restarts the services whose `Credentials=` names that credential, in rollout
order and in their own batches. A configuration is the same shape:

```bash
# Swarm
docker config create web_app_nginx_v2 ./nginx.conf
docker service update --config-rm ... --config-add ... web_app

# systemd, when the stack ships configs as files
install -m 0644 ./nginx.conf /etc/web/configs/web_app_nginx
stackctl rotate config web_app_nginx

# systemd, when the stack ships configs as a confext
# (replace the confext image, then)
stackctl rotate config web_app_nginx      # runs systemd-confext refresh first
```

## Watching

```bash
# Swarm
docker service ps web_app
docker service inspect web_app --format '{{.UpdateStatus.State}}'

# systemd
stackctl status web
systemctl list-units 'web*'
journalctl -u web_app.service --since -10m
```

`status` prints each service's order, failure action and parallelism, the
image path with the version it currently selects, and per instance the unit's
state and its last health result. There is no cluster-wide update status,
because there is no cluster: the deploy's own output, printed command by
command, is the record, and the controller's exit code is the verdict.
