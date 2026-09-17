<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# systemd-migration

One plugin for moving container orchestration onto systemd-native infrastructure. It is organized around systemd, not around the technology being migrated: docker and podman are adapters that discover an estate into a common inventory, and the work of expressing that estate on systemd is split into one skill per systemd component so the pieces compose. A multi-node Docker Swarm is the first and primary use case because it exercises nearly every component; Podman follows on the same contract.

## How a migration runs

```
/migrate-discover     adapter: capture the estate into inventory.json, probe the target hosts into hosts/*.json
/migrate-plan         planner: write plan.yaml (every decision with its options), then review it with you
/migrate-render       driver: compose the components the plan selected into per-host trees
/migrate-verify       verifier: systemd-analyze and live checks against expected.json
```

Nothing in the plan is assumed. Address ranges, overlay transports, load-balancing methods, which service becomes a plain service, a machine, or a VM, and where each secret is stored are decisions the planner lists with options and evidence, and rendering refuses to run while any of them is unresolved.

## Layout

| Directory | Holds |
|---|---|
| `contract/` | The inventory schema, the directive catalogue generated from `man/`, the unit builder, the component interface, the plan schema, and the component registry (`contract/README.md`) |
| `skills/discover-*` | Adapters: `discover-docker-swarm` (capture and normalize a Swarm), `discover-systemd-hosts` (probe what each target host's systemd can do), `discover-podman` (capture and normalize a Podman host, pods and existing Quadlet files included) |
| `skills/migration-planner` | The translation map, `plan.yaml`, and the guided review |
| `skills/systemd-*` | One skill per systemd component; each ships `scripts/component.ts` and the references that explain the mapping |
| `skills/podman-quadlet` | The Podman adapter target: everything the Quadlet renderer did before, selectable per service by the plan |
| `skills/systemd-verify` | Dry-run and live verification on a host |
| `scripts/` | The drivers: `plan.ts`, `review.ts`, `render.ts` |
| `agents/`, `commands/` | Subagents and slash commands that run the skills from a project directory |
| `harness/` | The Managed Agents harness that runs the same skills unattended on production hosts (`harness/README.md`) |

## Components

| Skill | systemd component | Renders |
|---|---|---|
| `systemd-service` | `systemd.service(5)`, `systemd.exec(5)` | services with `RootMStack=` or `RootImage=`, stack targets, health timers, install scripts |
| `systemd-machined` | `systemd-nspawn(1)`, `systemd-vmspawn(1)`, `importctl(1)`, `systemd.mstack(7)` | image pulls, mount stacks, DDIs, `.nspawn` files, machines, VMs |
| `systemd-networkd` | `systemd.network(5)`, `systemd.netdev(5)`, `systemd.socket(5)` | zone bridges with address plans, overlays (vxlan, WireGuard), macvlan, sockets and port policy |
| `systemd-resolved` | `resolved.conf(5)`, `systemd.dnssd(5)` | resolver settings, service discovery |
| `systemd-resource-control` | `systemd.resource-control(5)`, `systemd.slice(5)` | slices, quotas, limits, accounting |
| `systemd-creds` | `systemd-creds(1)`, `systemd.exec(5)` credentials | encrypted credentials, import scripts, `LoadCredentialEncrypted=` |
| `systemd-journald` | `journald.conf(5)`, `systemd.exec(5)` logging | log fields, identifiers, namespaces |
| `systemd-storage` | `systemd.mount(5)`, `tmpfiles.d(5)`, `repart.d(5)`, `sysusers.d(5)` | mounts, directories, partitions, users |
| `systemd-sysext` | `systemd-sysext(8)` | system and configuration extensions |
| `systemd-portable` | `portablectl(1)`, `capsule@.service(5)` | portable services, capsules |
| `systemd-generator` | `systemd.generator(7)`, `systemd.preset(5)` | the stack description under `/etc/systemd-migration/stacks.d/` and the generator that turns it into stack targets and slices at boot, the preset file that decides the enable state |
| `systemd-rollout` | `systemctl(1)`, `systemd-run(1)`, `systemd.v(7)` | the rollout specification under `/etc/systemd-migration/rollout/` and the `stackctl` controller that deploys, rolls back, drains, scales, and rotates |

## Installing

```
/plugin marketplace add danielbodnar/systemd
/plugin install systemd-migration@systemd-dev-plugins
```

`PLAN.md` in the parent directory records the design and its status.
