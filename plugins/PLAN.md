<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# systemd-dev-plugins: moving container estates onto systemd primitives

This document plans and records the migration tooling that lives under
`plugins/`: one plugin, `systemd-migration`, organized around systemd's own
components rather than around the technology being migrated. Docker Swarm and
Podman are adapters that discover an estate into a common inventory; a planner
turns the inventory and the target hosts' capabilities into a plan the user
reviews; and one skill per systemd component (services, machines, networkd,
resolved, resource control, credentials, journald, storage, extensions,
portable services) renders its part of the result, composed at render time.
The multi-node Docker Swarm is the first and primary use case because it
exercises nearly every component. The work follows the systemd tree's own
conventions, so the rendered output, the fixtures, and the verification use
files, templates, and tests the tree already ships.

Everything below was checked against this checkout (systemd 262 development
tree). Where a capability depends on a version, the version is named.

## 1. What the tree already provides

The plan builds on these existing pieces rather than reimplementing them.

### 1.1 Images: `importctl pull-oci` and `.mstack/`

`importctl pull-oci REF [NAME]` (version 260) downloads an OCI image from a
registry into the image directory of the selected class (`machine` under
`/var/lib/machines/`, `portable` under `/var/lib/portables/`, `sysext` under
`/var/lib/extensions/`, `confext` under `/var/lib/confexts/`). It writes a
mount stack directory `NAME.mstack/` containing one `layer@N` symlink per image
layer and, unless the image is imported read-only, an `rw/` upper layer. The
format is `systemd.mstack(7)`; the tool is `systemd-mstack(1)`, which can also
be invoked as `mount.mstack`.

Two consumers exist for a mount stack: `systemd-nspawn --mstack=` for a
container, and `RootMStack=` in `systemd.exec(5)` for a plain service. Both are
version 260. The writable layer needs overlayfs `FSCONFIG_SET_FD` support,
which the pull-oci test gates on kernel 6.13.

What pull-oci does not keep is the image configuration: entrypoint, command,
environment, working directory, user, exposed ports, and declared volumes are
fetched but not written anywhere. The capture side already records all of them
from `docker service inspect` and `docker image inspect`, so the renderer
synthesises the corresponding directives itself.

### 1.2 Containers: nspawn, `.nspawn` files, and OCI bundles

`units/systemd-nspawn@.service.in` boots `/var/lib/machines/%i` with
`--network-veth`, `--settings=override`, `Slice=machine.slice`, and
`WantedBy=machines.target`. Per-machine settings live in
`/etc/systemd/nspawn/NAME.nspawn` (`systemd.nspawn(5)`), whose `[Exec]`,
`[Files]`, and `[Network]` sections map one to one onto the command line:
`Boot=`, `ProcessTwo=`, `Parameters=`, `Environment=`, `User=`,
`WorkingDirectory=`, `Capability=`, `DropCapability=`, `SystemCallFilter=`,
`Limit*=`, `Bind=`, `BindReadOnly=`, `TemporaryFileSystem=`, `Overlay=`,
`ReadOnly=`, `Volatile=`, `Private=`, `VirtualEthernet=`,
`VirtualEthernetExtra=`, `Bridge=`, `Zone=`, `Interface=`, `MACVLAN=`,
`IPVLAN=`, `NamespacePath=`, and `Port=`. nspawn also runs OCI runtime
bundles directly with `--oci-bundle=`, which `TEST-13-NSPAWN.nspawn-oci.sh`
exercises with a generated `config.json`.

### 1.3 Networking: the `80-container-*` files

`network/` ships, under an `ENABLE_NETWORKD` guard in `network/meson.build`,
the files that make nspawn networking work without configuration:

| File | Matches | Behaviour |
|---|---|---|
| `80-container-host0.network` | container side, `Kind=veth Name=host0 Virtualization=container` | DHCP client, LLDP |
| `80-container-host0-tun.network` | container side `tun` `host0` (slirp4netns or pasta) | DHCP client |
| `80-container-ve.network` and `.link` | host side `ve-*` of a plain veth | `Address=0.0.0.0/28`, DHCP server, `IPMasquerade=both`, IPv6 RA, `LocalLeaseDomain=_dhcp` |
| `80-container-vz.network` and `.link` | zone bridge `vz-*` | `Address=0.0.0.0/24`, DHCP server, masquerade, RA |
| `80-container-vb.network` and `.link` | host veth `vb-*` attached to a bridge | `KeepMaster=yes`, no addressing |
| `80-vm-vt.network` and `.link` | vmspawn tap `vt-*` | same shape as `ve-*` |

There are no `90-container-*` files. Interface names are fixed in
`src/nspawn/nspawn-network.c`: `ve-` or `vb-` plus the machine name (shortened
with a four-character hash beyond fifteen characters, the long form kept as an
alternative name), `vz-` plus the zone name, `mv-` and `iv-` inside the
container for macvlan and ipvlan, and `host0` for the container side of the
main veth. The shipped files cover `host0`, but nothing inside a container
configures an `mv-*` or `iv-*` interface, which is a gap this plan fills.

`systemd.netdev(5)` provides every virtual device kind the translation needs:
`bridge`, `veth`, `macvlan`, `ipvlan`, `vlan`, `vxlan`, `wireguard`, `bond`,
`dummy`, `tun`, and `tap`. `test/test-network/conf/` holds 421 fixtures for
them, in the `25-*` and `26-*` naming scheme, including `25-vxlan*`,
`25-wireguard*`, `25-bridge*`, `26-bridge-vlan-*`, `21-macvlan.netdev`,
`25-ipvlan.*`, and the `25-dhcp-server-*` set with static leases.

