// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The committed fixtures under test/test-container-migration/ (the
// normalized inventory and the rendered native tree) are what the
// integration test consumes, so they must match what the scripts produce
// today. plugins/scripts/render-fixtures.sh regenerates them.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { render } from "../../skills/systemd-service/scripts/render.ts";

const fixture = resolve(import.meta.dir, "../../../../test/test-container-migration");

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

describe("committed fixtures", () => {
  test("inventory.json is a fresh normalize of the capture", () => {
    const fresh = normalize(join(fixture, "capture"));
    const committed = JSON.parse(readFileSync(join(fixture, "inventory.json"), "utf8")) as Inventory;
    expect(committed).toEqual(fresh);
  });

  test("inventory.json carries no secret value", () => {
    const text = readFileSync(join(fixture, "inventory.json"), "utf8");
    expect(text).not.toContain("fixture-placeholder-not-a-secret");
  });

  test("rendered/native is a fresh render of the inventory", () => {
    const inv = JSON.parse(readFileSync(join(fixture, "inventory.json"), "utf8")) as Inventory;
    const fresh = render(inv);
    const dir = join(fixture, "rendered", "native");
    expect(existsSync(dir)).toBe(true);
    expect(walk(dir)).toEqual(Object.keys(fresh.files).sort());
    for (const [rel, content] of Object.entries(fresh.files)) {
      expect(readFileSync(join(dir, rel), "utf8"), rel).toBe(content);
    }
  });
});
