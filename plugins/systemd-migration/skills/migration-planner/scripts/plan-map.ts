#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Build the translation map for one estate.
//
// The static map (references/translation-map.json) lists every Docker and
// Swarm concept with the systemd targets that can express it. This script
// reads an inventory, keeps the rows the estate actually needs with the
// evidence for each, validates every directive and tool the rows name
// against the directive catalogue, and writes TRANSLATION-MAP.md for people
// and translation-map.json for the renderers.
//
//   bun plan-map.ts inventory.json [-o DIR] [--targets service,nspawn,...]
//   bun plan-map.ts --check            validate the static map only
//
// Importable: selectConcepts(inventory, map), validateMap(map, catalog),
// renderMarkdown(plan).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Inventory, Service } from "../../../contract/types.ts";
import { type Catalog, type FileType, directive, loadCatalog, toolOption } from "../../../contract/catalog.ts";

export type Fidelity = "exact" | "equivalent" | "partial" | "manual";

export interface DirectiveRef {
  file: FileType | "os-release" | "tmpfiles.d" | "sysusers.d";
  section: string;
  name: string;
}

export interface ToolRef {
  tool: string;
  name: string;
}

export interface LineTypeRef {
  file: "tmpfiles.d" | "sysusers.d";
  name: string;
}

export interface Target {
  target: string;
  fidelity: Fidelity;
  /** The systemd version the row requires for reasons the catalogue cannot see (a kernel feature, a tool verb); the effective version is the maximum of this and every directive's own. */
  since?: number;
  needs?: string[];
  directives: DirectiveRef[];
  tools?: ToolRef[];
  line_types?: LineTypeRef[];
  how: string;
}

export interface Concept {
  id: string;
  concept: string;
  source: string[];
  applies_when: string;
  note?: string;
  targets: Target[];
}

export interface TranslationMap {
  version: number;
  description: string;
  minimum: { systemd: number; kernel: string };
  fidelity_levels: Record<Fidelity, string>;
  targets: Record<string, string>;
  concepts: Concept[];
}

export interface ResolvedTarget extends Target {
  /** The systemd version this target needs, computed from the catalogue and the row's own floor. */
  since: number;
}

export interface SelectedConcept extends Omit<Concept, "targets"> {
  targets: ResolvedTarget[];
  /** Service, network, volume, or node names that make the row apply; empty for rows that always apply. */
  evidence: string[];
  /** True when the best available target is partial or manual, so the plan must record a decision. */
  decision_needed: boolean;
}

export interface Plan {
  generated_by: string;
  systemd_catalogue: string;
  inventory: { captured_at: string; nodes: number; stacks: number; services: number; networks: number; volumes: number };
  minimum: { systemd: number; kernel: string };
  /** The highest "added in version" among every selected target. */
  minimum_version_required: number;
  targets_considered: string[];
  concepts: SelectedConcept[];
}