### 1.4 Portable services, extensions, capsules, virtual machines

Portable services attach unit files from an image or directory under
`/var/lib/portables/` into `/etc/systemd/system.attached/`, applying a profile
from `src/portable/profile/{system,user}/{default,nonetwork,strict,trusted}/service.conf`.
The image needs `os-release` with `PORTABLE_PREFIXES=`, and extension images
need `extension-release.d/extension-release.NAME` with matching `ID=` and
`SYSEXT_LEVEL=` or `VERSION_ID=` (`docs/PORTABLE_SERVICES.md`).

System extensions (`/var/lib/extensions/`, `systemd-sysext.service`) overlay
`/usr/` and `/opt/`; configuration extensions (`/var/lib/confexts/`,
`systemd-confext.service`) overlay `/etc/`. Both require the release file
described in `os-release(5)`, and a sysext must not ship its own
`/usr/lib/os-release`.

Capsules (`units/capsule@.service.in`) run a per-name user service manager as
`c-NAME` with `DynamicUser=yes`, home under `/var/lib/capsules/NAME/`, runtime
directory `/run/capsules/NAME/`, and `Slice=capsule.slice`; units go in
`/var/lib/capsules/NAME/.config/systemd/user/`.

vmspawn (`units/systemd-vmspawn@.service.in`) boots a DDI or directory from
`/var/lib/machines/%i` with `--network-tap` and `--register=yes`, with tap
devices configured by `80-vm-vt.*`.

### 1.5 Tests

Integration tests are registered in `test/integration-tests/meson.build` by a
hardcoded `foreach dirname` list; each `test/integration-tests/TEST-NN-NAME/meson.build`
appends an entry to `integration_tests`, and the test script is
`test/units/TEST-NN-NAME.sh` with subtests `TEST-NN-NAME.<sub>.sh` discovered by
`run_subtests`. Shared helpers in `test/units/util.sh` include
`create_dummy_container` (copies `/usr/share/TEST-13-NSPAWN-container-template`
provided by `mkosi/mkosi.conf`), `create_dummy_ddi` (in
`TEST-13-NSPAWN.nspawn.sh`), `install_extension_images`, `wait_for_machine`,
`find_qemu_binary`, and the `assert_*` family. The relevant existing tests are
`TEST-13-NSPAWN` (nspawn, OCI bundles, pull-oci, machined, importctl),
`TEST-29-PORTABLE`, `TEST-50-DISSECT.sysext.sh`, `TEST-74-AUX-UTILS.capsule.sh`,
`TEST-87-AUX-UTILS-VM` (vmspawn), `TEST-85-NETWORK` (the networkd suite, driven
by `test/test-network/systemd-networkd-tests.py`), `TEST-75-RESOLVED` and
`TEST-89-RESOLVED-MDNS` (DNS-SD between two nspawn containers),
`TEST-10-MOUNT`, `TEST-53-TIMER`, `TEST-63-PATH`, and the socket subtests of
`TEST-07-PID1`. The highest number in use is 94.

### 1.6 Conventions for extending the tree

Units are listed in `units/meson.build`; network files in `network/meson.build`;
docs are Markdown with YAML front matter under `docs/` and are linted by
`meson test -C build github-pages`; man pages are DocBook under `man/` and are
registered by `ninja -C build update-man-rules`. Shell scripts use four-space
indentation and no whitespace after redirection operators. Every file carries
an SPDX line, `LGPL-2.1-or-later` for code and docs and `MIT-0` for the shipped
network files.

## 2. Naming and layout

### 2.1 One plugin, organized around systemd

Claude Code plugin and marketplace names must be kebab-case, and plugins are
copied into separate caches on install, so two plugins cannot share a file.
The first generation worked around that by vendoring the contract into four
source-named plugins. The second generation is one plugin, `systemd-migration`,
in the `systemd-dev-plugins` marketplace, organized around systemd rather than
around the technology being migrated. Docker and Podman are adapters that
discover an estate into a common inventory; the work of expressing the estate
on systemd is split into one skill per systemd component so the pieces
compose, and the Quadlet renderer stays in full as the Podman adapter target.

```
plugins/systemd-migration/
  contract/            inventory schema and types, the directive catalogue and the
                       surface generated from man/, the unit builder, placement, the
                       component interface, the compose engine, the plan model, the
                       registry, the coverage manifest
  scripts/             the drivers: plan.ts, review.ts, render.ts
  skills/
    discover-docker-swarm/    adapter: capture.sh, normalize.ts
    discover-podman/          adapter: capture.sh, normalize.ts (scaffold)
    discover-systemd-hosts/   probe.sh: what each target host's systemd can do
    migration-planner/        plan.yaml, the translation map, MIGRATION-PLAN.md
    systemd-service/          scripts/component.ts plus the one-call render.ts
    systemd-machined/         images (mstack, DDI), machines (.nspawn), VMs
    systemd-networkd/         bridges, overlays, published ports, sockets
    systemd-resolved/         hosts file, DNS-SD, site DNS
    systemd-resource-control/ slices and limits
    systemd-creds/            credentials and the import script
    systemd-journald/         log fields, identifiers, namespaces
    systemd-storage/          mounts, tmpfiles, binds, tmpfs, data moves
    systemd-sysext/           config files as confexts
    systemd-portable/         portable services and capsules
    podman-quadlet/           the Podman adapter target
    systemd-verify/           dry-run and live verification
  agents/, commands/   discovery-auditor, migration-planner, unit-author,
                       quadlet-author, cutover-verifier; /migrate-discover,
                       /migrate-plan, /migrate-render, /migrate-render-quadlet,
                       /migrate-verify
  harness/             the Managed Agents harness
```

