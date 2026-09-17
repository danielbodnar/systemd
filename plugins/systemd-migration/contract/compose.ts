// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The compose engine: builds a plan from every component's decisions, and
// renders every host's tree by running the components in dependency order
// against a shared render context. scripts/plan.ts and scripts/render.ts
// are thin CLIs over the two functions here; the systemd-service skill's
// render.ts wraps them for callers that want the old one-call renderer.

import { join } from "node:path";
import { placeService } from "./placement.ts";
import type { Inventory, Service } from "./types.ts";
import { type Component, type DecisionSpec, type HostExpectation, type ImageEntry, type Instance, PlanContext, RenderContext } from "./component.ts";
import { type Decision, type HostCapabilities, type Plan, decisionValue, mergePlans, requirementsMet, splitList, unresolvedDecisions } from "./plan.ts";
import { isPlainName, shellQuote, unitBaseName } from "./unit.ts";

export const ENGINE = "systemd-migration";

/** Decision ids the engine itself owns. */
export const PLACEMENT_SCALE_OUT = "placement.scale_out.estate";
export function placementId(service: string): string {
  return `placement.hosts.${service}`;
}
export function formId(service: string): string {
  return `form.service.${service}`;
}

/** The rendering forms a service can take; components claim one each. */
export const FORMS: Record<string, { label: string; consequence: string; component: string; requires?: { systemd?: number; tools?: string[] } }> = {
  service: { label: "plain service", consequence: "a .service unit whose root is the image; shares the host's network namespace", component: "service" },
  machine: { label: "machine (systemd-nspawn)", consequence: "a .nspawn file and systemd-nspawn@.service; own PID and network namespace, an address on a bridge", component: "machined", requires: { tools: ["systemd-nspawn"] } },
  vm: { label: "virtual machine (systemd-vmspawn)", consequence: "a bootable DDI run by systemd-vmspawn@.service; separate kernel", component: "machined", requires: { tools: ["systemd-vmspawn"] } },
  portable: { label: "portable service", consequence: "an image under /var/lib/portables attached with portablectl", component: "portable", requires: { tools: ["portablectl"] } },
  quadlet: { label: "Podman Quadlet container", consequence: "a .container file for Podman's generator; Podman stays on the host", component: "quadlet", requires: { tools: ["podman"] } },
};

export interface ComposePlanOptions {
  hosts?: Record<string, HostCapabilities | null>;
  existing?: Plan | null;
  generatedBy?: string;
}

/** Placement for every service: from the plan's placement decisions when resolvable, else the inventory's own scheduling. */
export function computePlacement(inv: Inventory, plan: Plan | null, hosts: string[], acceptDefaults: boolean, notes: string[] = []): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const scaleOut = plan ? decisionValueOr(plan, PLACEMENT_SCALE_OUT, acceptDefaults, "no") === "yes" : false;
  const nodes = inv.nodes.filter((n) => hosts.includes(n.hostname));
  for (const svc of inv.services) {
    const explicit = plan ? decisionValueOr(plan, placementId(svc.name), acceptDefaults, null) : null;
    if (explicit !== null) {
      const m = new Map<string, number>();
      for (const h of splitList(explicit)) m.set(h, (m.get(h) ?? 0) + 1);
      out.set(svc.name, m);
      continue;
    }
    out.set(svc.name, placeService(svc, nodes.length ? nodes : inv.nodes, { scaleOut }, notes));
  }
  return out;
}

function decisionValueOr(plan: Plan, id: string, acceptDefaults: boolean, fallback: string | null): string | null {
  try {
    return decisionValue(plan, id, acceptDefaults);
  } catch {
    return fallback;
  }
}