/** The predicates a concept's applies_when may name, each returning the evidence for the row. */
const PREDICATES: Record<string, (inv: Inventory) => string[] | true> = {
  always: () => true,
  has_init_images: (inv) => names(inv.services.filter((s) => /systemd|init/.test(s.image) && !s.init)),
  has_multi_replica_or_global: (inv) => names(inv.services.filter((s) => s.mode === "global" || (s.replicas ?? 1) > 1)),
  has_stacks: (inv) => inv.stacks.map((s) => s.name),
  has_placement: (inv) => names(inv.services.filter((s) => s.placement.constraints.length > 0 || s.placement.preferences.length > 0 || s.placement.platforms.length > 0)),
  has_healthchecks: (inv) => names(inv.services.filter((s) => s.healthcheck !== null)),
  has_update_config: (inv) => names(inv.services.filter((s) => s.update_config !== null || s.rollback_config !== null)),
  has_resources: (inv) =>
    names(inv.services.filter((s) => Object.values(s.resources.limits).some((v) => v !== null) || Object.values(s.resources.reservations).some((v) => v !== null))),
  has_security_settings: (inv) => names(inv.services.filter((s) => s.privileged || s.cap_add.length > 0 || s.cap_drop.length > 0)),
  has_ulimits_or_sysctls: (inv) => names(inv.services.filter((s) => s.ulimits.length > 0 || Object.keys(s.sysctls).length > 0)),
  has_devices: (inv) => names(inv.services.filter((s) => s.mounts.some((m) => m.type === "bind" && (m.source ?? "").startsWith("/dev/")))),
  has_secrets: (inv) => names(inv.services.filter((s) => s.secrets.length > 0 || s.redacted_env.length > 0)),
  has_configs: (inv) => names(inv.services.filter((s) => s.configs.length > 0)),
  has_host_ports: (inv) => names(inv.services.filter((s) => s.ports.some((p) => p.mode === "host"))),
  has_ingress_ports: (inv) => names(inv.services.filter((s) => s.ports.some((p) => p.mode === "ingress"))),
  has_single_host_overlay: (inv) => inv.networks.filter((n) => n.driver === "overlay" && !n.ingress && hostsOf(inv, n.used_by).length <= 1).map((n) => n.name),
  has_multi_host_overlay: (inv) => inv.networks.filter((n) => n.driver === "overlay" && !n.ingress && hostsOf(inv, n.used_by).length > 1).map((n) => n.name),
  has_macvlan: (inv) => inv.networks.filter((n) => n.driver === "macvlan" || n.driver === "ipvlan").map((n) => n.name),
  has_host_network: (inv) => names(inv.services.filter((s) => s.networks.some((n) => n.name === "host"))),
  has_aliases: (inv) => names(inv.services.filter((s) => s.networks.some((n) => n.aliases.length > 0) || s.endpoint_mode === "dnsrr")),
  has_local_volumes: (inv) => inv.volumes.filter((v) => v.driver === "local" && !isNetworkVolume(v.options)).map((v) => v.name),
  has_driver_volumes: (inv) => inv.volumes.filter((v) => v.driver !== "local" || isNetworkVolume(v.options)).map((v) => v.name),
  has_binds_or_tmpfs: (inv) => names(inv.services.filter((s) => s.mounts.some((m) => (m.type === "bind" && !(m.source ?? "").startsWith("/dev/")) || m.type === "tmpfs"))),
  has_compose: () => [],
  has_process_flags: (inv) => names(inv.services.filter((s) => s.init || s.read_only || s.extra_hosts.length > 0 || s.dns.nameservers.length > 0 || s.dns.search.length > 0)),
  has_multiple_nodes: (inv) => (inv.nodes.length > 1 ? inv.nodes.map((n) => n.hostname) : []),
};

function names(services: Service[]): string[] {
  return services.map((s) => s.name);
}

function isNetworkVolume(options: Record<string, string>): boolean {
  const type = (options.type ?? "").toLowerCase();
  return type === "nfs" || type === "nfs4" || type === "cifs" || (options.o ?? "").includes("addr=");
}

/** The distinct nodes on which the named services currently have tasks. */
function hostsOf(inv: Inventory, serviceNames: string[]): string[] {
  const hosts = new Set<string>();
  for (const s of inv.services) {
    if (!serviceNames.includes(s.name)) continue;
    for (const t of s.tasks) if (t.desired_state === "running") hosts.add(t.node);
  }
  return [...hosts];
}

export function predicateNames(): string[] {
  return Object.keys(PREDICATES);
}

/** Keep the rows the estate needs, with their evidence, restricted to the targets under consideration. */
export function selectConcepts(inv: Inventory, map: TranslationMap, catalog: Catalog, targets?: string[]): SelectedConcept[] {
  const out: SelectedConcept[] = [];
  for (const c of map.concepts) {
    const pred = PREDICATES[c.applies_when];
    if (!pred) throw new Error(`concept ${c.id}: unknown predicate ${c.applies_when}`);
    const r = pred(inv);
    if (r !== true && r.length === 0) continue;
    const evidence = r === true ? [] : r;
    const kept = (targets ? c.targets.filter((t) => targets.includes(t.target) || t.target === "runbook") : c.targets).map((t) => ({ ...t, since: effectiveSince(t, catalog) }));
    if (kept.length === 0) continue;
    const best = kept.reduce((a, b) => (rank(a.fidelity) <= rank(b.fidelity) ? a : b));
    out.push({ ...c, targets: kept, evidence, decision_needed: best.fidelity === "partial" || best.fidelity === "manual" });
  }
  return out;
}