### 2.2 The component interface

A component (`contract/component.ts`) names the man pages it implements,
declares what a host must provide, raises the decisions it needs, and
contributes files and unit directives to a host's tree through a shared render
context. The compose engine (`contract/compose.ts`) runs every registered
component's `decide()` to draft `plan.yaml`, and every component's `render()`
per host in dependency order, so the creds, resource-control, storage,
networkd, and journald components each add their lines to the unit the service
component created; a `finish()` phase lets the service component write the
stack targets after everything registered its units. The engine owns
placement and the form each service takes (plain service, machine, virtual
machine, portable service, Quadlet container); components claim the forms they
render.

### 2.3 plan.yaml

`contract/plan.ts` and `plan-schema.json` define the user's approval surface.
Each decision carries its component, subject, question, options with
consequences and host requirements, evidence from the inventory, a default
where one is defensible, and the chosen value with the user's reason. Address
ranges, overlay transports, published-port policies, name resolution, data
moves, the form each service takes, where each secret lives, how images mount
on each host, journal namespaces, and config packaging are all decisions.
The ones that must not be guessed have no default. `render.ts` refuses an
unresolved plan and, without `--accept-defaults`, an unapproved one. A re-run
keeps earlier choices where they still apply. Nothing about an estate is a
constant in component code.

### 2.4 Where rendered output goes

The renderer writes a tree per host that mirrors the installed layout, so
`install.sh` is a `cp -a` plus the components' install steps and a
`daemon-reload`:

```
hosts/<host>/
  etc/systemd/system/            services, targets, slices, timers, sockets, mounts, drop-ins
  etc/systemd/nspawn/            NAME.nspawn per machine
  etc/systemd/network/           .netdev and .network files for zone bridges, vxlan, wireguard, macvlan
  etc/systemd/dnssd/             advertised services
  etc/systemd/resolved.conf.d/   resolver settings the discovery decision needs
  etc/hosts.d/                   the hosts fragment when discovery is hosts-file based
  etc/tmpfiles.d/ etc/sysctl.d/  local volumes, host tunables
  etc/<stack>/                   environment files and config files
  var/lib/confexts/              config files packed as a confext when decided
  secrets/import-credentials.sh  systemd-creds encrypt from operator-supplied files; values never rendered
  expected.json                  what the verifier checks on this host
  install.sh
images.json                      local name -> reference, digest, hosts; input to pull-images.sh
expected.json                    every host
MIGRATION-NOTES.md               decisions taken without review, translations to review, capture warnings
```

## 3. The translation map

The planner skill, `docker-to-systemd-planner`, is the first thing to build,
because every renderer is an implementation of one column of its output. It
produces two artifacts from an inventory: a human `TRANSLATION-MAP.md` and a
machine-readable `translation-map.json` that the renderers consume. For each
source concept it lists every candidate systemd target, the directives
involved with their man page reference, a fidelity rating, the version
requirement, and the reason a target may be rejected for this estate.

### 3.1 Directive catalogue generated from `man/`

To make "all unit types and directives" checkable rather than aspirational,
a Bun script `catalog.ts` parses `man/systemd.*.xml` and the file-format pages
(`systemd.unit`, `.service`, `.socket`, `.timer`, `.path`, `.mount`,
`.automount`, `.swap`, `.slice`, `.scope`, `.target`, `.device`, `.exec`,
`.kill`, `.resource-control`, `.network`, `.netdev`, `.link`, `.nspawn`,
`.dnssd`, `.mstack`, `.v`, `repart.d`, `sysusers.d`, `tmpfiles.d`,
`sysctl.d`, `environment.d`, `os-release`) and emits
`directives.json`: for every section, the directive names, the version each was
added in (from the `version-info.xml` includes), and the page. The planner and
every renderer validate their output against this catalogue, so an emitted
directive that this tree does not document is a test failure, and the catalogue
doubles as the "supports all unit, directive, and service types" evidence.

### 3.2 The map itself

The table below is the intended content of the map, with the primary target
first. Fidelity is the renderer's honest rating: exact, equivalent (same
behaviour by other means), partial (documented loss), or manual (runbook
step).