/** Build the plan: the engine's own decisions (placement, form) plus every component's. */
export function composePlan(inv: Inventory, components: Component[], opts: ComposePlanOptions = {}): { plan: Plan; dropped: string[] } {
  validateNames(inv);
  const hosts = opts.hosts ?? {};
  const ctx = new PlanContext(inv, hosts, opts.existing ?? null);
  const hostNames = ctx.hostNames;
  const notes: string[] = [];
  const seedPlan: Plan = { version: 1, generated_at: "", generated_by: "", inventory: { captured_at: inv.captured_at, services: 0, networks: 0, nodes: 0 }, hosts, decisions: [] };
  // Placement first: the components reason about where things land.
  const engineDecisions: Decision[] = [];
  engineDecisions.push({
    id: PLACEMENT_SCALE_OUT,
    component: "placement",
    kind: "choice",
    subject: { kind: "estate", name: "estate" },
    question: "When a replicated service wants more replicas than there are eligible hosts, render numbered instances on the same host?",
    options: [
      { value: "no", label: "one instance per host", consequence: "replicas beyond the eligible hosts are dropped and noted; capacity comes from more hosts" },
      { value: "yes", label: "scale out on a host", consequence: "numbered units (name-1, name-2) with offset published ports on one host" },
    ],
    default: "no",
    chosen: ctx.previous(PLACEMENT_SCALE_OUT),
  });
  const scaleOut = (ctx.previous(PLACEMENT_SCALE_OUT) ?? "no") === "yes";
  for (const svc of sortedServices(inv)) {
    const placementNotes: string[] = [];
    const computed = placeService(svc, inv.nodes.filter((n) => hostNames.includes(n.hostname)).length ? inv.nodes.filter((n) => hostNames.includes(n.hostname)) : inv.nodes, { scaleOut }, placementNotes);
    const suggested = [...computed].flatMap(([h, n]) => Array(n).fill(h) as string[]).join(",");
    const previous = ctx.previous(placementId(svc.name));
    engineDecisions.push({
      id: placementId(svc.name),
      component: "placement",
      kind: "value",
      format: "hosts",
      subject: { kind: "service", name: svc.name },
      question: `Which target hosts run ${svc.name} (mode ${svc.mode}${svc.replicas != null ? `, ${svc.replicas} replicas` : ""})? List a host once per instance.`,
      default: suggested || null,
      chosen: previous,
      evidence: [`services[${svc.name}].mode`, `services[${svc.name}].placement`, ...(svc.tasks.filter((t) => t.desired_state === "running").map((t) => `services[${svc.name}].tasks[node=${t.node}]`)), ...placementNotes],
    });
    const chosenHosts = previous ? splitList(previous) : [...computed].flatMap(([h, n]) => Array(n).fill(h) as string[]);
    const m = new Map<string, number>();
    for (const h of chosenHosts) m.set(h, (m.get(h) ?? 0) + 1);
    ctx.placement.set(svc.name, m);
  }
  // Form: which component expresses each service; components may require host tools.
  const available = new Set(components.map((c) => c.id));
  for (const svc of sortedServices(inv)) {
    const options = Object.entries(FORMS)
      .filter(([, f]) => available.has(f.component))
      .map(([value, f]) => ({ value, label: f.label, consequence: f.consequence, requires: f.requires }));
    const initImage = /systemd|init/.test(svc.image) && !svc.init;
    engineDecisions.push({
      id: formId(svc.name),
      component: "form",
      kind: "choice",
      subject: { kind: "service", name: svc.name },
      question: `How does ${svc.name} run on systemd?`,
      options,
      default: initImage ? "machine" : "service",
      chosen: ctx.previous(formId(svc.name)),
      evidence: [`services[${svc.name}].image=${svc.image}`, ...(svc.hostname ? [`services[${svc.name}].hostname=${svc.hostname}`] : []), ...(initImage ? ["image name suggests an init system"] : [])],
    });
  }
  const decisions: Decision[] = [...engineDecisions];
  for (const c of components) {
    for (const spec of c.decide(ctx)) {
      if (!spec.id.startsWith(`${c.id}.`)) throw new Error(`component ${c.id} raised decision ${spec.id}; ids must start with "${c.id}."`);
      if (decisions.some((d) => d.id === spec.id)) throw new Error(`duplicate decision ${spec.id}`);
      decisions.push({ ...spec, component: c.id, chosen: spec.chosen ?? ctx.previous(spec.id) });
    }
  }
  // Options a host cannot satisfy are noted on the decision, not silently dropped.
  for (const d of decisions) {
    if (!d.options) continue;
    const affected = d.hosts ?? (d.subject.kind === "service" ? ctx.hostsOf(d.subject.name) : hostNames);
    for (const o of d.options) {
      if (!o.requires) continue;
      const failing = affected.filter((h) => !requirementsMet(o.requires, hosts[h] ?? null).ok);
      if (failing.length) o.consequence = `${o.consequence ?? ""} [not available on ${failing.join(", ")}: ${failing.map((h) => requirementsMet(o.requires, hosts[h] ?? null).missing.join(", ")).join("; ")}]`.trim();
    }
  }
  const fresh: Plan = {
    ...seedPlan,
    generated_at: new Date().toISOString(),
    generated_by: opts.generatedBy ?? `${ENGINE} plan.ts`,
    inventory: { captured_at: inv.captured_at, services: inv.services.length, networks: inv.networks.length, nodes: inv.nodes.length },
    decisions,
  };
  void notes;
  return mergePlans(fresh, opts.existing ?? null);
}

