// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Preflight for both roles. On the operator machine: ant, credentials, the
// lockfile, and every resource the config references. On a worker host: the
// environment key, the workspace, and the host tooling the skills need.

import { existsSync } from "node:fs";
import type { Config } from "../config.ts";
import { resolveFrom } from "../config.ts";
import { readCredential } from "../credentials.ts";
import { readLockfile, resolveResource } from "../lock.ts";
import { antVersion, versionAtLeast } from "./apply.ts";

async function has(cmd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["sh", "-c", `command -v ${cmd}`], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || null;
  } catch {
    return null;
  }
}

export async function doctor(cfg: Config, opts: { host?: boolean }): Promise<number> {
  let problems = 0;
  const ok = (m: string) => console.log(`ok    ${m}`);
  const bad = (m: string) => { problems += 1; console.log(`fail  ${m}`); };
  const warn = (m: string) => console.log(`warn  ${m}`);

  ok(`config ${cfg.path}`);
  console.log(`bun   ${Bun.version}`);

  if (!opts.host) {
    const v = await antVersion();
    if (!v) bad("ant CLI not found (needed for `apply` and `connect`)");
    else if (!versionAtLeast(v, [1, 30, 0])) bad(`ant ${v} predates ant apply (1.30.0)`);
    else ok(`ant ${v}`);
    if (v) {
      const proc = Bun.spawn(["ant", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      console.log(out.split("\n").map((l) => `      ${l}`).join("\n"));
    }
    const lockfile = resolveFrom(cfg, cfg.lockfile);
    if (!existsSync(lockfile)) {
      bad(`lockfile ${lockfile} missing; run \`swarm-agent apply\``);
    } else {
      const lock = readLockfile(lockfile);
      ok(`lockfile with ${Object.keys(lock.resources).length} resources`);
      for (const [label, path, kind] of [
        ["agent", cfg.session.agent, "agent"],
        ["environment", cfg.session.environment, "environment"],
        ...(cfg.session.memory_store ? [["memory store", cfg.session.memory_store, "memory_store"]] : []),
      ] as [string, string, string][]) {
        try {
          const r = resolveResource(lock, lockfile, path, kind);
          ok(`${label} ${path} -> ${r.id}`);
        } catch (e) {
          bad((e as Error).message);
        }
      }
    }
    if (!existsSync(resolveFrom(cfg, cfg.session.approvals))) bad(`approval policy ${cfg.session.approvals} missing`);
    else ok(`approval policy ${cfg.session.approvals}`);
  } else {
    if (readCredential("environment-key", "ANTHROPIC_ENVIRONMENT_KEY")) ok("environment key available");
    else bad("environment key missing (systemd credential `environment-key` or ANTHROPIC_ENVIRONMENT_KEY)");
    if (process.env.ANTHROPIC_API_KEY) bad("ANTHROPIC_API_KEY is set; remove it from the worker host");
    if (process.env.ANTHROPIC_ENVIRONMENT_ID) ok(`environment id from ANTHROPIC_ENVIRONMENT_ID`);
    else if (existsSync(resolveFrom(cfg, cfg.lockfile))) ok("environment id resolvable from lockfile");
    else bad("environment id unknown: set ANTHROPIC_ENVIRONMENT_ID or ship the lockfile");
    if (existsSync(cfg.worker.workdir)) ok(`workdir ${cfg.worker.workdir}`);
    else warn(`workdir ${cfg.worker.workdir} does not exist yet; the worker creates it`);
    if (cfg.worker.memory_sync_interval_ms !== null) {
      if (existsSync("/mnt/memory")) ok("/mnt/memory present for memory stores");
      else warn("/mnt/memory missing; create it writable by the worker user or set memory_sync_interval_ms: null");
    }
    for (const tool of ["bash", "docker", "podman", "jq", "systemd-analyze", "unzip", "tar"]) {
      const p = await has(tool);
      if (p) ok(`${tool} at ${p}`);
      else if (tool === "docker") warn("docker not found; the auditor cannot capture from this host");
      if (tool === "docker" && p && !process.env.DOCKER_HOST) warn("DOCKER_HOST unset; the worker has no socket access, so point it at a read-only proxy or copy a capture into the workspace");
      else if (tool === "podman" || tool === "systemd-analyze") warn(`${tool} not found; the verifier cannot run here`);
      else bad(`${tool} not found`);
    }
  }
  console.log(problems === 0 ? "doctor: no problems" : `doctor: ${problems} problem(s)`);
  return problems === 0 ? 0 : 1;
}