| Docker concept | systemd targets and directives | Fidelity | Needs |
|---|---|---|---|
| Image (registry reference, digest) | `importctl pull-oci --class=machine REF NAME` producing `NAME.mstack/`; digest recorded in `[X-Migration]`; versions via `NAME.raw.v/` (`systemd.v(7)`) | exact for layers; config synthesised | v260, kernel 6.13 for `rw/` |
| Image entrypoint, cmd, env, workdir, user | `ExecStart=`, `Environment=`, `WorkingDirectory=`, `User=` or `DynamicUser=yes`; nspawn `[Exec] Parameters=`, `Environment=`, `WorkingDirectory=`, `User=` | exact | |
| Service running an app container | `NAME.service` with `RootMStack=` (or `RootImage=` for a DDI), `MountAPIVFS=yes`, `BindPaths=`, `PrivateDevices=`, `ProtectSystem=strict`; alternative nspawn `--mstack=` with `ProcessTwo=yes` | equivalent | v260 |
| Service booting a full OS image | `systemd-nspawn@NAME.service` plus `NAME.nspawn` with `Boot=yes`; `machines.target` | exact | |
| Replicas and `mode: global` | template `NAME@.service` with one instance per replica per host, `Slice=stack-<name>.slice`; global becomes one instance per eligible host | equivalent | |
| Stack | `<stack>.target` (`Wants=` its services), `stack-<name>.slice`, `[X-Migration] Stack=` | equivalent | |
| Placement constraints, node labels | host assignment from the host map; `ConditionHost=` and `AssertHost=` guards; labels recorded in `/etc/machine-info` `DEPLOYMENT=` and `LOCATION=` | equivalent | |
| Restart policy | `Restart=`, `RestartSec=`, `StartLimitIntervalSec=`, `StartLimitBurst=`, `RestartMaxDelaySec=`, `RestartSteps=` | exact | |
| Stop grace period, stop signal | `TimeoutStopSec=`, `KillSignal=`, `KillMode=mixed`; nspawn `KillSignal=` | exact | |
| Healthcheck command | `NAME-health.timer` and `.service` running the command with `OnFailure=NAME-restart.service`; `WatchdogSec=` when the app speaks `sd_notify`; `Notify=` in nspawn | equivalent | |
| Update config, rollback config | runbook: `systemctl reload-or-restart` in parallelism batches; images under `.v/` so `vpick` rolls back by version; `RefreshOnReload=` (v260) where applicable | manual | |
| Resources (limits, reservations) | `CPUQuota=`, `CPUWeight=`, `AllowedCPUs=`, `MemoryMax=`, `MemoryLow=`, `TasksMax=`, `IOWeight=`, `DevicePolicy=`; nspawn via `--property=` | exact | |
| Capabilities, privileged, security options | `CapabilityBoundingSet=`, `AmbientCapabilities=`, `NoNewPrivileges=`, `SystemCallFilter=`, `AppArmorProfile=`, `SELinuxContext=`; nspawn `Capability=`, `DropCapability=`, `SystemCallFilter=`; `privileged: true` is a note, never rendered | partial | |
| ulimits, sysctls, oom score | `Limit*=`, `sysctl.d/` fragment (host scope) or note, `OOMScoreAdjust=` | exact | |
| Devices | `DeviceAllow=` under `DevicePolicy=closed`; nspawn `--bind=/dev/x` with `DeviceAllow=` in the unit | exact | |
| Logging driver | journald with `LinkJournal=try-guest`, `LogExtraFields=`, `SyslogIdentifier=` | equivalent | |
| Secrets | `LoadCredentialEncrypted=name:/etc/credstore.encrypted/name` or `ImportCredential=`, read from `$CREDENTIALS_DIRECTORY`; import script uses `systemd-creds encrypt`; nspawn `--load-credential=`; values never rendered | exact | |
| Configs | confext image per stack for `/etc/` content, or `BindReadOnlyPaths=/etc/<stack>/<name>:<target>`; ownership and mode from the config reference | exact | |
| Environment, env files | `Environment=`, `EnvironmentFile=/etc/<stack>/<service>.env` mode 0600 | exact | |
| Published ports (`host` mode) | the service binds directly; `SocketBindAllow=` and `SocketBindDeny=` enforce the declared ports; `.socket` units with `Accept=no` for socket activation where the app takes an inherited socket | equivalent | |
| Published ports (`ingress` mode) | no routing mesh exists; choices are `host` mode on each host, nspawn `Port=` (nftables DNAT into the machine), or a front proxy; the planner asks | partial | |
| Overlay network, single host | zone bridge `vz-<net>` via nspawn `Zone=` for machines or a `.netdev Kind=bridge` plus `.network` for services; `Address=` taken from the Swarm IPAM subnet instead of the shipped `0.0.0.0/24`; DHCP server with `[DHCPServerStaticLease]` entries for fixed addresses; `LocalLeaseDomain=` for names | equivalent | |
| Overlay network, multi host | `.netdev Kind=vxlan` on top of `.netdev Kind=wireguard` between hosts, bridged into the zone bridge on each host; the encrypted flag selects wireguard; fixtures `25-vxlan*`, `25-wireguard*` | equivalent | |
| macvlan and ipvlan networks | nspawn `MACVLAN=` and `IPVLAN=`; for services a `.netdev Kind=macvlan` with `Mode=bridge`; new `80-container-mv.network` and `80-container-iv.network` inside the machine | exact | |
| Host network | nspawn `Private=no`; services run in the host namespace | exact | |
| Service discovery by name | `LocalLeaseDomain=` on the zone bridge DHCP server, `MulticastDNS=yes` and `LLMNR=yes` per link, `.dnssd` files for advertised services, `resolved.conf.d/` for the estate domain | equivalent | |
| Named volumes (local) | `/var/lib/<stack>/<volume>/` created by a `tmpfiles.d` `d` line, attached with `BindPaths=` or nspawn `Bind=`; `StateDirectory=` for `DynamicUser=` services | exact | |
| Volumes with a driver (nfs, cifs) | `.mount` unit with `RequiresMountsFor=` on the consumer, `.automount` when idle unmount is wanted | exact | |
| Bind mounts, tmpfs | `BindPaths=`, `BindReadOnlyPaths=`, `TemporaryFileSystem=`; nspawn `Bind=`, `BindReadOnly=`, `TemporaryFileSystem=` | exact | |
| Persistent data on new disks | `repart.d/` definitions creating `/var/lib/<stack>` volumes at first boot | equivalent | |
| Compose `depends_on`, `profiles` | `After=` plus `Wants=` or `Requires=` (with `condition: service_healthy` mapped to the health timer); profiles become targets | exact | |
| Compose `init`, `pid`, `ipc`, `read_only`, `extra_hosts`, `dns` | nspawn `ProcessTwo=`, `PrivatePIDs=`, `PrivateIPC=`, `ProtectSystem=strict` or `ReadOnly=`, `/etc/hosts` bind, per-link `DNS=` | exact | |
| Portable service target | image or directory under `/var/lib/portables/` with `os-release` (`PORTABLE_PREFIXES=`) and the rendered units; profile chosen from `default`, `nonetwork`, `strict`, `trusted`; extension images for shared runtimes | equivalent | |
| Sysext target | only for images whose payload is a pure `/usr/` overlay; `extension-release.NAME` with `ID=_any` unless the base is known; otherwise rejected with a note | partial | |
| Capsule target | `capsule@<stack>.service` running each service as a user unit under `/var/lib/capsules/<stack>/.config/systemd/user/` with `RootMStack=` | equivalent | |
| vmspawn target | bootable DDI built by `systemd-repart --make-ddi` from the merged mount stack plus a kernel; `systemd-vmspawn@NAME.service`; `80-vm-vt.*` networking | partial | qemu, kvm |
| Manager nodes, quorum, drain | no equivalent; the runbook covers node roles and maintenance with `systemctl isolate` and `machinectl` | manual | |

