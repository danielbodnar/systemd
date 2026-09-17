<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# test-container-migration

A fixture estate for the container migration tooling under `plugins/` and its integration test: a two-node Docker Swarm (one manager, one worker) running two stacks.

- `capture/` is what `docker-swarm-to-inventory/scripts/capture.sh` writes on a manager: `raw/*.json` from `docker ... inspect`, `raw/tasks.jsonl` from `docker service ps`, and `manifest.json`. Secret values are never captured; the one credential-looking environment value is the literal placeholder `fixture-placeholder-not-a-secret`.
- `capture/compose/` holds the compose files the stacks were deployed from, for the `depends_on` and profile information the Swarm API does not expose.

The `web` stack has a global edge proxy publishing port 80 in host mode and a replicated application publishing through the ingress mesh, with a secret, a config, a tmpfs, a named volume, a healthcheck, resource limits, an update policy, and an encrypted overlay. The `data` stack has a single PostgreSQL instance pinned by node label with a local volume, an NFS volume, a bind mount, a secret shared with an exporter, an internal encrypted overlay that spans no host boundary, and a macvlan network. One task is in the failed state and one image is not pinned by digest, so the normalizer's warnings are exercised.

The harness test suite (`plugins/systemd-migration-harness/harness`) normalizes and renders this capture; the integration test renders it on a booted image and starts what it rendered.
