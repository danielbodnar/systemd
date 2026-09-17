// SPDX-License-Identifier: LGPL-2.1-or-later
//
// probe.sh must produce a host file the plan schema accepts and the planner
// can reason from; it runs against this machine, whatever it is.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { composePlan } from "../../contract/compose.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import { type HostCapabilities, validatePlan } from "../../contract/plan.ts";
import { rootFormId } from "../../skills/systemd-machined/scripts/component.ts";
import { loadHosts } from "../../scripts/plan.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";

const script = resolve(import.meta.dir, "../../skills/discover-systemd-hosts/scripts/probe.sh");
const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");

describe("discover-systemd-hosts probe", () => {
  const dir = mkdtempSync(resolve(import.meta.dir, "../.tmp/probe-"));
  const proc = Bun.spawnSync(["bash", script, "-o", dir]);
  const ok = proc.exitCode === 0;

  test("runs read-only on this host and writes <hostname>.json", () => {
    expect(ok, proc.stderr.toString()).toBe(true);
    const files = Object.keys(loadHosts(dir));
    expect(files.length).toBe(1);
  });

  test("the file is a host the plan schema accepts, with the fields the planner reads", () => {
    if (!ok) return;
    const hosts = loadHosts(dir);
    const caps = Object.values(hosts)[0] as HostCapabilities;
    expect(caps.systemd.version).toBeGreaterThan(200);
    expect(caps.kernel.major).toBeGreaterThan(0);
    expect(typeof caps.cgroup_v2).toBe("boolean");
    expect(["boolean", "object"]).toContain(typeof caps.overlayfs_fsconfig);
    expect(Object.keys(caps.daemons)).toContain("networkd");
    expect(Object.keys(caps.tools)).toContain("systemd-nspawn");
    expect(caps.notes!.some((n) => n.startsWith("systemd-networkd.service:"))).toBe(true);
    const plan = { version: 1 as const, generated_at: "x", generated_by: "x", inventory: { captured_at: "x", services: 0, networks: 0, nodes: 0 }, hosts: { [caps.hostname]: caps }, decisions: [] };
    expect(validatePlan(plan)).toEqual([]);
  });

  test("the planner turns the probe into evidence and a root-form default", () => {
    if (!ok) return;
    const hosts = loadHosts(dir);
    const caps = Object.values(hosts)[0] as HostCapabilities;
    const inv = normalize(capture);
    const { plan } = composePlan(inv, COMPONENTS, { hosts });
    const d = plan.decisions.find((x) => x.id === rootFormId(caps.hostname))!;
    expect(d).toBeDefined();
    const canStack = caps.systemd.version >= 260 && caps.overlayfs_fsconfig !== false;
    expect(d.default).toBe(canStack ? "mstack" : "ddi");
    expect(d.evidence!.some((e) => e.includes(`systemd.version=${caps.systemd.version}`))).toBe(true);
  });

  test("a remote probe is filed under the host name the operator gave, not the name the remote printed", () => {
    // A fake ssh stands in for the remote side: it ignores the script on
    // stdin and answers with a hostname chosen to escape the output directory.
    const fake = mkdtempSync(resolve(import.meta.dir, "../.tmp/fake-ssh-"));
    writeFileSync(join(fake, "ssh"), [
      "#!/bin/sh",
      "cat >/dev/null",
      'printf \'{\\n  "hostname": "../../escaped",\\n  "systemd": {"version": 262},\\n  "kernel": {"release": "6.18.0", "major": 6, "minor": 18},\\n  "arch": "x86_64",\\n  "cgroup_v2": true,\\n  "overlayfs_fsconfig": true,\\n  "daemons": {},\\n  "tools": {}\\n}\\n\'',
      "",
    ].join("\n"));
    chmodSync(join(fake, "ssh"), 0o755);
    const out = mkdtempSync(resolve(import.meta.dir, "../.tmp/probe-remote-"));
    const remote = Bun.spawnSync(["bash", script, "-o", out, "--ssh", "operator@node-a.example", "--ssh", "bad/../name"], { env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } });
    expect(remote.exitCode, remote.stderr.toString()).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["bad_.._name.json", "node-a.example.json"]);
    expect(existsSync(resolve(out, "../../escaped.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, "node-a.example.json"), "utf8")).hostname).toBe("../../escaped");
    rmSync(fake, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  test("cleanup", () => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    expect(existsSync(join(dir, "x"))).toBe(false);
  });
});