Every row that reads partial or manual produces an entry in
`MIGRATION-NOTES.md` under "needs a human decision", as the current renderer
does.

## 4. Changes inside the systemd tree

These are the additions that extend systemd itself rather than the plugin
tree. Each is small, follows the directory's existing conventions, and is
independently upstreamable.

| Path | Content | Reason |
|---|---|---|
| `network/80-container-mv.network` and `80-container-iv.network` | `[Match] Kind=macvlan Name=mv-* Virtualization=container` (and `Kind=ipvlan Name=iv-*`), `DHCP=yes`, `LinkLocalAddressing=yes`, `LLDP=yes`, MIT-0 header, listed in `network/meson.build` | inside a container, `--network-macvlan` and `--network-ipvlan` interfaces have no shipped configuration, unlike `host0` |
| `test/integration-tests/TEST-95-CONTAINER-MIGRATION/meson.build` | `integration_test_template + {'name': ..., 'vm': true}`; the directory added to the `foreach dirname` list and to `testdata_subdirs` | registers the test the way every other test is registered |
| `test/units/TEST-95-CONTAINER-MIGRATION.sh` and subtests | see section 5 | the verification the user asked for, using the tree's own helpers |
| `test/test-container-migration/` | fixture captures (`docker inspect` JSON for a two-node, two-stack estate), compose files, and the expected rendered tree | evidence the tests render from |
| `test/test-network/conf/25-container-zone.netdev`, `25-container-zone.network`, `25-container-vxlan.netdev`, `25-container-vxlan.network`, `25-container-wireguard.netdev`, `25-container-wireguard.network` | the rendered network shapes as fixtures in the suite's naming scheme | reused by the networkd subtest and available to the Python suite if a testcase is added there |
| `docs/MIGRATING_CONTAINERS_TO_SYSTEMD.md` | the translation map in prose, with front matter and the `github-pages` lint passing | the tree's documentation is where a systemd user would look |
| `mkosi/mkosi.conf` | no change expected; the container template and minimal images the tests reuse are already provided | |

No new C code, no new unit files under `units/`, and no new man pages are
planned in this phase; the rendered output uses only directives that already
exist, which the directive catalogue enforces.

## 5. Verification through the tree's tests

`TEST-95-CONTAINER-MIGRATION.sh` sources `util.sh` and `test-control.sh` and
runs these subtests, each of which renders from the fixture inventory with the
plugin scripts (Bun is added to the test image's package list in
`mkosi/mkosi.conf`, or the rendered tree is committed as a fixture and the
render step is checked separately by `bun test`):

| Subtest | What it does | Helpers reused |
|---|---|---|
| `.inventory.sh` | normalises the fixture capture, validates against the schema, and compares warnings with the expected list | none |
| `.mstack.sh` | builds a mount stack from two `create_dummy_container` layers, renders a `RootMStack=` service, starts it, asserts the process sees the merged tree and the credentials directory | `create_dummy_container`, `assert_*` |
| `.nspawn.sh` | renders `.nspawn` files and `systemd-nspawn@` instances, starts a machine with `Zone=`, waits for registration, checks `host0` got an address from the zone bridge and that `Port=` forwards | `create_dummy_container`, `wait_for_machine`, `machinectl` |
| `.networkd.sh` | copies the rendered `.netdev` and `.network` files into `/run/systemd/network`, reloads, and asserts with `networkctl status --json` that the zone bridge carries the IPAM subnet, the static leases exist, the vxlan sits on the wireguard link, and `mv-*` inside a machine gets an address | `networkctl`, the `25-container-*` fixtures |
| `.dnssd.sh` | installs the rendered `.dnssd` files and the resolved drop-in from `rendered/forms`, restarts resolved, and checks one DNS-SD service is registered per file with mDNS and LLMNR on | `resolvectl`, `busctl` |
| `.journald.sh` | installs `journald@web.conf` from `rendered/forms`, writes through a unit with the stack's `LogNamespace=`, and checks the message lands in the namespace journal and not the host's | `journalctl --namespace` |
| `.portable.sh` | attaches the rendered portable directory with the `strict` profile and checks the unit runs | `install_extension_images` |
| `.sysext.sh` | stages the confext `rendered/forms` carries for the web stack, applies the ownership manifest from `install.sh`, merges it, and checks `/etc/web/configs/` appears with the recorded mode and disappears on unmerge | `systemd-confext` |
| `.capsule.sh` | starts `capsule@stack.service` with the rendered user units | the pattern from `TEST-74-AUX-UTILS.capsule.sh` |
| `.vmspawn.sh` | skips with 77 without qemu; otherwise boots the rendered DDI and waits for the machine | `find_qemu_binary`, `wait_for_machine` |
| `.verify.sh` | runs `systemd-analyze verify` over every rendered unit and the plugin's verifier in dry-run per host | `systemd-analyze` |

