---
name: migration-planner
description: Produce the migration plan for moving a container estate (a multi-node Docker Swarm first; Podman next) onto systemd-native hosts. Two artifacts: plan.yaml, the list of every decision the systemd components need (the form each service takes, address ranges, overlay transports, published ports, name resolution, secret stores, data moves, image mounting per host) with options, evidence, defaults, and the values the user chooses; and MIGRATION-PLAN.md, the document with host mapping, networking, secrets, storage, cutover order with runbooks, rollback, and risks. Use this whenever the user asks how to migrate, decommission, or replace Docker Swarm or Compose, wants a cutover plan, runbook, rollback plan, host mapping, or risk assessment, asks what a decision in plan.yaml means, or asks what to do about overlay networks, the ingress routing mesh, secrets, volumes, or service discovery on systemd. It reads the inventory and the host probes and writes the plan; it does not touch hosts.
---

# Migration planning

Rendering units is mechanical once the decisions are made; making the decisions is the work. This skill owns three products, in the order they are produced.

## 1. plan.yaml: the decisions

`scripts/plan.ts` (at the plugin root) drafts `plan.yaml` from the inventory and the host probes. It asks every registered systemd component which decisions it needs, and it adds the engine's own: where each service is placed and which form it takes (plain service, machine, virtual machine, portable service, or a Podman Quadlet container). Each decision carries the component, the subject, the question, the options with their consequences and any host that cannot satisfy them, the evidence from the inventory, a default where one is defensible, and the chosen value. Decisions that must not be guessed have no default: an ingress-mode port (the routing mesh is gone), name resolution, how each volume's data moves, the transport of an unencrypted cross-host overlay, a shell healthcheck with control syntax.

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/plan.ts" inventory.json --hosts hosts/ -o plan.yaml
bun "${CLAUDE_PLUGIN_ROOT}/scripts/review.ts" plan.yaml              # what is open, unresolved first
bun "${CLAUDE_PLUGIN_ROOT}/scripts/review.ts" plan.yaml --set networkd.publish.web_app.8080-tcp=external-lb --reason "the site's HAProxy fronts it"
bun "${CLAUDE_PLUGIN_ROOT}/scripts/review.ts" plan.yaml --accept-defaults --component journald
bun "${CLAUDE_PLUGIN_ROOT}/scripts/review.ts" plan.yaml --status     # exit 0 only when nothing is unresolved
```

The guided review is a conversation: present each undefaulted decision with its options, consequences, and evidence, recommend one with a reason, and record what the user answers with `--set` and their reason. Then present the defaulted decisions grouped by component and accept them per group or change single entries. Never set a value the user did not give. `scripts/render.ts` refuses a plan with an unresolved decision and, without `--accept-defaults`, a plan with an unapproved one, so the file is the approval record. A re-run of `plan.ts` after the inventory or the hosts change keeps every earlier choice that still applies and reports the ones it dropped.

Push back with evidence when an answer creates a problem: a single-writer database placed on two hosts, an encrypted overlay routed in plaintext, a machine on a host without `systemd-nspawn`, a stack collapsed onto a host that lacks the memory the inventory shows. State the concern in one or two sentences, offer the alternative, then record what the user chooses.

## 2. The translation map

`scripts/plan-map.ts` writes `TRANSLATION-MAP.md` (a table per source concept with the evidence from the inventory, the directives and tools involved, an honest fidelity rating, and the minimum systemd version) and `translation-map.json` for the renderers, from the static map in `references/translation-map.json`. The script refuses to run if the static map names a directive that the catalogue (`contract/directives.json`, generated from this tree's man pages) does not document, so the map cannot drift from what systemd ships.

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/migration-planner/scripts/plan-map.ts" inventory.json -o . [--targets service,nspawn,networkd]
```

`--targets` restricts the map to the deployment forms under consideration; runbook rows are always kept. Its "needs a human decision" section is the same set of questions `plan.yaml` carries, in prose.

## 3. MIGRATION-PLAN.md: the runbook

The document a team executes, written to the migration directory with the fixed structure in `references/plan-template.md` so plans for different estates are comparable. Write it only when `review.ts --status` reports nothing open. Its "Decisions" section lists every plan decision that had no default, with the chosen value and the user's reason, and points at `plan.yaml` for the rest.

Work through the references in order and write each section as you go:

1. **Host mapping** from the placement decisions: every service with its host or hosts, its form, whether it bears state, and the reason.
2. **Networking** from the networkd and resolved decisions, with `references/networking.md`: the transport of every cross-host network, the subnet on each host, what replaces the ingress mesh, and how names resolve.
3. **Secrets and configs** from the creds and sysext decisions, with `references/secrets-and-configs.md`: every credential's store, source, importer, and rotation owner; every config's path and manager.
4. **Storage** from the storage decisions, with `references/storage.md`: every volume's move method, expected size, stop window, and ownership fix-up.
5. **Cutover order and runbook** with `references/cutover-runbook.md`: leaf services first, shared databases last, edge proxies at the very end when DNS or the load balancer flips; each stack gets a preflight, a cutover, a verification (delegated to `systemd-verify`), and a rollback step with a named trigger.
6. **Risks**: one row per rendered note and capture warning still open, with an owner and a mitigation.

Keep the prose short and the tables complete. A plan a reviewer can verify against the inventory and `plan.yaml` is worth more than one that reads well.

## Files

- `../../scripts/plan.ts`, `review.ts`, `render.ts`: the drivers (plugin root).
- `scripts/plan-map.ts`: the estate's translation map; importable (`buildPlan`, `selectConcepts`, `validateMap`, `renderMarkdown`) and runnable; `--check` validates the static map alone.
- `scripts/build-catalog.ts`: regenerates `contract/directives.json` and `contract/surface.json` from a systemd checkout's `man/` directory (`--man DIR`); run it when the tree moves to a new version.
- `references/translation-map.json`: the static map, one row per source concept with every candidate target, its directives, tools, fidelity, and how it is expressed; the source of `docs/MIGRATING_CONTAINERS_TO_SYSTEMD.md` in the systemd tree.
- `references/plan-template.md`: the fixed section structure of `MIGRATION-PLAN.md` with guidance under each heading.
- `references/networking.md`, `references/secrets-and-configs.md`, `references/storage.md`, `references/cutover-runbook.md`: the reasoning behind the options each component offers, and the operator procedures the runbook needs.
