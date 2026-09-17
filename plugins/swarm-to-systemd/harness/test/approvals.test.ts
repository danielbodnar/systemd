import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { evaluate, loadPolicy, shellSegments, subjectOf } from "../src/approvals.ts";

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

describe("shell operator handling", () => {
  test("a denied token anywhere in a chain denies the whole command", () => {
    expect(evaluate(policy, "bash", { command: "docker service ls; docker service rm web_app" }).decision).toBe("deny");
    expect(evaluate(policy, "bash", { command: "ls && systemctl restart web_app.service" }).decision).toBe("deny");
  });
  test("an unmatched segment in a chain falls back to ask", () => {
    expect(evaluate(policy, "bash", { command: "docker service ls; touch /etc/pwned" }).decision).toBe("ask");
    expect(evaluate(policy, "bash", { command: "ls; curl http://x" }).decision).toBe("ask");
  });
  test("a chain of allowed commands is allowed", () => {
    expect(evaluate(policy, "bash", { command: "docker node ls && docker service ls" }).decision).toBe("allow");
  });
  test("substitution and redirection never ride an allow rule", () => {
    expect(evaluate(policy, "bash", { command: "cat $(echo /etc/shadow)" }).decision).toBe("ask");
    expect(evaluate(policy, "bash", { command: "ls > /etc/cron.d/x" }).decision).toBe("ask");
    expect(evaluate(policy, "bash", { command: "cat `ls`" }).decision).toBe("ask");
  });
  test("shellSegments splits on control operators", () => {
    expect(shellSegments("a; b && c || d | e & f\ng")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
});