The plugin's own `bun test` suite keeps covering the renderers offline, and
the harness's verifier skill runs the subset of these subtests that make sense
on a production host (`.verify.sh`, the read-only parts of `.networkd.sh`),
never the ones that start machines.

## 6. Harness changes

The Managed Agents harness keeps its four roles. The lead gains the planner as
its first delegation, so every session starts from a translation map; the unit
author gains one skill per target and reads the map to choose; the verifier
runs `.verify.sh` and the read-only checks. The approval policy gains rules for
the new tools: `importctl`, `machinectl`, `portablectl`, `systemd-sysext`,
`systemd-confext`, `systemd-mstack`, `systemd-vmspawn`, `systemd-dissect`, and
`networkctl` are allowed for `list`, `status`, `show`, and `inspect` forms and
denied for `pull`, `attach`, `merge`, `start`, `mount`, and `edit` forms, which
remain runbook steps. The worker unit gains `InaccessiblePaths=` for
`/var/lib/portables`, `/var/lib/extensions`, and `/var/lib/confexts` so an agent
can render into the workspace but never into the live directories.

## 7. Phases

Each phase ends with the harness suite green, the fixture drift checks clean,
and the integration subtests passing under
`mkosi -f box -- meson test -C build --setup=integration`.

1. **Restructure.** One plugin organized by systemd component, one contract,
   adapters for the sources, commands renamed. Done.
2. **Composition layer.** The component interface, the compose engine,
   `plan.yaml` with guided review, the drivers, the first ten components, the
   one-call renderer re-implemented over the engine. Done.
3. **Host discovery.** `discover-systemd-hosts/probe.sh`, its harness test,
   the `.probe.sh` subtest. Done.
4. **Surface coverage.** `contract/surface.json` generated from `man/`,
   `contract/coverage.json`, the coverage test. Done.
5. **Networking.** Zone bridges with the decided ranges and static leases,
   VXLAN and WireGuard transports, macvlan, published ports as sockets,
   discovery; the `.networkd.sh` subtest. Done.
6. **Machines.** The machine form with binds, credentials, capabilities,
   and limits; the VM form; `rendered/machine` as a second fixture tree from
   a committed plan; the `.nspawn.sh` subtest. Done.
7. **Adapters.** The Quadlet renderer as a component selectable per service;
   the Podman discovery adapter. Done.
8. **Documentation and harness.** Agents, commands, tasks, approvals, the
   docs page, this plan. Done alongside the phases above.
9. **Remaining subtests.** `.dnssd.sh`, `.sysext.sh`, and `.journald.sh` run
   against `rendered/forms`, a third committed tree from `plan-forms.yaml`.
   `.portable.sh`, `.capsule.sh`, and `.vmspawn.sh` wait on the portable
   component rendering an attachable image and on a bootable fixture image.
10. **Swarm parity.** Section 10: load balancing and the ingress mesh, every
    interface kind, generators and presets, rollouts and drain, the service
    semantics audit.

## 8. Decisions taken

The questions section 8 used to leave open were answered on the pull request
and are recorded here so the plan reads as one document.

1. **Granularity.** One plugin, grouped by role; not one plugin per systemd
   component. Skills are organized per component inside it.
2. **Python.** The networkd verification may add a test class to
   `test/test-network/systemd-networkd-tests.py` if it needs the Python
   suite; the shell subtest is the first choice.
3. **Upstream.** Tree additions are written to upstream standards and land in
   this fork first.
4. **Branching.** The restructure is a second pull request into the first
   one's branch, with normal commits and no history rewriting.
5. **Scope.** Every systemd component is in scope, with the multi-node Docker
   Swarm as the MVP and Podman as the next adapter; Quadlet is the Podman
   adapter's target, not a systemd component. Coverage is measured against
   the tree's man pages rather than asserted.
6. **Floors.** systemd 261 and kernel 6.13 on target hosts for mount stacks;
   older hosts fall back to disk images, decided per host from the probe.

## 9. Status

The restructure branch (`claude/systemd-migration-restructure`, pull request 5
into pull request 1's branch) carries phases 1 to 8 complete and phase 9 in
progress. The harness suite covers the contract, both discovery adapters, the
composition engine, every component's decisions and rendering (plain services,
machines, virtual machines, Quadlet containers, zone bridges and transports,
discovery, credentials, storage, journal settings, confexts, portable
services), the probe, the verifier, and the surface coverage;
`plugins/scripts/render-fixtures.sh --check` guards the committed native,
machine, and forms fixture trees; `TEST-95-CONTAINER-MIGRATION` runs `.inventory.sh`,
`.mstack.sh`, `.nspawn.sh`, `.networkd.sh`, `.dnssd.sh`, `.sysext.sh`,
`.journald.sh`, `.verify.sh`, and `.probe.sh` on a booted image.

