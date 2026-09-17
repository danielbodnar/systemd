# Inventory field notes

Every inventory field is derived from a documented Docker API object. This file records the source of each one and the conversion applied, so a surprising value can be traced back to the raw capture rather than argued about.

## Sources

| Inventory field | Raw file | Docker path |
|---|---|---|
| `cluster.engine_version` | `info.json` | `ServerVersion` |
| `cluster.managers`, `cluster.workers` | `info.json` | `Swarm.Managers`, `Swarm.Nodes` (workers are nodes minus managers) |
| `nodes[]` | `nodes.json` | `docker node inspect`: `Spec.Role`, `Spec.Availability`, `Spec.Labels`, `Description.Hostname`, `Description.Engine.Labels`, `Description.Platform`, `Description.Resources`, `ManagerStatus.Leader`, `Status.Addr` |
| `stacks[]` | derived | grouped from the `com.docker.stack.namespace` label on each service |
| `services[]` | `services.json` | `docker service inspect`: `Spec`, `Spec.TaskTemplate.ContainerSpec`, `Spec.TaskTemplate.Placement`, `Spec.TaskTemplate.Resources`, `Spec.TaskTemplate.RestartPolicy`, `Spec.UpdateConfig`, `Spec.RollbackConfig`, `Endpoint.Spec.Ports` |
| `services[].tasks[]` | `tasks.jsonl` | `docker service ps --no-trunc --format json`: `Node`, `DesiredState`, `CurrentState`, `Error`; historical task rows (names prefixed `\_`) are dropped |
| `networks[]` | `networks.json` | `docker network inspect`: `Driver`, `Scope`, `Ingress`, `Internal`, `Attachable`, `EnableIPv6`, `IPAM`, `Options`, `Labels` |
| `volumes[]` | `volumes.json` | `docker volume inspect`: `Driver`, `Scope`, `Mountpoint`, `Options`, `Labels` |
| `secrets[]` | `secrets.json` | `docker secret inspect`: `Spec.Name`, `Spec.Labels`, `CreatedAt`; values are not exposed by the API |
| `configs[]` | `configs.json` | `docker config inspect`: `Spec.Name`, `Spec.Labels`, `Spec.Data` (base64) |

## Conversions

**Durations.** Docker stores durations as int64 nanoseconds. The normalizer converts them to systemd-style strings (`30s`, `1m30s`, `500ms`) because those strings are valid on both `systemd.unit` timeouts and Quadlet `Health*` keys, which means the renderer can copy them without a second conversion.

**Environment redaction.** Redaction happens twice. `capture.sh` redacts values whose key matches password, pass, pwd, secret, token, api key, private key, credential, or auth before the raw file is written, and drops `PreviousSpec`, so the archived capture does not hold them (`--keep-env` retains everything and is a deliberate choice). The normalizer applies the same key test and additionally a value test for URI userinfo with a password (`scheme://user:pass`) and `password=`-style pairs inside a value; matches become `<redacted>` and are listed in `redacted_env`. `--keep-env-values` on the normalizer only keeps what the capture kept.

**Image references.** `image@sha256:...` is split into `image` and `image_digest`. A missing digest raises a warning because the migrated host will resolve the tag independently and may run a different build than the swarm did.

**Volumes are node-local.** `docker volume ls` on the capturing manager lists that node's volumes only. A service mount that names a volume absent from the capture produces a warning naming the nodes that run the service; capture there, or inspect the volume by hand, before planning storage.

**Service names.** `name` is the full Swarm name (`stack_service`); `short_name` strips the stack prefix. Quadlet units are named from the full name so two stacks with a `db` service do not collide.

**Mode and replicas.** `Spec.Mode` is a one-key object; the key is lowered to `replicated`, `global`, `replicated-job`, or `global-job`. `replicas` is `Replicated.Replicas` for replicated services and `TotalCompletions` for replicated jobs.

**Privileged.** Swarm has no single privileged flag. The normalizer marks a service privileged when `CapabilityAdd` includes `ALL` and no-new-privileges is disabled; review `cap_add` directly when the answer matters.

**Ports.** `Endpoint.Spec.Ports` is preferred over `Spec.EndpointSpec.Ports` because it reflects the resolved state, including dynamically assigned published ports (published `null` in the spec becomes a concrete number in the endpoint).

## Warnings

The normalizer appends to `warnings[]` for: unpinned images, tasks whose current state differs from a running desired state, services published through the ingress mesh, and encrypted overlay networks. Warnings are informational; the inventory is still written.
