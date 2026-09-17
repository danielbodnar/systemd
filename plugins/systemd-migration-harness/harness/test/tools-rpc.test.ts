import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { remoteTools } from "../src/tools/client.ts";
import { serveTools } from "../src/tools/server.ts";

// The socket lives under the harness's own .tmp/ (ignored by git), never /tmp.
const scratch = mkdtempSync(resolve(import.meta.dir, "../.tmp/rpc-"));
const socketPath = join(scratch, "t.sock");
const workdir = join(scratch, "work");
const controller = new AbortController();
let server: Promise<void>;

beforeAll(async () => {
  mkdirSync(join(workdir, "secrets", "values"), { recursive: true });
  writeFileSync(join(workdir, "hello.txt"), "hi from the workspace\n");
  writeFileSync(join(workdir, "secrets", "values", "pg"), "hunter\n");
  await new Promise<void>((ready) => {
    server = serveTools({ socketPath, deniedPatterns: ["(^|/)secrets/values(/|$)"], signal: controller.signal, onListening: ready });
  });
});

afterAll(async () => {
  controller.abort();
  await server;
  rmSync(scratch, { recursive: true, force: true });
});

describe("tool executor round trip", () => {
  test("the worker-side proxies expose the toolset names and forward calls", async () => {
    const tools = remoteTools(socketPath, { workdir });
    expect(tools.map((t) => t.name).sort()).toEqual(["bash", "edit", "glob", "grep", "read", "write"]);
    const read = tools.find((t) => t.name === "read")!;
    const out = await read.run(read.parse({ file_path: "hello.txt" }));
    expect(JSON.stringify(out)).toContain("hi from the workspace");
    const bash = tools.find((t) => t.name === "bash")!;
    const echoed = await bash.run(bash.parse({ command: "echo executor-ok" }));
    expect(JSON.stringify(echoed)).toContain("executor-ok");
    await tools[0].close?.();
  });
  test("the executor's guard refuses denied paths and reports the refusal", async () => {
    const tools = remoteTools(socketPath, { workdir });
    const read = tools.find((t) => t.name === "read")!;
    await expect(read.run(read.parse({ file_path: "secrets/values/pg" }))).rejects.toThrow(/refused by worker policy/);
    await tools[0].close?.();
  });
  test("a missing executor fails the call rather than hanging", async () => {
    const tools = remoteTools(join(scratch, "absent.sock"), { workdir });
    const read = tools.find((t) => t.name === "read")!;
    await expect(read.run(read.parse({ file_path: "hello.txt" }))).rejects.toThrow(/unreachable/);
  });
});

describe("executor peer authentication", () => {
  test("the executor writes a per-start token next to the socket and the worker presents it", async () => {
    const { readFileSync, statSync } = await import("node:fs");
    const token = readFileSync(`${socketPath}.token`, "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(`${socketPath}.token`).mode & 0o777).toBe(0o640);
    const tools = remoteTools(socketPath, { workdir }, token);
    const read = tools.find((t) => t.name === "read")!;
    expect(JSON.stringify(await read.run(read.parse({ file_path: "hello.txt" })))).toContain("hi from the workspace");
    await tools[0].close?.();
  });
  test("a peer without the token is refused before any tool runs", async () => {
    const tools = remoteTools(socketPath, { workdir }, "");
    const read = tools.find((t) => t.name === "read")!;
    await expect(read.run(read.parse({ file_path: "hello.txt" }))).rejects.toThrow(/hello rejected/);
    await tools[0].close?.();
  });
  test("a peer with a wrong token is refused", async () => {
    const tools = remoteTools(socketPath, { workdir }, "0".repeat(64));
    const bash = tools.find((t) => t.name === "bash")!;
    await expect(bash.run(bash.parse({ command: "echo should-not-run" }))).rejects.toThrow(/hello rejected/);
    await tools[0].close?.();
  });
});
