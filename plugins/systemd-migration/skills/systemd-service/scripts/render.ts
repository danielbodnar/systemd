#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// One-call renderer for native services: drafts a plan from the inventory,
// applies the options below as chosen values, accepts every remaining
// default, and composes the registered components. It exists for callers
// that want the old shape (a single command from inventory to tree) and for
// the fixture test; a real migration goes through plan.ts and review.ts so
// the decisions are looked at.
//
//   bun render.ts inventory.json -o DIR [--host-map FILE] [--scale-out] [--root-image] [--image-dir DIR] [--state-dir DIR]

import { readFileSync } from "node:fs";
import { PLACEMENT_SCALE_OUT, type RenderResult, composePlan, composeRender, placementId } from "../../../contract/compose.ts";
import type { HostExpectation, ImageEntry } from "../../../contract/component.ts";
import { type Plan, resolveDecision } from "../../../contract/plan.ts";
import { COMPONENTS } from "../../../contract/registry.ts";
import type { Inventory } from "../../../contract/types.ts";
import { isPlainPath } from "../../../contract/unit.ts";
import { IMAGE_DIR } from "../../systemd-machined/scripts/component.ts";
import { STATE_DIR } from "../../systemd-storage/scripts/component.ts";
import { writeResult } from "../../../scripts/render.ts";

export { capabilitySet, commandLine } from "./component.ts";
export { writeResult };
export type { HostExpectation as HostPlan, ImageEntry, RenderResult };

/** Marks a choice the one-call renderer made for the caller; the notes list every such decision. */
export const AUTO_REASON = "auto: chosen by the one-call renderer, not reviewed";

export interface RenderOptions {
  hostMap?: Record<string, string[]>;
  scaleOut?: boolean;
  /** Write RootImage=IMAGE_DIR/NAME.raw instead of RootMStack=IMAGE_DIR/NAME.mstack, for hosts without mount stacks. */
  rootImage?: boolean;
  /** Where the images live on the hosts. */
  imageDir?: string;
  /** Where local volumes live on the hosts, under <stateDir>/<stack>/<volume>. */
  stateDir?: string;
}

/** Draft a plan for the inventory with the options applied as chosen values; every other decision keeps its default. */
export function planFor(inv: Inventory, opts: RenderOptions = {}): Plan {
  for (const [flag, dir] of [["--image-dir", opts.imageDir], ["--state-dir", opts.stateDir]] as const) {
    if (dir !== undefined && !isPlainPath(dir)) throw new Error(`${flag} must be an absolute path of plain characters, got ${JSON.stringify(dir)}`);
  }
  const { plan } = composePlan(inv, COMPONENTS, { generatedBy: "systemd-service render.ts" });
  if (opts.scaleOut) resolveDecision(plan, PLACEMENT_SCALE_OUT, "yes");
  if (opts.scaleOut) {
    // Placement defaults were computed without scale-out; recompute them with it.
    const { plan: again } = composePlan(inv, COMPONENTS, { generatedBy: "systemd-service render.ts", existing: plan });
    plan.decisions = again.decisions;
  }
  for (const [service, hosts] of Object.entries(opts.hostMap ?? {})) resolveDecision(plan, placementId(service), hosts.join(","), "host map");
  if (opts.imageDir) resolveDecision(plan, IMAGE_DIR, opts.imageDir.replace(/\/+$/, ""));
  if (opts.stateDir) resolveDecision(plan, STATE_DIR, opts.stateDir.replace(/\/+$/, ""));
  if (opts.rootImage) for (const d of plan.decisions) if (d.id.startsWith("machined.root_form.")) resolveDecision(plan, d.id, "ddi", "--root-image");
  // Decisions the planner refuses to default (data moves, ingress ports, discovery, cross-host transports)
  // take their first option here so a one-call render completes; each is listed under "needs a human
  // decision" in the notes, marked by the reason below.
  for (const d of plan.decisions) {
    if (d.chosen != null || d.default != null) continue;
    if (d.kind === "choice" && d.options?.length) resolveDecision(plan, d.id, d.options[0]!.value, AUTO_REASON);
  }
  return plan;
}

export function render(inv: Inventory, opts: RenderOptions = {}): RenderResult {
  const plan = planFor(inv, opts);
  return composeRender(inv, plan, COMPONENTS, { acceptDefaults: true, rendererName: "systemd-service" });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let inventoryPath: string | null = null;
  let outDir = "rendered-native";
  const opts: RenderOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "--output") outDir = args[++i]!;
    else if (a === "--host-map") opts.hostMap = JSON.parse(readFileSync(args[++i]!, "utf8"));
    else if (a === "--scale-out") opts.scaleOut = true;
    else if (a === "--root-image") opts.rootImage = true;
    else if (a === "--image-dir") opts.imageDir = args[++i];
    else if (a === "--state-dir") opts.stateDir = args[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: render.ts inventory.json -o DIR [--host-map FILE] [--scale-out] [--root-image] [--image-dir DIR] [--state-dir DIR]");
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
  const result = render(inv, opts);
  writeResult(result, outDir);
  const units = Object.values(result.hosts).reduce((n, h) => n + h.units.length, 0);
  console.log(`rendered ${units} units across ${Object.keys(result.hosts).length} hosts into ${outDir} (every decision took its default; use plan.ts and review.ts for a reviewed plan)`);
}
