---
title: Migrating Containers to systemd
category: Manuals and Documentation for Users and Administrators
layout: default
SPDX-License-Identifier: LGPL-2.1-or-later
---

# Migrating Containers to systemd

This page maps the concepts of a container orchestrator (Docker, Docker Swarm, Compose) onto the primitives systemd ships, for an operator moving workloads off an orchestrator and onto hosts that systemd manages directly. It is written from the perspective of the tooling under `plugins/` in the source tree, which captures an estate into an inventory and renders it into units, but the map itself is independent of that tooling: every row names the directives and tools involved, so it can be followed by hand.

The map is generated in machine-readable form for each estate by the planner (`plugins/systemd-migration/skills/migration-planner/`), which also checks every directive it names against the man pages of this tree, and the decisions it leaves open (which form each service takes, address ranges, overlay transports, published ports, name resolution, secret stores, data moves) are written to a `plan.yaml` the operator reviews before anything is rendered. What follows is the same map in prose.

## Targets

systemd offers several ways to run something that used to be a container. The right one depends on what the image contains and how much isolation the workload needs.

| Target | What it is | When to choose it |
|---|---|---|
| Plain service | A unit whose root directory is the image, mounted from a mount stack (`RootMStack=`, see [systemd.mstack(7)](https://www.freedesktop.org/software/systemd/man/systemd.mstack.html)) or from a disk image (`RootImage=`), sandboxed with the directives of [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/systemd.exec.html). | An application image that runs one process tree and does not need its own PID 1. The default. |
| Machine | A container run by [systemd-nspawn(1)](https://www.freedesktop.org/software/systemd/man/systemd-nspawn.html) from the same mount stack, described by a `.nspawn` file and managed with `machinectl`. | An image that ships an init system, or a workload that needs its own network namespace with an address on a bridge, macvlan, or ipvlan link. |
| Portable service | An image under `/var/lib/portables/` attached with `portablectl`, which copies its units onto the host with a security profile. | A service that should be installable and removable as one artifact on many hosts. See [Portable Services](/PORTABLE_SERVICES). |
| Capsule | A per-stack user manager started by `capsule@.service`, running the stack's services as user units. | A stack that should be managed as one unit of isolation with its own manager, without a full machine. |
| System or configuration extension | A `/usr/` overlay merged by `systemd-sysext`, or an `/etc/` overlay merged by `systemd-confext`. | An image whose payload is a pure `/usr/` tree (rare for application images), and the configuration files of a stack respectively. |
| Virtual machine | A bootable disk image run by [systemd-vmspawn(1)](https://www.freedesktop.org/software/systemd/man/systemd-vmspawn.html). | A workload that needs a separate kernel. |
| Quadlet | A Podman container described by a `.container` file that Podman's generator turns into a unit. | When Podman is the runtime of choice; the rest of the map still applies to the unit sections of the file. |

## Images

`importctl pull-oci` (since version 260) downloads an OCI image from a registry into the image directory of a class (`machine`, `portable`, `sysext`, `confext`) as a mount stack: a directory `NAME.mstack/` with one `layer@N` symlink per image layer and, unless the image is imported read-only, a writable `rw/` layer. `systemd-nspawn --mstack=` and `RootMStack=` in a service consume it directly. The writable layer needs a kernel with overlayfs `FSCONFIG_SET_FD` support (6.13 or later). Several versions of an image live side by side under `NAME.raw.v/` following [systemd.v(7)](https://www.freedesktop.org/software/systemd/man/systemd.v.html), which is what makes a rollback a matter of picking the previous name.

The OCI image configuration (entrypoint, command, environment, working directory, user) is not preserved by the import. It has to be carried into the unit: `ExecStart=`, `Environment=`, `WorkingDirectory=`, and `User=` for a service, or `Parameters=`, `Environment=`, `WorkingDirectory=`, and `User=` in the `[Exec]` section of a `.nspawn` file. A capture of a running orchestrator has all of it in the service specification.

On hosts older than version 260, the merged tree is packed into a discoverable disk image with `systemd-repart --make-ddi=` and mounted with `RootImage=`.

## Services, stacks, replicas, placement

A container becomes a service running in the image's tree with the host kernel and systemd's sandboxing: `RootMStack=`, `MountAPIVFS=yes`, `PrivateDevices=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, and `PrivateUsers=self` for an unprivileged user namespace. As a machine, `ProcessTwo=yes` keeps a stub init as PID 1 the way `docker run --init` does, and `PrivateUsers=pick` maps the machine to an unprivileged range.

A stack becomes a target (`stack.target` wanting every unit of the stack) and a slice (`stack-NAME.slice` grouping their control groups, with the stack's resource limits on it). Replicas become instances of a template unit, one per replica per host; `mode: global` becomes one instance on every eligible host. The scheduling decision the orchestrator made across the cluster becomes a host assignment written down in the migration plan, guarded on each host with `ConditionHost=`. Node labels are recorded in `/etc/machine-info` as `DEPLOYMENT=` and `LOCATION=`.

## Lifecycle

| Orchestrator setting | systemd |
|---|---|
| restart policy, delay, attempts, window | `Restart=`, `RestartSec=`, `RestartSteps=`, `RestartMaxDelaySec=`, `StartLimitBurst=`, `StartLimitIntervalSec=` |
| stop grace period, stop signal | `TimeoutStopSec=`, `KillSignal=`, `KillMode=mixed` |
| healthcheck | a timer (`NAME-health.timer`) running the check at the interval with the timeout, whose `OnFailure=` restarts the service after the retries; an application that speaks `sd_notify(3)` uses `WatchdogSec=` instead, and the start period becomes `TimeoutStartSec=` with `Type=notify` |
| update and rollback configuration | a runbook step: instances restart in batches of the configured parallelism with the configured delay, and a rollback picks the previous image version by name |
| logging driver | the journal, with the stack and service as extra fields (`LogExtraFields=`) and `SyslogIdentifier=`; for a machine, `LinkJournal=try-guest` |

## Resources and security

Resource limits and reservations map onto the control group properties of [systemd.resource-control(5)](https://www.freedesktop.org/software/systemd/man/systemd.resource-control.html): `CPUQuota=`, `CPUWeight=`, `AllowedCPUs=`, `MemoryMax=`, `MemoryLow=`, `TasksMax=`, `IOWeight=`. For a machine the same properties are set with `--property=` on `systemd-nspawn`. ulimits become the matching `Limit*=` directives; a sysctl is a host setting and becomes a `sysctl.d(5)` fragment, or applies inside a machine's own namespace where the key allows.

Added and dropped capabilities become `CapabilityBoundingSet=` and `AmbientCapabilities=` (`Capability=` and `DropCapability=` in a `.nspawn` file), with `NoNewPrivileges=`, `SystemCallFilter=`, and where used `AppArmorProfile=` or `SELinuxContext=`. A privileged container has no equivalent and should not get one: the migration asks which capabilities the workload uses. Devices become `DeviceAllow=` under `DevicePolicy=closed`, and for a machine additionally a `Bind=` of the device node.

## Secrets, configs, environment

Secrets become credentials. Each value is encrypted with `systemd-creds encrypt` on the host and loaded with `LoadCredentialEncrypted=name:/etc/credstore.encrypted/name`; the process reads it under `$CREDENTIALS_DIRECTORY`. A machine receives it with `--load-credential=` and finds it under `/run/host/credentials/`. Values never appear in a unit file or a rendered tree. See [Credentials](/CREDENTIALS).

Configuration files are written to `/etc/STACK/NAME` with their recorded ownership and mode and bound read-only at the target path with `BindReadOnlyPaths=`, or all of a stack's configuration files become one configuration extension image merged into `/etc/` by `systemd-confext`. Plain environment values become `Environment=`; a long environment goes to an `EnvironmentFile=` with mode 0600; a value that looks like a credential becomes a credential.

## Networking

There is no routing mesh on a host. A port published through the mesh has to be published in host mode on every host that runs the service, forwarded into one machine with `Port=` in the `[Network]` section of a `.nspawn` file, or fronted by a load balancer or proxy that the migration plan names. A port published in host mode is bound by the service itself, and `SocketBindAllow=` and `SocketBindDeny=any` enforce the declared set; a service that accepts an inherited socket gets a `.socket` unit and starts on demand.

An overlay network confined to one host becomes a bridge. Machines join it with `Zone=` in their `.nspawn` file; the shipped `80-container-vz.network` configures such `vz-*` bridges with a DHCP server, and a drop-in replaces its default `0.0.0.0/24` with the network's IPAM subnet. Fixed addresses become `[DHCPServerStaticLease]` entries. An overlay that spans hosts additionally gets a `vxlan` netdev per network, bridged into the zone bridge on each host; an encrypted overlay puts the vxlan on a `wireguard` netdev between the hosts, whose keys are credentials. A macvlan or ipvlan network becomes `MACVLAN=` or `IPVLAN=` on the parent link for a machine, configured inside the machine by `80-container-mv.network` and `80-container-iv.network`, or a `macvlan` netdev in bridge mode for a service. Host networking is `Private=no`.

Names resolve through the zone bridge's leases, `MulticastDNS=` and `LLMNR=` on the link, and `.dnssd` files for services that should be discoverable; the estate's search domain goes to a `resolved.conf.d/` fragment. A virtual IP shared by replicas becomes one address per host, which the plan must front.

## Storage

A named volume with the local driver becomes a directory `/var/lib/STACK/VOLUME/` created by a `tmpfiles.d(5)` `d` line with the owner the service runs as, bound with `BindPaths=` (`Bind=` for a machine); a service with `DynamicUser=` uses `StateDirectory=` instead. A volume with a network driver (NFS, CIFS) becomes a `.mount` unit built from the driver options, an `.automount` when idle unmount is wanted, and `RequiresMountsFor=` on every consumer. Bind mounts keep their source path and read-only flag through `BindPaths=` and `BindReadOnlyPaths=`; a tmpfs with a size becomes `TemporaryFileSystem=/path:size=`. On a freshly provisioned host, a `repart.d(5)` definition can create the data partition at first boot.

## Compose settings

`depends_on` becomes `After=` plus `Wants=` (`Requires=` for `service_started`, and an `After=` on the health service for `service_healthy`); a profile becomes a target. `init`, `read_only`, `pid`, `ipc`, `extra_hosts`, and `dns` become `ProcessTwo=`, `ProtectSystem=strict` or `ReadOnly=`, `PrivatePIDs=`, `PrivateIPC=`, a bound `/etc/hosts`, and per-link `DNS=` or a bound `resolv.conf`.

## What has no equivalent

Manager nodes, quorum, and node drain have no counterpart: there is no cluster manager. The migration plan covers node roles, maintenance with `systemctl isolate`, and `machinectl` for the machines on each host. Rolling updates with automatic rollback on failure are a runbook procedure rather than a directive. A routing mesh and virtual IPs are replaced by the choices above, and the choice is the migration.
