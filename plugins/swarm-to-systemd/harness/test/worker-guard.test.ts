import { describe, expect, test } from "bun:test";
import { guardTools } from "../src/commands/worker.ts";

const denied = ["(^|/)secrets/values(/|$)", "^/etc/credstore"];
const tools: { name: string; run: (input: any) => string }[] = [
  { name: "read", run: (input: { path: string }) => `read ${input.path}` },
  { name: "bash", run: (input: { command: string }) => `ran ${input.command}` },
];

describe("worker path guard", () => {
  const guarded = guardTools(tools, denied);
  test("ordinary paths pass through", () => {
    expect(guarded[0].run({ path: "/var/lib/swarm-agent/workspace/inventory.json" })).toBe("read /var/lib/swarm-agent/workspace/inventory.json");
  });
  test("denied paths are refused for file tools and bash alike", () => {
    expect(() => guarded[0].run({ path: "/tmp/x/secrets/values/pg" })).toThrow(/refused by worker policy/);
    expect(() => guarded[1].run({ command: "cat /etc/credstore/key" })).toThrow(/refused by worker policy/);
  });
  test("an empty pattern list returns the tools untouched", () => {
    expect(guardTools(tools, [])).toBe(tools);
  });
});
