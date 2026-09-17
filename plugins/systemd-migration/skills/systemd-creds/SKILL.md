---
name: systemd-creds
description: The credentials component. Every orchestrator secret and every environment value the capture redacted becomes a systemd credential the unit loads with LoadCredentialEncrypted= (or LoadCredential=), reachable under $CREDENTIALS_DIRECTORY and bound where the container saw it; where each value lives on the hosts is a decision in plan.yaml, and the rendered import-credentials.sh encrypts operator-supplied files with systemd-creds. Use this whenever the user asks about secrets on systemd, systemd-creds, credstore, LoadCredential, ImportCredential, how a service reads a password without a file in the unit, or how Swarm or Compose secrets move to systemd hosts.
---

# systemd-creds

A container secret is a file the runtime mounts at start; a systemd credential is the same thing done by the service manager, with encryption at rest, per-service visibility, and no value in any unit file or rendered tree. This component turns every secret and every redacted environment value into a credential and leaves the values to the operator.

## Decisions it raises

`creds.store.<name>` for each credential: `credstore.encrypted` (default; `systemd-creds encrypt` binds the value to the host's TPM or key, the unit uses `LoadCredentialEncrypted=`), `credstore` (a plain 0600 file, `LoadCredential=`), or `external` (nothing is loaded; the operator adds the fetch to the unit). A Podman Quadlet form uses Podman secrets instead and does not consult this decision.

## What it renders

- `LoadCredentialEncrypted=<name>:/etc/credstore.encrypted/<name>` (or `LoadCredential=`) on the service unit for every secret and every redacted environment variable, named `<service>-<variable>` for the latter.
- `BindReadOnlyPaths=%d/<name>:/run/secrets/<target>` so the file appears where the container read it.
- `Environment=<VAR>_FILE=%d/<name>` for a redacted variable; the process reads the file, as it would have with the `_FILE` convention.
- `secrets/import-credentials.sh` per host: reads one file per credential from `/etc/swarm-migration/secrets/` (operator-supplied, root-only), encrypts or installs it, and reports what is missing. Nothing prints a value.

## Reading the notes

A credential owned by a non-root user inside the container is noted: credentials are readable by the service's user, which is what the mode asked for. A credential the plan marks `external` is listed under "needs a human decision" until the fetch step exists in the unit.

## Files

- `scripts/component.ts`: the component module (decisions and rendering).
- See `../migration-planner/references/secrets-and-configs.md` for the operator side: gathering values from the old cluster, filling the secrets directory, and rotating after cutover.