/** The version a target needs: the newest directive, line type, or tool it names, or the row's own floor if higher. */
export function effectiveSince(t: Target, catalog: Catalog): number {
  let since = t.since ?? 0;
  for (const d of t.directives) {
    const s = d.file === "os-release" || d.file === "tmpfiles.d" || d.file === "sysusers.d" ? catalog.pages[d.file]?.sections[d.file]?.[d.name] : directive(d.file, d.section, d.name, catalog)?.since;
    if (s && s > since) since = s;
  }
  for (const l of t.line_types ?? []) {
    const s = catalog.pages[l.file]?.sections[l.file]?.[l.name];
    if (s && s > since) since = s;
  }
  for (const tool of t.tools ?? []) {
    const s = toolOption(tool.tool, tool.name, catalog)?.since;
    if (s && s > since) since = s;
  }
  return since;
}

function rank(f: Fidelity): number {
  return { exact: 0, equivalent: 1, partial: 2, manual: 3 }[f];
}

/** Every directive, line type, and tool the map names must exist in the catalogue. Returns the problems. */
export function validateMap(map: TranslationMap, catalog: Catalog = loadCatalog()): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of map.concepts) {
    if (seen.has(c.id)) problems.push(`duplicate concept id ${c.id}`);
    seen.add(c.id);
    if (!PREDICATES[c.applies_when]) problems.push(`${c.id}: unknown predicate ${c.applies_when}`);
    if (c.targets.length === 0) problems.push(`${c.id}: no targets`);
    for (const t of c.targets) {
      if (!(t.target in map.targets)) problems.push(`${c.id}: unknown target ${t.target}`);
      if (!(t.fidelity in map.fidelity_levels)) problems.push(`${c.id}/${t.target}: unknown fidelity ${t.fidelity}`);
      for (const d of t.directives) {
        if (d.file === "os-release" || d.file === "tmpfiles.d" || d.file === "sysusers.d") {
          if (!(d.name in (catalog.pages[d.file]?.sections[d.file] ?? {}))) problems.push(`${c.id}/${t.target}: ${d.file} does not document ${d.name}`);
          continue;
        }
        const info = directive(d.file, d.section, d.name, catalog);
        if (!info) problems.push(`${c.id}/${t.target}: ${d.file} [${d.section}] ${d.name} is not documented`);
      }
      for (const l of t.line_types ?? []) {
        if (!(l.name in (catalog.pages[l.file]?.sections[l.file] ?? {}))) problems.push(`${c.id}/${t.target}: ${l.file} does not document line type ${l.name}`);
      }
      for (const tool of t.tools ?? []) {
        const info = toolOption(tool.tool, tool.name, catalog);
        if (!info) problems.push(`${c.id}/${t.target}: ${tool.tool} does not document ${tool.name}`);
      }
    }
  }
  return problems;
}

export function buildPlan(inv: Inventory, map: TranslationMap, catalog: Catalog, targets?: string[]): Plan {
  const concepts = selectConcepts(inv, map, catalog, targets);
  let minimum = 0;
  for (const c of concepts) for (const t of c.targets) if (t.since > minimum) minimum = t.since;
  return {
    generated_by: "migration-planner/scripts/plan-map.ts",
    systemd_catalogue: catalog.systemd_version,
    inventory: {
      captured_at: inv.captured_at,
      nodes: inv.nodes.length,
      stacks: inv.stacks.length,
      services: inv.services.length,
      networks: inv.networks.length,
      volumes: inv.volumes.length,
    },
    minimum: map.minimum,
    minimum_version_required: Math.max(minimum, map.minimum.systemd),
    targets_considered: targets ?? Object.keys(map.targets),
    concepts,
  };
}

function directiveList(t: Target): string {
  const parts = t.directives.map((d) => (d.file === "os-release" ? `${d.name} (os-release)` : `${d.name} (${d.file} [${d.section}])`));
  for (const l of t.line_types ?? []) parts.push(`${l.file} line type ${l.name}`);
  for (const tool of t.tools ?? []) parts.push(`${tool.tool} ${tool.name}`);
  return parts.length ? parts.map((p) => `\`${p}\``).join(", ") : "none";
}

