#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Walk and resolve the decisions in plan.yaml. The /migrate-plan command
// drives this: it lists what is open, presents each decision to the user
// with its options and evidence, and records the answer with --set.
//
//   bun review.ts plan.yaml                       list unresolved decisions (no default), then the defaulted ones
//   bun review.ts plan.yaml --all                 list every decision with its state
//   bun review.ts plan.yaml --json                the same as JSON, for an agent
//   bun review.ts plan.yaml --set ID=VALUE [--reason TEXT]   record a choice (repeatable)
//   bun review.ts plan.yaml --accept-defaults [--component ID]  turn defaults into choices
//   bun review.ts plan.yaml --status              counts only; exit 1 while anything is unresolved

import { type Decision, type Plan, loadPlan, openDecisions, resolveDecision, savePlan, unresolvedDecisions } from "../contract/plan.ts";

export function describe(d: Decision): string {
  const lines: string[] = [];
  const state = d.chosen != null ? `chosen: ${d.chosen}` : d.default != null ? `default: ${d.default} (not yet approved)` : "unresolved";
  lines.push(`${d.id}  [${d.component}, ${d.subject.kind} ${d.subject.name}]  ${state}`);
  lines.push(`  ${d.question}`);
  if (d.options) for (const o of d.options) lines.push(`    - ${o.value}: ${o.label}${o.consequence ? `. ${o.consequence}` : ""}`);
  if (d.format) lines.push(`    format: ${d.format}`);
  if (d.evidence?.length) lines.push(`  evidence: ${d.evidence.join("; ")}`);
  if (d.hosts?.length) lines.push(`  hosts: ${d.hosts.join(", ")}`);
  if (d.reason) lines.push(`  reason: ${d.reason}`);
  return lines.join("\n");
}

export function status(plan: Plan): { decisions: number; unresolved: number; open: number } {
  return { decisions: plan.decisions.length, unresolved: unresolvedDecisions(plan).length, open: openDecisions(plan).length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let path: string | null = null;
  const sets: { id: string; value: string }[] = [];
  let reason: string | undefined;
  let acceptDefaults = false;
  let component: string | null = null;
  let all = false;
  let json = false;
  let statusOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--set") {
      const spec = args[++i]!;
      const eq = spec.indexOf("=");
      if (eq < 0) {
        console.error(`--set needs ID=VALUE, got ${spec}`);
        process.exit(2);
      }
      sets.push({ id: spec.slice(0, eq), value: spec.slice(eq + 1) });
    } else if (a === "--reason") reason = args[++i];
    else if (a === "--accept-defaults") acceptDefaults = true;
    else if (a === "--component") component = args[++i]!;
    else if (a === "--all") all = true;
    else if (a === "--json") json = true;
    else if (a === "--status") statusOnly = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: review.ts plan.yaml [--all|--json|--status] [--set ID=VALUE [--reason TEXT]]... [--accept-defaults [--component ID]]");
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    } else path = a;
  }
  if (!path) {
    console.error("plan.yaml is required");
    process.exit(2);
  }
  const plan = loadPlan(path);
  let changed = false;
  for (const s of sets) {
    const d = resolveDecision(plan, s.id, s.value, reason);
    console.log(`set ${d.id} = ${d.chosen}`);
    changed = true;
  }
  if (acceptDefaults) {
    for (const d of plan.decisions) {
      if (d.chosen != null || d.default == null) continue;
      if (component && d.component !== component) continue;
      d.chosen = d.default;
      d.reason ??= "accepted the planner's default";
      changed = true;
    }
  }
  if (changed) savePlan(plan, path);
  const st = status(plan);
  if (statusOnly) {
    console.log(`${st.decisions} decisions, ${st.unresolved} unresolved, ${st.open} not yet approved`);
    process.exit(st.unresolved ? 1 : 0);
  }
  const shown = all ? plan.decisions : openDecisions(plan);
  if (json) {
    console.log(JSON.stringify({ status: st, decisions: shown }, null, 2));
  } else {
    const unresolved = shown.filter((d) => d.chosen == null && d.default == null);
    const defaulted = shown.filter((d) => d.chosen == null && d.default != null);
    const chosen = shown.filter((d) => d.chosen != null);
    if (unresolved.length) console.log(`# ${unresolved.length} unresolved (no default)\n\n${unresolved.map(describe).join("\n\n")}\n`);
    if (defaulted.length) console.log(`# ${defaulted.length} defaulted, not yet approved\n\n${defaulted.map(describe).join("\n\n")}\n`);
    if (chosen.length) console.log(`# ${chosen.length} chosen\n\n${chosen.map(describe).join("\n\n")}\n`);
    console.log(`${st.decisions} decisions, ${st.unresolved} unresolved, ${st.open} not yet approved`);
  }
}