The first pull request (`claude/swarm-to-systemd-agent-gcqvex`) carries the
first generation: the four source-named plugins, the directive catalogue, the
translation map, the fixture estate, the native service renderer, and the
harness. Everything there is kept; this branch reorganizes and extends it.

## 10. Feature parity with a multi-node Docker Swarm

Sections 1 to 9 built the composition layer and one component per systemd
area. This section records what a Swarm cluster does that the rendered estate
does not yet, and the design each gap gets. The rule from section 2 holds:
every mechanism is a decision in `plan.yaml` with the source's values as
evidence, chosen at review time, never a constant. Where systemd has a
declarative primitive it is the first option; where it has none, the
alternative is an adapter target listed under `adapters` in
`contract/coverage.json`, like Quadlet.

### 10.1 Parity matrix

| Swarm | systemd today | Gap and design |
|---|---|---|
| Overlay network, encrypted overlay | zone bridge per network; VXLAN, VXLAN over WireGuard, routed WireGuard, underlay | Every tunnel kind `systemd.netdev(5)` documents joins the transport decision (10.5). |
| macvlan and ipvlan networks | rendered on the decided parent | Done. |
| Host networking | `Private=no`, host binds | Done. |
| Service VIP (`endpoint_mode: vip`), same-node and cross-node replicas | none; published ports offset per instance | The publish decision gains load-balancing options (10.2). |
| Ingress routing mesh (every node accepts a published port) | none | An ingress decision per published port: on every host or on placement hosts only (10.2). |
| `endpoint_mode: dnsrr` | hosts fragment, DNS-SD, site DNS | Done; a machine's lease or a host address per replica. |
| Service discovery by name and alias | resolved component | Done. |
| Replicated and global mode, placement constraints and platforms | `contract/placement.ts` | Placement preferences (spread over a label) and `max_replicas_per_node` are not honoured (10.6). |
| Replicated and global jobs | rendered as services with a note | Oneshot services and, for scheduled jobs, timers (10.6). |
| Rolling update (`update_config`), rollback (`rollback_config`), `docker stack deploy` re-apply | notes in the rendered tree | A per-host controller and a rollout specification (10.4). |
| Node drain, `docker node update --availability` | none | The controller's `drain` and `activate` verbs (10.4). |
| Restart policy (condition, delay, max attempts, window) | `Restart=`, `RestartSec=`, `StartLimitBurst=`, `StartLimitIntervalSec=` | Audit every field maps (10.6). |
| Healthcheck-driven restart | health timer, restart unit | Done; the rollout controller also reads the health result (10.4). |
| Resource limits and reservations | `CPUQuota=`, `MemoryMax=`, `MemoryLow=`, `TasksMax=`, `CPUWeight=`, slices | Done. |
| Secrets and configs, rotation | credentials, plain files or confext; import script | Rotation is a controller verb: re-encrypt, `confext refresh`, restart in rollout order (10.4). |
| Logging driver and options | journal, `LogNamespace=`, `LogExtraFields=` | Done. |
| Stack grouping, `docker stack rm` | `<stack>.target`, `stack-<stack>.slice` | Grouping units optionally emitted by a generator; presets decide enable state (10.3). |
| Node labels, engine labels | placement evidence | Done. |
| Swarm control plane TLS, node join tokens | not applicable | Hosts are not a cluster; the operator's ssh reaches them (the probe). |

### 10.2 Load balancing and the ingress mesh

