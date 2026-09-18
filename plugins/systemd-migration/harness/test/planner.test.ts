// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The translation map is the planner's product: every row must name only
// documented directives, the predicates must select the right rows for the
// fixture estate, and the rendered document must carry the decisions.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadCatalog } from "../../contract/catalog.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import {
  buildPlan,
  effectiveSince,
  loadMap,
  predicateNames,
  renderMarkdown,
  selectConcepts,
  validateMap,
} from "../../skills/migration-planner/scripts/plan-map.ts";

const catalog = loadCatalog();
const map = loadMap();
const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const example = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../skills/discover-docker-swarm/references/example-inventory.json"), "utf8"),
) as Inventory;

describe("translation map", () => {
  test("names only directives, line types, and tools this tree documents", () => {
    expect(validateMap(map, catalog)).toEqual([]);
  });

  test("uses only predicates the planner implements, and implements no unused predicate", () => {
    const used = new Set(map.concepts.map((c) => c.applies_when));
    for (const p of used) expect(predicateNames()).toContain(p);
    for (const p of predicateNames()) expect(used.has(p), `predicate ${p} is unused`).toBe(true);
  });

  test("covers every target it declares", () => {
    const used = new Set(map.concepts.flatMap((c) => c.targets.map((t) => t.target)));
    for (const t of Object.keys(map.targets)) expect(used.has(t), `target ${t} has no row`).toBe(true);
  });

  test("computes a row's version from its directives", () => {
    const image = map.concepts.find((c) => c.id === "image")!;
    expect(effectiveSince(image.targets[0]!, catalog)).toBe(260);
    const stop = map.concepts.find((c) => c.id === "stop")!;
    expect(effectiveSince(stop.targets[0]!, catalog)).toBe(188);
  });
});

describe("planner on the fixture estate", () => {
  const inv = normalize(capture);
  const plan = buildPlan(inv, map, catalog);
  const ids = plan.concepts.map((c) => c.id);
  const byId = (id: string) => plan.concepts.find((c) => c.id === id);

  test("selects the rows the estate needs with evidence", () => {
    expect(byId("ports-ingress")?.evidence).toEqual(["web_app"]);
    expect(byId("ports-host")?.evidence.sort()).toEqual(["data_exporter", "web_proxy"]);
    expect(byId("secrets")?.evidence.sort()).toEqual(["data_exporter", "data_postgres", "web_app"]);
    expect(byId("configs")?.evidence).toEqual(["web_proxy"]);
    expect(byId("macvlan")?.evidence).toEqual(["data_monitoring"]);
    expect(byId("volumes-driver")?.evidence).toEqual(["data_backups"]);
    expect(byId("volumes-local")?.evidence.sort()).toEqual(["data_pgdata", "web_cache"]);
    expect(byId("healthcheck")?.evidence.sort()).toEqual(["data_postgres", "web_app"]);
    expect(byId("cluster")?.evidence).toEqual(["swarm-mgr-1", "swarm-wrk-1"]);
  });

  test("tells single-host overlays from ones that span hosts", () => {
    expect(byId("overlay-multi")?.evidence).toEqual(["web_frontend"]);
    expect(byId("overlay-single")?.evidence).toEqual(["data_backend"]);
  });

  test("skips rows without evidence", () => {
    expect(ids).not.toContain("host-network");
    expect(ids).not.toContain("devices");
    expect(ids).not.toContain("os-container");
  });

  test("marks partial and manual rows as decisions", () => {
    expect(byId("ports-ingress")?.decision_needed).toBe(true);
    expect(byId("update-rollback")?.decision_needed).toBe(true);
    expect(byId("restart")?.decision_needed).toBe(false);
  });

  test("requires the version of the newest directive it selected", () => {
    expect(plan.minimum_version_required).toBe(261);
    for (const c of plan.concepts) for (const t of c.targets) expect(t.since).toBeLessThanOrEqual(plan.minimum_version_required);
  });

  test("restricts to the targets asked for but keeps runbook rows", () => {
    const only = selectConcepts(inv, map, catalog, ["nspawn"]);
    for (const c of only) for (const t of c.targets) expect(["nspawn", "runbook"]).toContain(t.target);
    expect(only.map((c) => c.id)).toContain("ports-ingress");
    expect(only.map((c) => c.id)).not.toContain("portable");
  });

  test("renders a document with the table and the decisions", () => {
    const md = renderMarkdown(plan, map);
    expect(md).toContain("# Translation map");
    expect(md).toContain("| Concept | Evidence | Target | Fidelity | Since | Directives and tools |");
    expect(md).toContain("## Needs a human decision");
    expect(md).toContain("Published ports through the routing mesh");
    expect(md).toContain("`RootMStack= (service [Service])`");
  });

  test("works on the example inventory too", () => {
    const p = buildPlan(example, map, catalog);
    expect(p.concepts.length).toBeGreaterThan(20);
  });

  test("the fixture ships compose files for the dependency row", () => {
    expect(readdirSync(resolve(capture, "compose")).sort()).toEqual(["Caddyfile", "data.yaml", "web.yaml"]);
  });
});
