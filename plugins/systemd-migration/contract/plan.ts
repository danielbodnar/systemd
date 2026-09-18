// SPDX-License-Identifier: LGPL-2.1-or-later
//
// plan.yaml: the planner's output and the user's approval surface.
//
// A plan is a list of decisions. Each decision names the component that
// needs it, the subject it is about (a service, a network, a secret, a host,
// the whole estate), the options with their consequences, the evidence in
// the inventory that raised it, a default where one is defensible, and the
// value the user chose. Nothing about an estate is assumed: address ranges,
// overlay transports, load balancing, the form each service takes, and where
// each secret lives are all decisions, and rendering refuses to run while
// any decision has neither a chosen value nor an accepted default.
//
// The file is YAML so it can be edited by hand and diffed; Bun parses and
// writes it natively, so no dependency is needed.

import { readFileSync, writeFileSync } from "node:fs";
import { validateSchema, type SchemaError } from "./schema.ts";
import planSchema from "./plan-schema.json" with { type: "json" };

/** What discover-systemd-hosts records about one target host. */
export interface HostCapabilities {
  hostname: string;
  probed_at?: string;
  systemd: { version: number; features?: string[] };
  kernel: { release: string; major: number; minor: number };
  arch: string;
  os?: { id?: string; version_id?: string; pretty_name?: string };
  cgroup_v2: boolean;
  /** overlayfs FSCONFIG_SET_FD support, which writable mount stacks need; null when the probe could not tell. */
  overlayfs_fsconfig: boolean | null;
  /** Daemons and generators present on the host, by short name (networkd, resolved, machined, importd, portabled, sysext, journald-namespaces, ...). */
  daemons: Record<string, boolean>;
  /** Tools present on the host (systemd-nspawn, systemd-vmspawn, importctl, systemd-repart, systemd-creds, podman, ...). */
  tools: Record<string, boolean>;
  image_dirs?: string[];
  addresses?: string[];
  notes?: string[];
}

export interface Requirements {
  systemd?: number;
  kernel?: string;
  daemons?: string[];
  tools?: string[];
  features?: string[];
}

export type DecisionKind = "choice" | "value";
export type SubjectKind = "estate" | "host" | "stack" | "service" | "network" | "volume" | "secret" | "config" | "port" | "image";
export type ValueFormat = "cidr" | "ipv4" | "hostname" | "hosts" | "path" | "name" | "port" | "text" | "list";

export interface DecisionOption {
  value: string;
  label: string;
  consequence?: string;
  requires?: Requirements;
}

export interface Decision {
  /** Stable, dotted: `<component>.<topic>.<subject>`; the same estate yields the same ids across runs. */
  id: string;
  component: string;
  kind: DecisionKind;
  subject: { kind: SubjectKind; name: string };
  question: string;
  /** For `choice`: the alternatives; the chosen value must be one of them. */
  options?: DecisionOption[];
  /** For `value`: how the free-form value is validated. */
  format?: ValueFormat;
  default?: string | null;
  chosen?: string | null;
  reason?: string;
  /** Inventory paths or names that raised the decision. */
  evidence?: string[];
  /** Hosts the decision affects, when not the whole estate. */
  hosts?: string[];
}

export interface Plan {
  version: 1;
  generated_at: string;
  generated_by: string;
  inventory: { captured_at: string; services: number; networks: number; nodes: number };
  /** Target hosts with their probed capabilities; a host without a probe file is listed with null. */
  hosts: Record<string, HostCapabilities | null>;
  decisions: Decision[];
  /** Filled on save: counts the reader wants at a glance. */
  summary?: { decisions: number; unresolved: number; defaulted: number };
}

/** A decision id the caller may use before the plan exists, for lookups that tolerate absence. */
export type DecisionId = string;

