// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Control plane: reconcile the agents, environments, skills, memory stores,
// and deployments declared in this directory with the API through `ant apply`.
// The harness never calls agents.create() itself; the lockfile ant writes is
// the record of what exists.

import { existsSync } from "node:fs";
import type { Config } from "../config.ts";
import { resolveFrom } from "../config.ts";
import { readLockfile } from "../lock.ts";

const MIN_ANT = [1, 30, 0] as const;

export async function antVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ant", "--version"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? m[0] : out || null;
  } catch {
    return null;
  }
}

export function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) > min[i]) return true;
    if ((parts[i] ?? 0) < min[i]) return false;
  }
  return true;
}

export async function apply(cfg: Config, opts: { dryRun?: boolean; yes?: boolean; prune?: boolean; force?: boolean }): Promise<number> {
  const version = await antVersion();
  if (!version) {
    console.error("the `ant` CLI is not installed; see https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart");
    return 2;
  }
  if (!versionAtLeast(version, MIN_ANT)) {
    console.error(`ant ${version} is too old; ant apply needs ${MIN_ANT.join(".")} or later`);
    return 2;
  }
  const lockfile = resolveFrom(cfg, cfg.lockfile);
  const args = ["ant", "apply", "--lock-file", lockfile];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.yes) args.push("--yes");
  if (opts.prune) args.push("--prune");
  if (opts.force) args.push("--force");
  args.push(cfg.base_dir);
  console.error(`$ ${args.join(" ")}`);
  const proc = Bun.spawn(args, { cwd: cfg.base_dir, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code === 0 && !opts.dryRun && existsSync(lockfile)) {
    const lock = readLockfile(lockfile);
    console.error("resources in the lockfile:");
    for (const [path, res] of Object.entries(lock.resources)) {
      console.error(`  ${res.kind.padEnd(13)} ${res.id.padEnd(34)} ${path}${res.version ? ` (v${res.version})` : ""}`);
    }
  }
  return code;
}
