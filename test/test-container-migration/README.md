<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# test-container-migration

A fixture estate for the container migration tooling under `plugins/` and its integration test: a two-node Docker Swarm (one manager, one worker) running two stacks.

- `capture/` is what the `discover-docker-swarm` skill's `capture.sh` writes on a manager: `raw/*.json` from `docker ... inspect`, `raw/tasks.jsonl` from `docker service ps`, and `manifest.json`. Secret values are never captured; the one credential-looking environment value is the literal placeholder `fixture-placeholder-not-a-secret`.
- `capture/compose/` holds the compose files the stacks were deployed from, for the `depends_on` and profile information the Swarm API does not expose.

The `web` stack has a global edge proxy publishing port 80 in host mode and a replicated application publishing through the ingress mesh, with a secret, a config, a tmpfs, a named volume, a healthcheck, resource limits, an update policy, and an encrypted overlay. The `data` stack has a single PostgreSQL instance pinned by node label with a local volume, an NFS volume, a bind mount, a secret shared with an exporter, an internal encrypted overlay that spans no host boundary, and a macvlan network. One task is in the failed state and one image is not pinned by digest, so the normalizer's warnings are exercised.

The harness test suite (`plugins/systemd-migration/harness`) normalizes and renders this capture; the integration test checks the committed inventory and rendered tree on a booted image, starts what was rendered, and runs the plugin's host probe and verifier (`probe.sh` and `verify.sh`, installed next to the fixtures by `test/meson.build`).

`rendered/native/` is the estate rendered with every service as a plain service; `rendered/machine/` is the same estate rendered from `plan-machine.yaml`, a committed, fully reviewed plan that runs `web_app` as a machine (`systemd-nspawn@web_app.service` with a `.nspawn` file), so the nspawn subtest can start it. `plugins/scripts/render-fixtures.sh` regenerates both trees; the plan was drafted with `plan.ts` and `review.ts`, and its `generated_at` is pinned so the file is deterministic. When a component gains a decision, refresh the plan in place (`plan.ts inventory.json -o plan-machine.yaml` keeps the choices and adds the new decisions, then `review.ts plan-machine.yaml --accept-defaults`), pin `generated_at` to `2026-09-01T12:00:00Z` again, and re-render.
