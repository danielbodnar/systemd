import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { evaluate, loadPolicy, subjectOf } from "../src/approvals.ts";

const policy = loadPolicy(resolve(import.meta.dir, "../approvals.yaml"));

describe("approval policy", () => {
  test("read-only docker inspection is allowed", () => {
    expect(evaluate(policy, "bash", { command: "docker service ls --format '{{json .}}'" }).decision).toBe("allow");
    expect(evaluate(policy, "bash", { command: "docker node inspect n1" }).decision).toBe("allow");
  });
  test("mutating docker and systemctl calls are denied", () => {
    expect(evaluate(policy, "bash", { command: "docker service update --replicas 0 web_app" }).decision).toBe("deny");
    expect(evaluate(policy, "bash", { command: "systemctl restart web_app.service" }).decision).toBe("deny");
    expect(evaluate(policy, "bash", { command: "bash hosts/x/install.sh --start" }).decision).toBe("deny");
  });
  test("plugin scripts are allowed", () => {
    expect(evaluate(policy, "bash", { command: "bun /opt/swarm-agent/skills/swarm-to-quadlet/scripts/render.ts inventory.json -o rendered" }).decision).toBe("allow");
  });
  test("secret values are denied for bash and read", () => {
    expect(evaluate(policy, "bash", { command: "cat hosts/a/secrets/values/pg" }).decision).toBe("deny");
    expect(evaluate(policy, "read", { path: "rendered/hosts/a/secrets/values/pg" }).decision).toBe("deny");
  });
  test("unknown commands fall through to the default", () => {
    const v = evaluate(policy, "bash", { command: "curl https://example.com" });
    expect(v.decision).toBe("ask");
    expect(v.rule).toBeUndefined();
  });
  test("subject extraction", () => {
    expect(subjectOf("bash", { command: "ls" })).toBe("ls");
    expect(subjectOf("read", { path: "/x" })).toBe("/x");
    expect(subjectOf("glob", { pattern: "*.ts" })).toBe('{"pattern":"*.ts"}');
  });
});
