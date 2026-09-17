# Secrets and configs

Swarm distributed secrets from the Raft store and mounted them as tmpfs files; configs travelled the same way. Neither mechanism exists on a systemd host, and the capture deliberately never contains secret values, so the plan must name a source for every secret before the first unit starts.

## Podman secrets (default)

The rendered units reference Podman secrets by name (`Secret=name,type=mount,...` for file secrets, `Secret=name,type=env,...` for redacted environment values), and each host's `secrets/import-secrets.sh` creates them with `podman secret create --replace` from files under `secrets/values/`. Podman stores secrets in its own driver (file-backed by default, `shell` and `pass` drivers exist) and mounts them into the container at start. This is the least surprising path for a team that already thinks in Docker secrets.

Feed the values from wherever they live today: a password manager CLI (`op read`, `bw get`), an external secret manager, or an operator typing them once. Never commit `secrets/values/` and never let the migration agent read values in a session whose transcript is stored; an agent should run the import script, not inspect its inputs.

## systemd credentials

For secrets that belong to the host rather than the container (a WireGuard private key, a registry login, the Managed Agents environment key used by the harness), use systemd's credential mechanism. `systemd-creds encrypt` produces a file bound to the host's TPM or a host key; `LoadCredentialEncrypted=` in a unit decrypts it into `$CREDENTIALS_DIRECTORY` for that service only. Quadlet passes `[Service]` keys through, so a `.container` file can carry `LoadCredentialEncrypted=` and the container can read `/run/credentials/<unit>/<name>` when the directory is bind-mounted with `Volume=%d:/run/credentials:ro` (recent Quadlet versions expose the credentials directory specifier; verify on the target Podman version, and fall back to `Secret=` when in doubt).

Use `systemd-creds` for host secrets and Podman secrets for container secrets; mixing the two per secret is fine, mixing them per unit is confusing.

## Configs

Swarm configs are non-sensitive by definition, so the renderer writes their payloads to `/etc/containers/swarm-configs/<name>` and mounts them read-only. Treat those files as ordinary configuration from that point: own them in the configuration management tool the team already uses, and reload the consuming unit (`systemctl restart`, or `ReloadCmd=` in the `.container` when the process supports a reload signal) after a change. Swarm's config rotation (create `name-v2`, update the service) has no equivalent because a file edit plus restart is simpler.

## Rotation

Podman secrets are immutable once created; rotation is `podman secret create --replace` followed by a restart of the consuming units. Record the rotation owner and the restart command per secret in the plan so rotation does not become a research project later.