Swarm balances in two places: the service VIP (IPVS across the tasks of a
service, reachable from any container on the network) and the ingress mesh
(every node's published port forwards to a task somewhere). Neither is one
systemd primitive, so the publish decision `networkd.publish.<service>.<port>`
grows from four options to a list the user chooses from at review time, each
with its requirements from the probe:

- `host`: the service binds the port on its host (today's default).
- `socket`: a `.socket` unit owns the port and passes it in (today).
- `reuseport`: one `.socket` per instance on this host with `ReusePort=yes`; the
  kernel spreads connections across the instances. Only for services that
  accept an inherited socket.
- `socket-proxyd`: one `.socket` per backend with `ReusePort=yes`, each
  activating a `systemd-socket-proxyd@` instance that forwards to that
  backend's address and port. Backends are the instances on this host and,
  when the ingress decision says every host, the instances on the other
  hosts over the transport. Kernel-level spread across backends, no third
  party, works for machines and plain services alike; a dead remote backend
  costs the connections hashed to it until its socket is stopped, which the
  rollout controller does when it drains a host.
- `multipath`: an address per service (its VIP) on a `dummy` netdev on every
  host, routed through a `[NextHop]` group (`Group=` with weights) or a
  `MultiPathRoute=` over the backends' addresses (machines on their leases,
  hosts on their bridge addresses). Layer 3, per flow, declarative in
  `.network` files; the closest thing to IPVS that networkd renders itself.
- `haproxy`: a hardened `haproxy.service` per host rendered by the
  `haproxy-ingress` adapter component from the backends and the source's
  healthcheck, listening on the published port (and on the VIP when the
  multipath decision anchors one), with `ExecReload=` for reloads and the
  configuration as a rendered file under `/etc/haproxy/`. HAProxy is the
  option when a proxy with health checks and layer 7 behaviour is wanted;
  it requires the `haproxy` tool on the host and is an adapter target, not a
  systemd page.
- `external-lb`, `dns-rr`: as today.

A second decision per published port, `networkd.ingress.<service>.<port>`,
selects `placement-hosts` (the port exists where the service runs) or
`every-host` (the port exists on every host in the plan, forwarding to the
placement hosts), which is the mesh. The `socket-proxyd`, `multipath`, and
`haproxy` options honour it; `host` and `socket` cannot and say so.

Backends come from the same lease table the networkd component publishes
under `networkd:leases` and from the host addresses in the plan. When an
option needs a VIP the networkd component raises `networkd.vip.<service>` (a
value with `format: ipv4`, defaulting to an address from a decided VIP range
`networkd.vip.range.estate`).

### 10.3 Generators and presets

`generator.stacks.estate` chooses between rendered grouping units (today) and
`systemd-migration-generator`, a POSIX sh generator this plugin ships under
`skills/systemd-generator/scripts/` and installs to
`/usr/lib/systemd/system-generators/`. `install.sh` writes one
`/etc/systemd-migration/stacks.d/<stack>.conf` per stack (an `.ini` with the
stack's units, slice settings, and `WantedBy=`); on every boot and
`daemon-reload` the generator emits `<stack>.target`, `stack-<stack>.slice`,
and the `Wants=` symlinks into the early generator directory, so the host
carries no generated grouping units under `/etc/systemd/system` and an
operator edits the description rather than re-rendering. The service and
resource-control components already skip the target and slice files when the
generator is chosen.

`generator.preset.estate` chooses whether
`/usr/lib/systemd/system-preset/80-systemd-migration.preset` decides the
enable state (`enable <stack>.target`, `disable` for units the estate stopped
running) and `install.sh` runs `systemctl preset-all` over the rendered units,
instead of `systemctl enable` per target.

### 10.4 Rollouts, rollback, and drain

`systemd-rollout` renders, per host, a rollout specification per stack
(`/etc/systemd-migration/rollout/<stack>.conf`: per service, `parallelism`,
`delay`, `order` (`start-first` or `stop-first`), `failure_action` (`pause`,
`continue`, `rollback`), `monitor`, `max_failure_ratio`, from the source's
`update_config` and `rollback_config`) and one POSIX sh controller,
`/usr/local/lib/systemd-migration/stackctl`, whose verbs are:

- `deploy <stack> [--image NAME=REF]`: pull the new image under a new
  versioned directory (`systemd.v(7)`), then restart the service's instances
  in the specified order and batches, waiting `delay` between batches and
  reading the health unit's result during `monitor`; on failure apply
  `failure_action`.
- `rollback <stack> [service]`: the same walk with the previous version.
- `drain <host>` and `activate <host>`: stop the host's instances in rollout
  order and stop the sockets or proxies that point at them (10.2), or start
  them again.
- `scale <service> <n>`: change the instance count on this host within the
  plan's placement.
- `rotate <credential|config>`: re-encrypt or refresh, then restart the
  consumers in rollout order.
- `status <stack>`: instances, versions, health results.

The controller uses `systemctl`, `systemd-run` for the monitor timer, and the
versioned image directories; it needs no Bun. The harness gains a `rollout`
task and the approval policy allows the controller's read verbs and asks for
the rest. `/migrate-rollout` drives it.

### 10.5 Every interface kind

The transport decision offers every tunnel kind `systemd.netdev(5)` documents
that can carry the network between hosts: `vxlan` (with and without
WireGuard), `geneve`, `gre`, `gretap`, `ip6gre`, `ip6gretap`, `erspan`, `ipip`,
`sit`, `ip6tnl`, `vti`, `vti6`, `xfrm`, `l2tp`, `bareudp`, `fou` encapsulation,
`macsec` on a shared segment, and `wireguard`; each with the values it needs
raised as decisions (`Local=`, `Remote=`, keys as credentials, identifiers)
and the version the catalogue gives it. `dummy` anchors service VIPs. `tun`
and `tap` serve the VM form. Kinds that own a physical link (`bond`, `vlan`,
`vrf`, a bridge over a NIC) are rendered only when the plan's uplink decision
says the harness owns that host's uplink; otherwise the uplink stays the
site's. Traffic control sections (`[QDisc]` and the shapers) are out of scope
for parity because Swarm has none.

### 10.6 Service semantics

The service component audits every source field against the catalogue:
restart policy conditions map to `Restart=` values with `RestartSec=`,
`StartLimitBurst=`, and `StartLimitIntervalSec=` from the window; jobs become
`Type=oneshot` with `RemainAfterExit=no` and, when the source ran them on a
schedule, timers; `stop_grace_period` becomes `TimeoutStopSec=`; `stop_signal`
becomes `KillSignal=`; `init` becomes an `ExecStart=` through a documented
init when the image has one and a note otherwise; placement preferences
spread instances over the label's values and `max_replicas_per_node` caps the
scale-out. `endpoint_mode` selects the load-balancing default in 10.2.

### 10.7 Work streams

Five streams, disjoint by file, each ending with the harness suite green,
the fixture drift check clean, and a TEST-95 subtest where the mechanism can
run on the booted image:

1. `systemd-networkd`: 10.5 and the networkd side of 10.2 (`reuseport`,
   `socket-proxyd`, `multipath`, the ingress and VIP decisions, backends from
   leases).
2. `haproxy-ingress`: the adapter component reading the `haproxy` publish
   decisions, the rendered configuration and unit, health checks from the
   source healthcheck, `.haproxy.sh` (skips without the binary).
3. `systemd-generator`: 10.3, the generator script, the preset file, the
   `stacks.d` description, `.generator.sh`.
4. `systemd-rollout`: 10.4, the controller, the specification, the harness
   task, the command, `.rollout.sh` over the committed native tree.
5. `systemd-service` and `contract/placement.ts`: 10.6.
