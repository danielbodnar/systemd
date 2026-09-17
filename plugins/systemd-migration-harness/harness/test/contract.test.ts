// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Every plugin that carries contract/CHECKSUMS holds a vendored copy of the
// inventory contract. This test fails when a copy drifts from the source so
// that scripts/sync-contract.sh is run before the drift ships.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pluginsDir = resolve(import.meta.dir, "../../..");
const sourceDir = join(pluginsDir, "docker-swarm-to-systemd", "contract");
const files = ["inventory-schema.json", "types.ts", "schema.ts", "directives.json", "catalog.ts"];

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const consumers = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "docker-swarm-to-systemd")
  .map((d) => join(pluginsDir, d.name, "contract"))
  .filter((dir) => existsSync(join(dir, "CHECKSUMS")));

describe("vendored inventory contract", () => {
  test("the source has every contract file", () => {
    for (const f of files) expect(existsSync(join(sourceDir, f))).toBe(true);
  });

  test("at least one plugin vendors the contract", () => {
    expect(consumers.length).toBeGreaterThan(0);
  });

  for (const dir of consumers) {
    const plugin = dir.split("/").at(-2);
    test(`${plugin}/contract matches the source byte for byte`, () => {
      for (const f of files) {
        const src = readFileSync(join(sourceDir, f));
        const copy = readFileSync(join(dir, f));
        expect(sha256(copy)).toBe(sha256(src));
      }
    });

    test(`${plugin}/contract/CHECKSUMS lists every file with its current hash`, () => {
      const listed = new Map<string, string>();
      for (const line of readFileSync(join(dir, "CHECKSUMS"), "utf8").split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
        expect(m).not.toBeNull();
        listed.set(m![2]!, m![1]!);
      }
      for (const f of files) {
        expect(listed.get(f)).toBe(sha256(readFileSync(join(dir, f))));
      }
    });
  }
});
