// SPDX-License-Identifier: LGPL-2.1-or-later
//
// pull-images.sh must pull by the digest the inventory recorded whenever
// there is one; the dry run shows the exact importctl invocation.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../skills/systemd-machined/scripts/pull-images.sh");

function dryRun(images: Record<string, { ref: string; digest: string | null; hosts: string[] }>, extra: string[] = []): string {
  const dir = mkdtempSync(resolve(import.meta.dir, "../.tmp/pull-"));
  try {
    const file = join(dir, "images.json");
    writeFileSync(file, JSON.stringify(images));
    // A fake importctl on PATH so the script's presence check passes here.
    writeFileSync(join(dir, "importctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const proc = Bun.spawnSync(["bash", script, file, "--dry-run", ...extra], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    return proc.stdout.toString() + proc.stderr.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pull-images.sh", () => {
  const digest = "sha256:" + "a".repeat(64);
  test("pulls by digest when the inventory recorded one", () => {
    const out = dryRun({ "acme-app_2026.09": { ref: "registry.example.com/acme/app:2026.09", digest, hosts: ["h1"] } });
    expect(out).toContain(`pull-oci registry.example.com/acme/app@${digest} acme-app_2026.09`);
    expect(out).not.toContain("app:2026.09 acme-app");
  });
  test("keeps a registry port and drops only the tag", () => {
    const out = dryRun({ x: { ref: "localhost:5000/team/app:v1", digest, hosts: ["h1"] } });
    expect(out).toContain(`pull-oci localhost:5000/team/app@${digest} x`);
  });
  test("replaces an existing digest suffix rather than stacking it", () => {
    const out = dryRun({ x: { ref: "docker.io/library/caddy@sha256:" + "b".repeat(64), digest, hosts: ["h1"] } });
    expect(out).toContain(`pull-oci docker.io/library/caddy@${digest} x`);
  });
  test("pulls by tag, and says so, when there is no digest", () => {
    const out = dryRun({ "library-caddy_2": { ref: "docker.io/library/caddy:2", digest: null, hosts: ["h1"] } });
    expect(out).toContain("pull-oci docker.io/library/caddy:2 library-caddy_2");
    expect(out).toContain("the tag is mutable");
  });
  test("--host restricts to the images that host runs", () => {
    const out = dryRun({ a: { ref: "r/a:1", digest: null, hosts: ["h1"] }, b: { ref: "r/b:1", digest: null, hosts: ["h2"] } }, ["--host", "h2"]);
    expect(out).toContain("pull-oci r/b:1 b");
    expect(out).not.toContain("pull-oci r/a:1 a");
  });
});
