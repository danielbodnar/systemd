#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Draft plan.yaml for an estate: every decision the engine and the
// registered components need, with options, evidence, and defaults, and the
// target hosts' capabilities from discover-systemd-hosts. An existing
// plan.yaml keeps its chosen values where the decision still applies.
//
//   bun plan.ts inventory.json [--hosts DIR] [-o plan.yaml]
//
// --hosts DIR   directory of <hostname>.json files written by probe.sh; the
//               plan targets those hosts. Without it the inventory's nodes
//               are the targets, with unknown capabilities.
// -o FILE       where to write; an existing file is read first and its
//               chosen values carried over (default: plan.yaml).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composePlan } from "../contract/compose.ts";
import { COMPONENTS } from "../contract/registry.ts";
import { type HostCapabilities, loadPlan, savePlan, unresolvedDecisions } from "../contract/plan.ts";
import type { Inventory } from "../contract/types.ts";

export function loadHosts(dir: string): Record<string, HostCapabilities | null> {
  const out: Record<string, HostCapabilities | null> = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const caps = JSON.parse(readFileSync(join(dir, f), "utf8")) as HostCapabilities;
    out[caps.hostname ?? f.replace(/\.json$/, "")] = caps;
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let inventoryPath: string | null = null;
  let hostsDir: string | null = null;
  let out = "plan.yaml";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "--output") out = args[++i]!;
    else if (a === "--hosts") hostsDir = args[++i]!;
    else if (a === "-h" || a === "--help") {
      console.log("usage: plan.ts inventory.json [--hosts DIR] [-o plan.yaml]");
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    } else inventoryPath = a;
  }
  if (!inventoryPath) {
    console.error("inventory.json is required");
    process.exit(2);
  }
  const inv = JSON.parse(readFileSync(inventoryPath, "utf8")) as Inventory;
  const hosts = hostsDir ? loadHosts(hostsDir) : {};
  const existing = existsSync(out) ? loadPlan(out) : null;
  const { plan, dropped } = composePlan(inv, COMPONENTS, { hosts, existing });
  savePlan(plan, out);
  const unresolved = unresolvedDecisions(plan);
  const open = plan.decisions.filter((d) => d.chosen == null).length;
  console.log(`wrote ${out}: ${plan.decisions.length} decisions, ${unresolved.length} without a default, ${open} not yet approved`);
  if (!hostsDir) console.log("no --hosts directory: target hosts are the inventory's nodes with unknown capabilities; run discover-systemd-hosts for evidence");
  for (const d of dropped) console.log(`dropped: ${d}`);
  if (unresolved.length) console.log(`next: bun review.ts ${out}`);
}
