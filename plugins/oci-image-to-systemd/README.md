# oci-image-to-systemd

The native target of the `systemd-dev-plugins` migration set: container images run as ordinary systemd services, with the image mounted as the service's root and no container runtime in between. Three skills carry it.

| Skill | Purpose | Ships |
|---|---|---|
| `oci-image-to-mstack` | Pull every image an estate uses into a mount stack (`NAME.mstack/`) with `importctl pull-oci`, pinned and versioned | `pull-images.sh`, the mount stack layout reference |
| `oci-image-to-ddi` | Pack a mount stack into a discoverable disk image for hosts older than systemd 260 or kernels older than 6.13, mounted with `RootImage=` | `make-ddi.sh`, a `repart.d` definition |
| `docker-image-to-service` | Render the inventory into per-host `.service` units with `RootMStack=`, stack targets and slices, health timers, encrypted credentials, mounts, tmpfiles, sysctl fragments, and install scripts, with notes for every lossy translation | `render.ts`, the directive map, an example unit |

`contract/` is a vendored copy of the inventory contract and directive catalogue from `docker-swarm-to-systemd`; do not edit it here. Every unit the renderer writes is checked against the catalogue in the test suite, so nothing this tree does not document reaches a host.

The `native-unit-author` subagent renders and resolves the notes; `/swarm-render-native` runs it from a project directory against `inventory.json` under the shared `inventory_dir`.

```
/plugin install oci-image-to-systemd@systemd-dev-plugins
/swarm-render-native --host-map .swarm-migration/host-map.json
```

Requirements: Bun 1.3 or later to render; systemd 260 or later and a kernel of 6.13 or later on the target hosts for mount stacks with a writable layer (the DDI skill covers older hosts); `systemd-creds` on each host for the credentials.