export interface RenderResult {
  files: Record<string, string | Uint8Array>;
  hosts: Record<string, HostExpectation>;
  images: Record<string, ImageEntry>;
  notes: string[];
  decisions: string[];
}

export interface ComposeRenderOptions {
  acceptDefaults?: boolean;
  /** Only these hosts; default every host the placement names. */
  hosts?: string[];
  rendererName?: string;
}

/** Render every host by composing the components the plan selects. Throws while any needed decision is unresolved. */
export function composeRender(inv: Inventory, plan: Plan, components: Component[], opts: ComposeRenderOptions = {}): RenderResult {
  validateNames(inv);
  const acceptDefaults = opts.acceptDefaults ?? false;
  const pending = unresolvedDecisions(plan);
  if (pending.length) throw new Error(`the plan has ${pending.length} unresolved decision(s); run review.ts (first: ${pending[0]!.id})`);
  if (!acceptDefaults) {
    const open = plan.decisions.filter((d) => d.chosen == null);
    if (open.length) throw new Error(`${open.length} decision(s) still rely on their default; approve them with review.ts or pass --accept-defaults (first: ${open[0]!.id})`);
  }
  const ordered = orderComponents(components);
  const hostNames = Object.keys(plan.hosts).length ? Object.keys(plan.hosts) : inv.nodes.map((n) => n.hostname);
  const placement = computePlacement(inv, plan, hostNames, acceptDefaults);
  const byHost = new Map<string, Instance[]>();
  for (const svc of sortedServices(inv)) {
    const form = decisionValue(plan, formId(svc.name), acceptDefaults);
    for (const [host, count] of placement.get(svc.name) ?? []) {
      const list = byHost.get(host) ?? [];
      byHost.set(host, list);
      for (let i = 1; i <= count; i++) {
        const base = unitBaseName(svc.name, i, count);
        list.push({ service: svc, stack: svc.stack ?? "nostack", index: i, count, base, unit: unitFor(form, base), form });
      }
    }
  }
  const files: Record<string, string | Uint8Array> = {};
  const hosts: Record<string, HostExpectation> = {};
  const images: Record<string, ImageEntry> = {};
  const notes = new Set<string>();
  const decisions = new Set<string>();
  const wanted = opts.hosts ? new Set(opts.hosts) : null;
  for (const host of [...byHost.keys()].sort()) {
    if (wanted && !wanted.has(host)) continue;
    if (!isPlainName(host)) throw new Error(`hostname ${JSON.stringify(host)} cannot be used in script paths`);
    const ctx = new RenderContext(inv, plan, host, plan.hosts[host] ?? null, byHost.get(host)!, acceptDefaults, opts.rendererName ?? ENGINE);
    for (const c of ordered) c.render(ctx);
    for (const c of ordered) c.finish?.(ctx);
    finishHost(ctx);
    for (const [rel, f] of ctx.files) files[join("hosts", host, rel)] = f.content;
    for (const { path, unit } of ctx.unitFiles()) files[join("hosts", host, path)] = unit.render();
    hosts[host] = ctx.expected;
    for (const [name, e] of ctx.images) {
      const merged = (images[name] ??= { ref: e.ref, digest: e.digest, hosts: [], services: [] });
      if (merged.ref !== e.ref) notes.add(`image name ${name}: ${e.ref} and ${merged.ref} both map to it; pull one under another name`);
      if (!merged.digest && e.digest) merged.digest = e.digest;
      for (const h of e.hosts) if (!merged.hosts.includes(h)) merged.hosts.push(h);
      for (const s of e.services) if (!merged.services.includes(s)) merged.services.push(s);
    }
    for (const n of ctx.notes) (n.kind === "decision" ? decisions : notes).add(n.text);
  }
  // A decision resolved without review (the one-call renderer marks them) is still a decision.
  for (const d of plan.decisions) if (d.reason?.startsWith("auto:")) decisions.add(`decision ${d.id} took "${d.chosen}" without review: ${d.question}`);
  const sortedImages = Object.fromEntries(Object.entries(images).sort());
  files["images.json"] = JSON.stringify(sortedImages, null, 2) + "\n";
  files["expected.json"] = JSON.stringify(hosts, null, 2) + "\n";
  files["MIGRATION-NOTES.md"] = notesDocument(inv, plan, hosts, sortedImages, [...decisions], [...notes], ordered);
  return { files, hosts, images: sortedImages, notes: [...notes, ...decisions], decisions: [...decisions] };
}

