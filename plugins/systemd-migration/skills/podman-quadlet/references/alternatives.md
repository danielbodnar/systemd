# When not to render a container

Quadlet is the default target because it preserves the container image, which is the one artifact the Swarm estate already trusts. Some workloads are better served by a different systemd primitive, and the renderer will happily produce a `.container` file that hides that. Check each service against these cases before accepting the rendered unit.

## Plain service unit

A service whose image only wraps a single static binary or a distribution package (a reverse proxy, an exporter, a scheduler) is often simpler as a native package plus a `.service` file with systemd's own sandboxing (`DynamicUser=`, `ProtectSystem=strict`, `PrivateTmp=`, `CapabilityBoundingSet=`). The result has no image to update, integrates with `systemd-creds` and `LoadCredential=` directly, and shows up in `systemd-analyze security` with a score. Choose this when the package exists in the target distribution at an acceptable version and the container added no configuration the package cannot express.

## systemd-nspawn container

Services that need a full OS userland (init scripts, cron, several cooperating daemons in one image, legacy software expecting a real filesystem) fit `systemd-nspawn` better than a single-process container. Convert the image to a directory tree or a discoverable disk image, register it with `machinectl`, and write an `.nspawn` file for networking and bind mounts. `machinectl` gives login, journal, and resource control per machine. Choose this when the compose file already ran an init system inside the container or used `privileged: true` to get one.

## Portable service

A portable service image (`portablectl attach`) carries its own unit files and root filesystem and is the right fit for vendor-delivered services that should be upgraded atomically and detached cleanly. It keeps the host's `/etc` untouched and lets `systemd-sysext` style layering apply. Choose this when the team wants the immutable, image-based deployment model without a container runtime on the host.

## systemd-vmspawn

Workloads that need kernel isolation (untrusted tenants, kernel modules, a different kernel version) belong in a VM, and `systemd-vmspawn` runs one from the same discoverable disk image conventions. Choose this only when isolation, not packaging, is the requirement; it costs memory and startup time.

## Deciding

For each service ask, in order: does a distribution package exist and suffice (plain unit); does the image run more than one supervised process (nspawn); is the vendor shipping images with their own units (portable); does the workload need its own kernel (vmspawn). Anything left stays a Quadlet container. Record the decision per service in the migration plan so the reasoning survives the person who made it.