export function renderMarkdown(plan: Plan, map: TranslationMap): string {
  const lines: string[] = [];
  lines.push("# Translation map");
  lines.push("");
  lines.push(
    `Generated by ${plan.generated_by} from an inventory captured ${plan.inventory.captured_at} (${plan.inventory.nodes} nodes, ${plan.inventory.stacks} stacks, ${plan.inventory.services} services, ${plan.inventory.networks} networks, ${plan.inventory.volumes} volumes), against the directive catalogue of systemd ${plan.systemd_catalogue}. Targets considered: ${plan.targets_considered.join(", ")}.`,
  );
  lines.push("");
  lines.push(`The rows below need systemd ${plan.minimum_version_required} or later on the target hosts, and a kernel of ${plan.minimum.kernel} or later where a mount stack has a writable layer. Fidelity is the renderer's honest rating:`);
  lines.push("");
  for (const [k, v] of Object.entries(map.fidelity_levels)) lines.push(`- **${k}**: ${v}`);
  lines.push("");
  lines.push("## Concepts in this estate");
  lines.push("");
  lines.push("| Concept | Evidence | Target | Fidelity | Since | Directives and tools |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of plan.concepts) {
    const ev = c.evidence.length ? c.evidence.map((e) => `\`${e}\``).join(", ") : "every service";
    c.targets.forEach((t, i) => {
      lines.push(`| ${i === 0 ? c.concept : ""} | ${i === 0 ? ev : ""} | ${t.target} | ${t.fidelity} | ${t.since || ""} | ${directiveList(t)} |`);
    });
  }
  lines.push("");
  lines.push("## How each concept is expressed");
  lines.push("");
  for (const c of plan.concepts) {
    lines.push(`### ${c.concept}`);
    lines.push("");
    lines.push(`Source: ${c.source.map((s) => `\`${s}\``).join(", ")}.${c.note ? ` ${c.note}` : ""}`);
    lines.push("");
    for (const t of c.targets) {
      const needs = t.needs?.length ? ` Needs: ${t.needs.join("; ")}.` : "";
      lines.push(`- **${t.target}** (${t.fidelity}${t.since ? `, systemd ${t.since}` : ""}): ${t.how}${needs}`);
    }
    lines.push("");
  }
  const decisions = plan.concepts.filter((c) => c.decision_needed);
  lines.push("## Needs a human decision");
  lines.push("");
  if (decisions.length === 0) lines.push("None: every concept in this estate has an exact or equivalent target.");
  for (const c of decisions) {
    const best = c.targets.reduce((a, b) => (rank(a.fidelity) <= rank(b.fidelity) ? a : b));
    lines.push(`- **${c.concept}** (${c.evidence.length ? c.evidence.join(", ") : "every service"}): the best target is ${best.target}, rated ${best.fidelity}. ${best.how}`);
  }
  lines.push("");
  return lines.join("\n");
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAP = resolve(here, "..", "references", "translation-map.json");

export function loadMap(path: string = DEFAULT_MAP): TranslationMap {
  return JSON.parse(readFileSync(path, "utf8")) as TranslationMap;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let inventoryPath: string | null = null;
  let outDir = ".";
  let mapPath = DEFAULT_MAP;
  let catalogPath: string | undefined;
  let targets: string[] | undefined;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "--output") outDir = args[++i]!;
    else if (a === "--map") mapPath = args[++i]!;
    else if (a === "--catalog") catalogPath = args[++i];
    else if (a === "--targets") targets = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--check") check = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: plan-map.ts inventory.json [-o DIR] [--targets a,b] [--map FILE] [--catalog FILE]\n       plan-map.ts --check [--map FILE] [--catalog FILE]");
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    } else inventoryPath = a;
  }
  const map = loadMap(mapPath);
  const catalog = loadCatalog(catalogPath);
  const problems = validateMap(map, catalog);
  if (problems.length) {
    console.error(`translation map does not match the directive catalogue (${problems.length} problems):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  if (check) {
    console.log(`translation map: ${map.concepts.length} concepts, every directive and tool documented in systemd ${catalog.systemd_version}`);
    process.exit(0);
  }
  if (!inventoryPath || !existsSync(inventoryPath)) {
    console.error("inventory.json is required (or pass --check)");
    process.exit(2);
  }
  const inv = JSON.parse(readFileSync(inventoryPath, "utf8")) as Inventory;
  if (targets) for (const t of targets) if (!(t in map.targets)) { console.error(`unknown target ${t}; known: ${Object.keys(map.targets).join(", ")}`); process.exit(2); }
  const plan = buildPlan(inv, map, catalog, targets);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "translation-map.json"), JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(join(outDir, "TRANSLATION-MAP.md"), renderMarkdown(plan, map));
  const decisions = plan.concepts.filter((c) => c.decision_needed).length;
  console.log(`wrote ${join(outDir, "TRANSLATION-MAP.md")}: ${plan.concepts.length} concepts apply, ${decisions} need a decision, systemd ${plan.minimum_version_required} or later required`);
}