function unitFor(form: string, base: string): string {
  switch (form) {
    case "machine":
      return `systemd-nspawn@${base}.service`;
    case "vm":
      return `systemd-vmspawn@${base}.service`;
    default:
      return `${base}.service`;
  }
}

/** Per-host finishing the engine owns: expected.json and install.sh from what the components registered. */
function finishHost(ctx: RenderContext): void {
  const e = ctx.expected;
  e.units.sort();
  e.targets.sort();
  e.slices.sort();
  e.timers.sort();
  e.mounts.sort();
  e.credentials.sort();
  ctx.file("expected.json", JSON.stringify(e, null, 2) + "\n");
  const units = [...e.units, ...e.timers, ...e.mounts, ...e.sockets, ...e.targets, ...e.slices].filter((u) => ctx.hasUnit(u));
  ctx.file(
    "install.sh",
    [
      "#!/usr/bin/env bash",
      "# SPDX-License-Identifier: LGPL-2.1-or-later",
      `# Rendered by ${ctx.rendererName} for ${ctx.host}. Copies the rendered tree into place,`,
      "# runs each component's install steps, reloads the manager, verifies the",
      "# units, and optionally starts the stack targets. Pull the images first",
      "# (pull-images.sh) and import the credentials (secrets/import-credentials.sh).",
      "set -euo pipefail",
      'here="$(cd "$(dirname "$0")" && pwd)"',
      '[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }',
      `[ "$(hostname)" = ${shellQuote(ctx.host)} ] || echo "warning: this tree was rendered for ${ctx.host}, not $(hostname)" >&2`,
      ...(e.images.length ? [`for image in ${e.images.map(shellQuote).join(" ")}; do`, '    [ -e "$image" ] || echo "warning: $image is not present; run pull-images.sh" >&2', "done"] : []),
      'cp -a "$here/etc/." /etc/',
      ...ctx.installLines("pre"),
      "systemctl daemon-reload",
      ...ctx.installLines("post"),
      ...(units.length ? [`systemd-analyze verify ${units.map((u) => shellQuote(`/etc/systemd/system/${u}`)).join(" ")}`] : []),
      'if [ "${1:-}" = "--start" ]; then',
      `    systemctl enable --now ${e.targets.map(shellQuote).join(" ")}`,
      "else",
      `    echo "installed; start with: systemctl enable --now ${e.targets.join(" ")}"`,
      "fi",
      "",
    ].join("\n"),
  );
}

