<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# systemd-dev-plugins: moving container estates onto systemd primitives

This document plans the second generation of the migration tooling that lives
under `plugins/`. The first generation, `swarm-to-systemd`, captures a Docker
Swarm estate and renders Podman Quadlet units. The second generation keeps that
capture as one source among several and adds every deployment form systemd
itself offers as a target: plain units of every type, nspawn containers, mount
stacks, vmspawn virtual machines, portable services, system and configuration
extensions, capsules, and networkd-managed networking. It also moves the work
into the systemd tree's own conventions, so that the rendered output, the
fixtures, and the verification all use files, templates, and tests that the
tree already ships.

Everything below was checked against this checkout (systemd 261 development
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

### 2.1 Marketplace and plugins

Claude Code plugin and marketplace names must be kebab-case; a colon is not
allowed, and the install form is `plugin@marketplace`. The requested
`systemd-dev-plugins:[source]-[object]-to-[target]` therefore becomes:

- marketplace `systemd-dev-plugins`, declared in `.claude-plugin/marketplace.json`
  at the repository root (replacing `danielbodnar-systemd`);
- plugins named `<source>-<object>-to-<target>` under `plugins/`;
- skills addressed as `plugin:skill`, for example
  `docker-swarm-to-systemd:capture`.

Skills must be direct children of a plugin's `skills/` directory, and plugins
are copied into a cache on install, so two plugins cannot share a file after
installation. That rules out one shared schema directory and argues against a
large number of very small plugins. The layout below groups by target family,
which keeps each plugin installable on its own and keeps the shared contract
small enough to vendor.

| Plugin | Purpose | Skills (each `SKILL.md` is named `<source>-<object>-to-<target>`) |
|---|---|---|
| `docker-swarm-to-systemd` | Source side. Capture and normalise a Swarm, Compose project, or single host into the inventory contract; plan the translation. | `docker-swarm-to-inventory`, `docker-compose-to-inventory`, `docker-container-to-inventory`, `docker-to-systemd-planner`, `docker-to-systemd-cutover` |
| `oci-image-to-systemd` | Images. Pull or convert an image into a mount stack, DDI, or directory, and run it as a native service. | `oci-image-to-mstack`, `oci-image-to-ddi`, `docker-image-to-service` (`RootMStack=` or `RootImage=` units) |
| `docker-container-to-nspawn` | Containers as machines. | `docker-container-to-nspawn`, `docker-container-to-oci-bundle`, `docker-stack-to-machines` (targets, slices, machined registration) |
| `docker-container-to-vmspawn` | Containers as virtual machines. | `docker-container-to-vmspawn`, `docker-image-to-bootable-ddi` |
| `docker-service-to-portable` | Services as portable images and capsules. | `docker-service-to-portable`, `docker-service-to-capsule`, `docker-stack-to-portable-profile` |
| `docker-image-to-sysext` | Images and configs as extensions. | `docker-image-to-sysext`, `docker-config-to-confext`, `docker-secret-to-credential` |
| `docker-network-to-networkd` | Networks. | `docker-network-to-networkd`, `docker-overlay-to-vxlan`, `docker-macvlan-to-netdev`, `docker-port-to-socket`, `docker-dns-to-resolved` |
| `docker-volume-to-systemd` | Storage. | `docker-volume-to-mount`, `docker-bind-to-tmpfiles`, `docker-volume-to-repart` |
| `podman-container-to-quadlet` | The existing Quadlet renderer, kept as the Podman target. | `podman-container-to-quadlet`, `podman-network-to-quadlet`, `podman-volume-to-quadlet` |
| `systemd-migration-harness` | The Managed Agents harness and the verification skill that runs the tree's tests. | `systemd-migration-verify`, `systemd-migration-worker` |

Ten plugins and about thirty skills. Each skill carries the trigger phrases in
its `description`, since that field drives automatic invocation.

### 2.2 Shared contract

The inventory schema (`inventory-schema.json`), its TypeScript types, and the
translation map are needed by every plugin. They live once, under
`plugins/docker-swarm-to-systemd/references/`, and are vendored into the other
plugins by a `just sync-contract` recipe that copies the files and writes a
checksum header. A test in the harness fails when any vendored copy drifts.

### 2.3 Where rendered output goes

The renderer writes a tree per host that mirrors the installed layout, so
`install.sh` is a `cp -a` plus `daemon-reload`:

```
hosts/<host>/
  etc/systemd/system/            stack targets, services, sockets, timers, mounts, slices, drop-ins
  etc/systemd/network/           .netdev, .network, .link for zone bridges, vxlan, wireguard, macvlan
  etc/systemd/nspawn/            NAME.nspawn per machine
  etc/systemd/dnssd/             advertised services
  etc/systemd/resolved.conf.d/   per-estate resolver settings
  etc/sysusers.d/ etc/tmpfiles.d/ etc/repart.d/ etc/sysctl.d/
  etc/credstore.encrypted/       encrypted credentials (values never rendered; import script only)
  etc/<stack>/                   environment files and non-secret config files
  var/lib/machines/              NAME.mstack symlinks or NAME/ directories, NAME.raw.v/ for versioned images
  var/lib/portables/ var/lib/extensions/ var/lib/confexts/ var/lib/capsules/
  expected.json                  what the verifier checks on this host
MIGRATION-NOTES.md               every decision the renderer declined to make
TRANSLATION-MAP.md               the planner's map for this estate
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
| `.dnssd.sh` | resolves a service name across two machines through the zone bridge's lease domain and mDNS | the pattern from `TEST-89-RESOLVED-MDNS.sh` |
| `.portable.sh` | attaches the rendered portable directory with the `strict` profile and checks the unit runs | `install_extension_images` |
| `.sysext.sh` | merges a rendered confext built from the fixture configs and checks `/etc/<stack>/` appears with the recorded ownership | the pattern from `TEST-50-DISSECT.sysext.sh` |
| `.capsule.sh` | starts `capsule@stack.service` with the rendered user units | the pattern from `TEST-74-AUX-UTILS.capsule.sh` |
| `.vmspawn.sh` | skips with 77 without qemu; otherwise boots the rendered DDI and waits for the machine | `find_qemu_binary`, `wait_for_machine` |
| `.verify.sh` | runs `systemd-analyze verify` over every rendered unit and the directive catalogue check | `systemd-analyze` |

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

Each phase ends with the tree building, `bun test` green, and the new subtests
passing under `mkosi -f box -- meson test -C build --setup=integration`.

1. **Restructure.** Rename the marketplace, split the existing plugin into
   `docker-swarm-to-systemd` and `podman-container-to-quadlet`, add the
   contract sync, keep the current tests green. Nothing new is rendered yet.
2. **Planner and catalogue.** `catalog.ts` over `man/`, the translation map
   skill, `translation-map.json`, and the `docs/` page. The fixture estate under
   `test/test-container-migration/`.
3. **Images and native services.** `oci-image-to-systemd`: pull-oci wrapper,
   mount stack layout, `RootMStack=` services, `.v/` versioning, credentials.
   `TEST-95` with `.inventory.sh`, `.mstack.sh`, `.verify.sh`.
4. **Machines.** `docker-container-to-nspawn`: `.nspawn` rendering, OCI
   bundles, machines targets and slices. `.nspawn.sh`.
5. **Networking.** `docker-network-to-networkd`: zone bridges with IPAM,
   static leases, vxlan over wireguard, macvlan, sockets and port policy,
   resolved and DNS-SD. The two `80-container-*` files and the
   `25-container-*` fixtures. `.networkd.sh`, `.dnssd.sh`.
6. **Storage, configs, extensions.** `docker-volume-to-systemd` and
   `docker-image-to-sysext`: mounts, tmpfiles, repart, confext, sysext.
   `.sysext.sh`.
7. **Portable, capsule, vmspawn.** `docker-service-to-portable` and
   `docker-container-to-vmspawn`. `.portable.sh`, `.capsule.sh`, `.vmspawn.sh`.
8. **Harness.** Roles, policy, worker unit, and the verifier's host subset.

Phases 3 to 7 are independent of each other once phase 2 exists, so they can
proceed in parallel branches that each carry their own subtest.

## 8. Decisions still open

These change the shape of the work and are recorded here so the answer can be
applied when it arrives.

1. Plugin granularity: the ten-plugin layout above, one plugin per pair (about
   thirty plugins with heavy duplication), or a single plugin with thirty
   skills. The plan assumes the ten-plugin layout.
2. Whether the networkd verification may add a test case class to
   `test/test-network/systemd-networkd-tests.py`, which is Python, or must stay
   in the shell subtest that copies the same fixtures. The plan assumes shell
   only, with the fixtures placed where the Python suite could pick them up.
3. Whether the tree additions in section 4 are meant to reach upstream
   systemd eventually, which decides how conservative the `network/` and
   `docs/` changes should be. The plan assumes they are written to upstream
   standards but land in this fork first.
4. Whether pull request 1 merges as it stands before the restructure begins
   in a new pull request per phase, or the branch keeps growing. The plan
   assumes a merge first, since the restructure renames what that pull request
   adds.
5. The minimum systemd and kernel versions on the target hosts. The plan
   assumes systemd 261 and a kernel of 6.13 or later, which the mount stack
   features require; older hosts fall back to `RootImage=` with DDIs built by
   `systemd-repart`.

## 9. Status

Phase 1 is complete on the `claude/swarm-to-systemd-agent-gcqvex` branch: the
marketplace is `systemd-dev-plugins`, the first-generation plugin is split into
`docker-swarm-to-systemd`, `podman-container-to-quadlet`, and
`systemd-migration-harness`, the inventory contract lives under
`docker-swarm-to-systemd/contract/` and is vendored by
`plugins/scripts/sync-contract.sh` with a drift test in the harness suite, and
the existing tests pass. The open decisions in section 8 were resolved as the
plan assumed, pending any correction: the ten-plugin layout, shell-only
verification, upstream-standard tree changes landing in this fork, and systemd
261 with kernel 6.13 as the target floor. Decision 4 went the other way: the
restructure continues on the same branch and pull request rather than waiting
for a merge, so that the renames and the first-generation code are reviewed
together.
