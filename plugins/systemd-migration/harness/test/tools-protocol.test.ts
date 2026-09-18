import { describe, expect, test } from "bun:test";
import { encode, LineDecoder, RequestSchema, ResponseSchema } from "../src/tools/protocol.ts";

describe("tool protocol framing", () => {
  test("messages round-trip one per line and survive chunk boundaries", () => {
    const a = encode({ type: "hello", ctx: { workdir: "/w", allowedRoots: [], readOnlyRoots: [] } });
    const b = encode({ type: "call", id: 1, tool: "read", input: { path: "x" } });
    const whole = a + b;
    const d = new LineDecoder();
    const first = d.feed(whole.slice(0, 10));
    const second = d.feed(whole.slice(10));
    expect(first).toEqual([]);
    expect(second.length).toBe(2);
    expect(RequestSchema.parse(second[0])).toMatchObject({ type: "hello" });
    expect(RequestSchema.parse(second[1])).toMatchObject({ type: "call", id: 1, tool: "read" });
  });
  test("schemas reject unknown message types", () => {
    expect(RequestSchema.safeParse({ type: "exec", id: 1 }).success).toBe(false);
    expect(ResponseSchema.safeParse({ type: "result", id: "x" }).success).toBe(false);
  });
});
