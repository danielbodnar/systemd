import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { environmentType, lockKey, readLockfile, resolveResource } from "../src/lock.ts";

const lockfile = resolve(import.meta.dir, "../fixtures/claude-lock.json");

describe("lockfile", () => {
  test("keys are normalized to ./relative form", () => {
    expect(lockKey(lockfile, "agents/migration-lead.md")).toBe("./agents/migration-lead.md");
    expect(lockKey(lockfile, "./agents/migration-lead.md")).toBe("./agents/migration-lead.md");
  });
  test("resolves ids and kinds", () => {
    const lock = readLockfile(lockfile);
    expect(resolveResource(lock, lockfile, "./agents/migration-lead.md", "agent").id).toBe("agent_lead");
    expect(resolveResource(lock, lockfile, "environments/production-host.yaml", "environment").id).toBe("env_prod");
    expect(() => resolveResource(lock, lockfile, "./agents/migration-lead.md", "environment")).toThrow(/expected environment/);
    expect(() => resolveResource(lock, lockfile, "./agents/missing.md")).toThrow(/not in the lockfile/);
  });
});

describe("environment type", () => {
  const harnessLock = resolve(import.meta.dir, "../claude-lock.json");
  test("reads config.type from the environment definition", () => {
    expect(environmentType(harnessLock, "./environments/lab-cloud.yaml")).toBe("cloud");
    expect(environmentType(harnessLock, "./environments/production-host.yaml")).toBe("self_hosted");
  });
  test("an unreadable definition yields undefined so callers fail closed", () => {
    expect(environmentType(harnessLock, "./environments/missing.yaml")).toBeUndefined();
  });
});
