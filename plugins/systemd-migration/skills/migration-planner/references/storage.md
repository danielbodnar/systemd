# Moving storage

Data is the part of the migration that cannot be re-rendered. Plan every volume individually.

## Named volumes

Docker's `local` driver keeps volume data under `/var/lib/docker/volumes/<name>/_data`; Podman's default is `/var/lib/containers/storage/volumes/<name>/_data` (rootful). The rendered `.volume` unit keeps the Swarm name, so the target path is predictable. The safe sequence is: stop the Swarm service (`docker service scale name=0`, or remove the stack when the whole stack moves), copy with `rsync -aHAX --numeric-ids` from the Docker path to the Podman path on the target host, restore ownership to the uid and gid the container runs as, then start the unit. Copy while the service is running only for read-mostly data and then run a second `rsync` in the stop window to catch changes.

Volumes with driver options (`type=nfs`, `device=`) map to `Type=`, `Device=`, and `Options=` on the `.volume` unit; the data itself does not move, only the mount definition. Verify that the target host can mount the share before cutover.

Third-party volume plugins have no Podman equivalent; plan a copy into a local volume or a host bind mount and record the loss of whatever the plugin provided (replication, snapshots).

## Bind mounts

Bind mounts reference host paths that must exist on the target host with the right ownership. Copy the directory as for volumes, then confirm SELinux labels (`--selinux` on the renderer adds `Z` or `z`) or set `SecurityLabelDisable=true` for paths shared with the host.

## Databases

For database volumes prefer the database's own tooling to a file copy when the engine version changes: dump on the old side, restore on the new. When the version is identical, a file copy in a stop window is faster and preserves everything, including replication state. Either way, run the engine's consistency check (`pg_checksums`, `mysqlcheck`, or the equivalent) after the copy and before opening traffic.

## Verification

For each volume record the file count and byte size on both sides and a content hash of a sample; `systemd-verify` can run those checks when they are written as commands in the plan.
