// SPDX-License-Identifier: LGPL-2.1-or-later
//
// verify.sh reads the native render driver's expected.json and checks a
// host's rendered tree in dry-run without touching the system. The Quadlet
// engine needs Podman and is covered by the integration test.

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../skills/systemd-verify/scripts/verify.sh");
const native = resolve(import.meta.dir, "../../../../test/test-container-migration/rendered/native");

interface Check {
  status: "ok" | "warn" | "fail";
  check: string;
  detail: string;
}
interface Report {
  host: string;
  mode: string;
  engine: string;
  failures: number;
  warnings: number;
  checks: Check[];
}

function run(args: string[]): { code: number; report: Report; stderr: string } {
  const proc = Bun.spawnSync(["bash", script, "--json", ...args]);
  return { code: proc.exitCode, report: JSON.parse(proc.stdout.toString() || "{}") as Report, stderr: proc.stderr.toString() };
}

const analyze = Bun.spawnSync(["systemd-analyze", "--version"]);
const systemdVersion = Number(/systemd (\d+)/.exec(analyze.stdout.toString())?.[1] ?? 0);

describe("verify.sh, native engine", () => {
  test("dry-run finds every expected file in the rendered tree and reports what is still to import", () => {
    const { report } = run(["--expected", join(native, "expected.json"), "--host", "swarm-wrk-1", "--units", join(native, "hosts/swarm-wrk-1/etc/systemd/system"), "--dry-run"]);
    expect(report.engine).toBe("native");
    const files = report.checks.filter((c) => c.check === "unit-file");
    expect(files.length).toBe(14);
    expect(files.every((c) => c.status === "ok")).toBe(true);
    expect(files.map((c) => c.detail)).toContain("var-lib-data-data_backups.mount present");
    expect(report.checks.find((c) => c.check === "install-script")?.status).toBe("ok");
    // Images, credentials, and volumes are warnings before install, never failures.
    for (const kind of ["image", "credential", "volume"]) expect(report.checks.filter((c) => c.check === kind).every((c) => c.status === "warn")).toBe(true);
    expect(report.checks.filter((c) => c.check === "credential").map((c) => c.detail.split(" ")[0])).toEqual(["data_postgres_password", "web_app-app-secret-key", "web_app_signing_key"]);
    const sa = report.checks.find((c) => c.check === "systemd-analyze");
    expect(sa).toBeDefined();
    // The units use RootMStack= and PrivateUsers=self; a manager older than 260 rejects them, which is the point of the check.
    if (systemdVersion >= 260) expect(sa!.status).toBe("ok");
    else expect(sa!.detail).toMatch(/RootMStack|PrivateUsers/);
  });

  test("a unit missing from the tree is a failure and the exit code says so", () => {
    const dir = mkdtempSync(resolve(import.meta.dir, "../.tmp/verify-"));
    cpSync(join(native, "hosts/swarm-mgr-1"), join(dir, "swarm-mgr-1"), { recursive: true });
    unlinkSync(join(dir, "swarm-mgr-1/etc/systemd/system/web.target"));
    const { code, report } = run(["--expected", join(native, "expected.json"), "--host", "swarm-mgr-1", "--units", join(dir, "swarm-mgr-1/etc/systemd/system"), "--dry-run"]);
    expect(code).toBe(1);
    expect(report.checks.find((c) => c.check === "unit-file" && c.status === "fail")?.detail).toMatch(/^web\.target missing/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a command path that climbs out of the temporary root is never stubbed", () => {
    // A hostile capture could put ../ segments into ExecStart=; the stub for
    // it must not land outside the verifier's temporary root. The unit points
    // through the root's parents at a marker inside this test's directory.
    const dir = mkdtempSync(resolve(import.meta.dir, "../.tmp/verify-"));
    const units = join(dir, "units");
    cpSync(join(native, "hosts/swarm-mgr-1/etc/systemd/system"), units, { recursive: true });
    const marker = join(dir, "escaped-stub");
    const climb = "/../".repeat(12) + marker.replace(/^\//, "");
    writeFileSync(join(units, "web_proxy.service"), `[Unit]\nDescription=x\n[Service]\nExecStart=${climb}\nExecStartPre=/usr/bin/../../..${marker}\nExecStartPost=/usr/bin//sh\n`);
    const expected = join(dir, "expected.json");
    writeFileSync(expected, JSON.stringify({ h: { hostname: "h", units: ["web_proxy.service"], root_kind: "RootImage" } }));
    const { report } = run(["--expected", expected, "--host", "h", "--units", units, "--dry-run"]);
    expect(report.checks.find((c) => c.check === "unit-file")?.status).toBe("ok");
    expect(existsSync(marker)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unknown host and an unknown engine are usage errors", () => {
    const unknown = Bun.spawnSync(["bash", script, "--expected", join(native, "expected.json"), "--host", "nowhere", "--dry-run"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr.toString()).toContain("known: swarm-mgr-1, swarm-wrk-1");
    const engine = Bun.spawnSync(["bash", script, "--expected", join(native, "expected.json"), "--host", "swarm-mgr-1", "--engine", "docker"]);
    expect(engine.exitCode).toBe(2);
  });

  test("the Quadlet shape under .hosts selects the quadlet engine", () => {
    const dir = mkdtempSync(resolve(import.meta.dir, "../.tmp/verify-"));
    const expected = join(dir, "expected.json");
    writeFileSync(expected, JSON.stringify({ hosts: { h: { hostname: "h", units: ["a.service"], containers: ["a"], ports: [], networks: [], volumes: [], secrets: [], targets: [] } } }));
    const { report } = run(["--expected", expected, "--host", "h", "--units", dir, "--dry-run"]);
    expect(report.engine).toBe("quadlet");
    expect(report.checks.find((c) => c.check === "unit-file")?.detail).toBe("a.container missing from " + dir);
    rmSync(dir, { recursive: true, force: true });
  });
});
