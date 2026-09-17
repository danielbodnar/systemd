import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSchema } from "../../skills/swarm-capture/scripts/schema.ts";

const schema = JSON.parse(readFileSync(resolve(import.meta.dir, "../../skills/swarm-capture/references/inventory-schema.json"), "utf8"));
const example = JSON.parse(readFileSync(resolve(import.meta.dir, "../../skills/swarm-capture/references/example-inventory.json"), "utf8"));

describe("schema validator", () => {
  test("the example inventory validates", () => {
    expect(validateSchema(example, schema)).toEqual([]);
  });
  test("type, enum, pattern, and required are enforced", () => {
    const s = { type: "object", required: ["a"], properties: { a: { type: "integer", minimum: 1 }, b: { enum: ["x"] }, c: { type: "string", pattern: "^\\d+s$" } }, additionalProperties: false };
    expect(validateSchema({ a: 2, b: "x", c: "30s" }, s)).toEqual([]);
    const errors = validateSchema({ a: 0, b: "y", c: "soon", d: 1 }, s);
    expect(errors.map((e) => e.path).sort()).toEqual(["$.a", "$.b", "$.c", "$.d"]);
    expect(validateSchema({}, s)[0]).toEqual({ path: "$.a", message: "required" });
  });
  test("$ref into $defs and nullable types resolve", () => {
    const s = { $defs: { d: { type: ["string", "null"] } }, type: "array", items: { $ref: "#/$defs/d" } };
    expect(validateSchema(["a", null], s)).toEqual([]);
    expect(validateSchema([1], s)).toHaveLength(1);
  });
});
