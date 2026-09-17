#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Render the per-host trees by composing the registered components
// according to plan.yaml. Refuses to run while a decision is unresolved, and,
// without --accept-defaults, while any decision still rests on its default.
//
//   bun render.ts inventory.json plan.yaml -o DIR [--accept-defaults] [--host NAME]...

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RenderResult, composeRender } from "../contract/compose.ts";
import { loadPlan } from "../contract/plan.ts";
import { COMPONENTS } from "../contract/registry.ts";
import type { Inventory } from "../contract/types.ts";

export function writeResult(result: RenderResult, outDir: string): void {
  for (const [rel, content] of Object.entries(result.files)) {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, { mode: rel.endsWith(".sh") ? 0o755 : rel.includes("/secrets/") || rel.endsWith(".env") ? 0o600 : 0o644 });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let outDir = "rendered";
  let acceptDefaults = false;
  const hosts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "--output") outDir = args[++i]!;
    else if (a === "--accept-defaults") acceptDefaults = true;
    else if (a === "--host") hosts.push(args[++i]!);
    else if (a === "-h" || a === "--help") {
      console.log("usage: render.ts inventory.json plan.yaml -o DIR [--accept-defaults] [--host NAME]...");
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    } else positional.push(a);
  }
  if (positional.length !== 2) {
    console.error("inventory.json and plan.yaml are required");
    process.exit(2);
  }
  const inv = JSON.parse(readFileSync(positional[0]!, "utf8")) as Inventory;
  const plan = loadPlan(positional[1]!);
  const result = composeRender(inv, plan, COMPONENTS, { acceptDefaults, hosts: hosts.length ? hosts : undefined });
  writeResult(result, outDir);
  const units = Object.values(result.hosts).reduce((n, h) => n + h.units.length, 0);
  console.log(`rendered ${units} units across ${Object.keys(result.hosts).length} hosts into ${outDir}`);
  console.log(`read ${join(outDir, "MIGRATION-NOTES.md")} before installing anything`);
}