function notesDocument(inv: Inventory, plan: Plan, hosts: Record<string, HostExpectation>, images: Record<string, ImageEntry>, decisions: string[], notes: string[], components: Component[]): string {
  const lines: string[] = [];
  lines.push("# Migration notes");
  lines.push("");
  lines.push(`Rendered by ${ENGINE} from an inventory captured ${inv.captured_at} (${inv.services.length} services, ${inv.nodes.length} nodes) against a plan of ${plan.decisions.length} decisions (${plan.decisions.filter((d) => d.chosen != null).length} chosen). Components composed, in order: ${components.map((c) => c.id).join(", ")}.`);
  lines.push("");
  lines.push("## Host plan");
  lines.push("");
  lines.push("| Host | Units | Timers | Mounts | Machines | Ports | Credentials | Images |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const h of Object.values(hosts).sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    lines.push(`| ${h.hostname} | ${h.units.filter((u) => !u.endsWith("-health.service") && !u.endsWith("-restart.service")).join(", ")} | ${h.timers.length} | ${h.mounts.length} | ${h.machines.length} | ${h.ports.map((p) => `${p.port}/${p.protocol}`).join(", ") || "none"} | ${h.credentials.length} | ${h.images.length} |`);
  }
  lines.push("");
  lines.push("## Images to pull");
  lines.push("");
  lines.push("| Local name | Reference | Digest recorded by the source | Hosts |");
  lines.push("|---|---|---|---|");
  for (const [name, e] of Object.entries(images)) lines.push(`| ${name} | ${e.ref} | ${e.digest ?? "none (tag not pinned)"} | ${e.hosts.join(", ")} |`);
  lines.push("");
  lines.push("`images.json` next to this file drives `pull-images.sh` from the systemd-machined skill.");
  lines.push("");
  lines.push("## Needs a human decision");
  lines.push("");
  if (decisions.length === 0) lines.push("None.");
  for (const n of decisions) lines.push(`- ${n}`);
  lines.push("");
  lines.push("## Translations to review");
  lines.push("");
  if (notes.length === 0) lines.push("None.");
  for (const n of notes) lines.push(`- ${n}`);
  lines.push("");
  lines.push("## Carried over from the capture");
  lines.push("");
  if (inv.warnings.length === 0) lines.push("None.");
  for (const w of inv.warnings) lines.push(`- ${w}`);
  lines.push("");
  return lines.join("\n");
}

/** Topological order by `after`, stable for the registry order otherwise. */
export function orderComponents(components: Component[]): Component[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const out: Component[] = [];
  const visiting = new Set<string>();
  const visit = (c: Component) => {
    if (out.includes(c)) return;
    if (visiting.has(c.id)) throw new Error(`component dependency cycle at ${c.id}`);
    visiting.add(c.id);
    for (const dep of c.after ?? []) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    visiting.delete(c.id);
    out.push(c);
  };
  for (const c of components) visit(c);
  return out;
}

function sortedServices(inv: Inventory): Service[] {
  return [...inv.services].sort((a, b) => a.name.localeCompare(b.name));
}

/** Names end up in unit names and in install scripts that run as root; refuse anything that is not plain. */
export function validateNames(inv: Inventory): void {
  for (const s of inv.services) if (!isPlainName(s.name)) throw new Error(`service name ${JSON.stringify(s.name)} cannot be used in unit and script names`);
  for (const n of inv.nodes) if (!isPlainName(n.hostname)) throw new Error(`hostname ${JSON.stringify(n.hostname)} cannot be used in script paths`);
  for (const v of inv.volumes) if (!isPlainName(v.name)) throw new Error(`volume name ${JSON.stringify(v.name)} cannot be used in paths`);
  for (const c of inv.configs) if (!isPlainName(c.name)) throw new Error(`config name ${JSON.stringify(c.name)} cannot be used in paths`);
  for (const s of inv.secrets) if (!isPlainName(s.name)) throw new Error(`secret name ${JSON.stringify(s.name)} cannot be used as a credential name`);
  for (const st of inv.stacks) if (!isPlainName(st.name)) throw new Error(`stack name ${JSON.stringify(st.name)} cannot be used in unit names`);
}

export type { DecisionSpec };
