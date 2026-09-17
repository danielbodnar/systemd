// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Coverage of the systemd surface is measured, not asserted: every
// administrator-facing man page in this tree (contract/surface.json,
// generated from man/) must be claimed by exactly one component or skill,
// or listed in contract/coverage.json as not applicable with a reason.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPONENTS } from "../../contract/registry.ts";
import { type Surface, buildSurface } from "../../skills/migration-planner/scripts/build-catalog.ts";

const contract = resolve(import.meta.dir, "../../contract");
const tree = resolve(import.meta.dir, "../../../..");
const surface = JSON.parse(readFileSync(resolve(contract, "surface.json"), "utf8")) as Surface;
const coverage = JSON.parse(readFileSync(resolve(contract, "coverage.json"), "utf8")) as { skills: Record<string, string[]>; not_applicable: Record<string, string[]>; adapters?: string[] };
/** Components that are adapter targets for another runtime (Quadlet is Podman's interface); they may claim no page. */
const adapters = new Set(coverage.adapters ?? []);

/** Page name or alias to the canonical page name. */
const canonical = new Map<string, string>();
for (const p of surface.pages) {
  canonical.set(p.name, p.name);
  for (const a of p.aliases) canonical.set(a, p.name);
}

describe("systemd surface coverage", () => {
  test("surface.json is a fresh build from this tree's man/", () => {
    const manDir = resolve(tree, "man");
    if (!existsSync(manDir)) return;
    const fresh = buildSurface(manDir, surface.systemd_version);
    expect(fresh.pages.map((p) => p.name)).toEqual(surface.pages.map((p) => p.name));
    expect(fresh.pages.map((p) => p.aliases)).toEqual(surface.pages.map((p) => p.aliases));
  });

  test("every claim names a page (or alias) the surface has", () => {
    const bad: string[] = [];
    for (const c of COMPONENTS) for (const page of c.covers) if (!canonical.has(page)) bad.push(`component ${c.id}: ${page}`);
    for (const [skill, pages] of Object.entries(coverage.skills)) for (const page of pages) if (!canonical.has(page)) bad.push(`skill ${skill}: ${page}`);
    for (const [reason, pages] of Object.entries(coverage.not_applicable)) for (const page of pages) if (!canonical.has(page)) bad.push(`not applicable (${reason.slice(0, 30)}...): ${page}`);
    expect(bad).toEqual([]);
  });

  test("every surface page is claimed exactly once or excluded with a reason", () => {
    const claims = new Map<string, string[]>();
    const claim = (page: string, by: string) => {
      const name = canonical.get(page)!;
      const list = claims.get(name) ?? [];
      list.push(by);
      claims.set(name, list);
    };
    for (const c of COMPONENTS) for (const page of c.covers) claim(page, `component ${c.id}`);
    for (const [skill, pages] of Object.entries(coverage.skills)) for (const page of pages) claim(page, `skill ${skill}`);
    for (const [reason, pages] of Object.entries(coverage.not_applicable)) for (const page of pages) claim(page, `n/a: ${reason.slice(0, 40)}`);
    const unclaimed = surface.pages.filter((p) => !claims.has(p.name)).map((p) => `${p.name}(${p.volume}): ${p.purpose}`);
    const doubled = [...claims].filter(([, by]) => by.length > 1).map(([page, by]) => `${page}: ${by.join(" + ")}`);
    expect(unclaimed).toEqual([]);
    expect(doubled).toEqual([]);
  });

  test("the components carry the larger share of the surface", () => {
    const byComponent = new Set(COMPONENTS.flatMap((c) => c.covers.map((p) => canonical.get(p)!)));
    const bySkill = new Set(Object.values(coverage.skills).flat().map((p) => canonical.get(p)!));
    const excluded = new Set(Object.values(coverage.not_applicable).flat().map((p) => canonical.get(p)!));
    const total = surface.pages.length;
    const implemented = byComponent.size + bySkill.size;
    // Report so the number is visible in the test log.
    console.log(`surface: ${total} pages; components ${byComponent.size}, skills ${bySkill.size}, not applicable ${excluded.size} (${Math.round((implemented / (total - excluded.size)) * 100)}% of the applicable surface)`);
    expect(implemented).toBeGreaterThan(excluded.size / 2);
    for (const id of adapters) expect(COMPONENTS.some((c) => c.id === id), `adapter ${id} is registered`).toBe(true);
    for (const c of COMPONENTS) if (!adapters.has(c.id)) expect(c.covers.length, c.id).toBeGreaterThan(0);
  });
});