export function parsePlan(text: string): Plan {
  const doc = Bun.YAML.parse(text) as Plan;
  const errors = validatePlan(doc);
  if (errors.length) throw new Error(`plan does not match plan-schema.json:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
  return doc;
}

export function loadPlan(path: string): Plan {
  return parsePlan(readFileSync(path, "utf8"));
}

export function validatePlan(doc: unknown): SchemaError[] {
  const errors = validateSchema(doc, planSchema as never);
  if (errors.length) return errors;
  const plan = doc as Plan;
  for (const [name, caps] of Object.entries(plan.hosts)) {
    if (caps !== null) validateSchema(caps, (planSchema as unknown as { $defs: { host: never } }).$defs.host, planSchema as never, `$.hosts.${name}`, errors);
  }
  const seen = new Set<string>();
  for (const d of plan.decisions) {
    if (seen.has(d.id)) errors.push({ path: `$.decisions[${d.id}]`, message: "duplicate decision id" });
    seen.add(d.id);
    if (d.kind === "choice") {
      if (!d.options || d.options.length === 0) errors.push({ path: `$.decisions[${d.id}]`, message: "a choice needs options" });
      for (const v of [d.default, d.chosen]) {
        if (v != null && !d.options?.some((o) => o.value === v)) errors.push({ path: `$.decisions[${d.id}]`, message: `${v} is not one of the options` });
      }
    } else if (d.chosen != null) {
      const problem = checkFormat(d.format ?? "text", d.chosen);
      if (problem) errors.push({ path: `$.decisions[${d.id}]`, message: problem });
    }
  }
  return errors;
}

/** Serialize with a stable key order so diffs stay readable. */
export function serializePlan(plan: Plan): string {
  const unresolved = unresolvedDecisions(plan).length;
  const defaulted = plan.decisions.filter((d) => d.chosen == null && d.default != null).length;
  const ordered: Plan = {
    version: plan.version,
    generated_at: plan.generated_at,
    generated_by: plan.generated_by,
    inventory: plan.inventory,
    summary: { decisions: plan.decisions.length, unresolved, defaulted },
    hosts: plan.hosts,
    decisions: plan.decisions.map(orderDecision),
  };
  const header = [
    "# systemd-migration plan. Every entry under `decisions` is a question the",
    "# planner could not answer from the inventory alone. Set `chosen` (and, for a",
    "# `value` decision, any well-formed value the `format` allows) or run",
    "# review.ts to walk the unresolved ones. `default` is the planner's",
    "# suggestion; render.ts accepts defaults only with --accept-defaults.",
    "",
  ].join("\n");
  return header + Bun.YAML.stringify(ordered, null, 2) + "\n";
}

function orderDecision(d: Decision): Decision {
  const out: Decision = { id: d.id, component: d.component, kind: d.kind, subject: d.subject, question: d.question };
  if (d.options) out.options = d.options;
  if (d.format) out.format = d.format;
  if (d.evidence) out.evidence = d.evidence;
  if (d.hosts) out.hosts = d.hosts;
  out.default = d.default ?? null;
  out.chosen = d.chosen ?? null;
  if (d.reason) out.reason = d.reason;
  return out;
}

export function savePlan(plan: Plan, path: string): void {
  writeFileSync(path, serializePlan(plan), { mode: 0o644 });
}

/** Decisions with neither a chosen value nor a default. */
export function unresolvedDecisions(plan: Plan): Decision[] {
  return plan.decisions.filter((d) => d.chosen == null && d.default == null);
}

/** Decisions the user has not touched, whether or not a default exists. */
export function openDecisions(plan: Plan): Decision[] {
  return plan.decisions.filter((d) => d.chosen == null);
}

export function findDecision(plan: Plan, id: string): Decision | undefined {
  return plan.decisions.find((d) => d.id === id);
}

/**
 * The effective value of a decision: the chosen value, else the default
 * when `acceptDefaults`, else an error. Components call this through the
 * render context, which fixes `acceptDefaults` for the whole run.
 */
export function decisionValue(plan: Plan, id: string, acceptDefaults: boolean): string {
  const d = findDecision(plan, id);
  if (!d) throw new Error(`the plan has no decision ${id}; re-run plan.ts against this inventory`);
  if (d.chosen != null) return d.chosen;
  if (d.default != null && acceptDefaults) return d.default;
  throw new Error(`decision ${id} is unresolved (${d.question})`);
}

/** Set a decision, validating the value against the options or the format. */
export function resolveDecision(plan: Plan, id: string, value: string, reason?: string): Decision {
  const d = findDecision(plan, id);
  if (!d) throw new Error(`no decision ${id}`);
  if (d.kind === "choice") {
    if (!d.options?.some((o) => o.value === value)) throw new Error(`${id}: ${JSON.stringify(value)} is not one of ${d.options?.map((o) => o.value).join(", ")}`);
  } else {
    const problem = checkFormat(d.format ?? "text", value);
    if (problem) throw new Error(`${id}: ${problem}`);
  }
  d.chosen = value;
  if (reason) d.reason = reason;
  return d;
}

/** Carry chosen values and reasons from an earlier plan into a fresh one where the decision still exists and the value is still valid. */
export function mergePlans(fresh: Plan, existing: Plan | null): { plan: Plan; dropped: string[] } {
  const dropped: string[] = [];
  if (!existing) return { plan: fresh, dropped };
  const previous = new Map(existing.decisions.map((d) => [d.id, d]));
  for (const d of fresh.decisions) {
    const old = previous.get(d.id);
    if (!old || old.chosen == null) continue;
    const valid = d.kind === "choice" ? d.options?.some((o) => o.value === old.chosen) : checkFormat(d.format ?? "text", old.chosen) === null;
    if (valid) {
      d.chosen = old.chosen;
      if (old.reason) d.reason = old.reason;
    } else dropped.push(`${d.id}: previous choice ${JSON.stringify(old.chosen)} is no longer valid`);
  }
  for (const id of previous.keys()) if (!fresh.decisions.some((d) => d.id === id)) dropped.push(`${id}: no longer raised by this inventory`);
  return { plan: fresh, dropped };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** null when the value is well-formed for the format, else the problem. */
export function checkFormat(format: ValueFormat, value: string): string | null {
  switch (format) {
    case "cidr": {
      const m = /^([^/]+)\/(\d{1,3})$/.exec(value);
      if (!m) return `${value} is not an address/prefix`;
      if (IPV4.test(m[1]!)) return Number(m[2]) <= 32 ? null : `${value}: prefix over 32`;
      if (/^[0-9a-fA-F:]+$/.test(m[1]!) && m[1]!.includes(":")) return Number(m[2]) <= 128 ? null : `${value}: prefix over 128`;
      return `${value} is not an address/prefix`;
    }
    case "ipv4":
      return IPV4.test(value) ? null : `${value} is not an IPv4 address`;
    case "hostname":
      return HOSTNAME.test(value) ? null : `${value} is not a host name`;
    case "hosts":
      for (const h of splitList(value)) if (!HOSTNAME.test(h)) return `${h} is not a host name`;
      return splitList(value).length ? null : "at least one host is needed";
    case "path":
      return /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("/..") && !value.includes("//") ? null : `${value} is not an absolute path of plain characters`;
    case "name":
      return /^[A-Za-z0-9._@:-]+$/.test(value) ? null : `${value} is not a plain name`;
    case "port": {
      const n = Number(value);
      return Number.isInteger(n) && n > 0 && n < 65536 ? null : `${value} is not a port`;
    }
    case "list":
    case "text":
      return null;
  }
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether a host can satisfy the requirements; unknown capabilities (null) satisfy everything and are reported as such. */
export function requirementsMet(req: Requirements | undefined, caps: HostCapabilities | null | undefined): { ok: boolean; missing: string[]; unknown: boolean } {
  if (!req) return { ok: true, missing: [], unknown: false };
  if (!caps) return { ok: true, missing: [], unknown: true };
  const missing: string[] = [];
  if (req.systemd && caps.systemd.version < req.systemd) missing.push(`systemd ${req.systemd} (host has ${caps.systemd.version})`);
  if (req.kernel && compareKernel(caps.kernel, req.kernel) < 0) missing.push(`kernel ${req.kernel} (host has ${caps.kernel.release})`);
  for (const d of req.daemons ?? []) if (!caps.daemons[d]) missing.push(`daemon ${d}`);
  for (const t of req.tools ?? []) if (!caps.tools[t]) missing.push(`tool ${t}`);
  for (const f of req.features ?? []) if (caps.systemd.features && !caps.systemd.features.includes(f)) missing.push(`feature ${f}`);
  return { ok: missing.length === 0, missing, unknown: false };
}

function compareKernel(k: { major: number; minor: number }, wanted: string): number {
  const [maj, min] = wanted.split(".").map(Number);
  if (k.major !== maj) return k.major - (maj ?? 0);
  return k.minor - (min ?? 0);
}
