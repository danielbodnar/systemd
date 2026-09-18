// SPDX-License-Identifier: LGPL-2.1-or-later
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const WorkerSchema = z.object({
  workdir: z.string().default("/var/lib/swarm-agent/workspace"),
  allowed_roots: z.array(z.string()).default([]),
  read_only_roots: z.array(z.string()).default([]),
  memory_sync_interval_ms: z.number().int().min(5000).nullable().default(15000),
  max_idle_ms: z.number().int().positive().default(900_000),
  tools_socket: z.string().default("/run/swarm-agent/tools.sock"),
  denied_paths: z.array(z.string()).default(["(^|/)secrets/values(/|$)", "^/etc/credstore", "^/run/credentials"]),
});

const SessionSchema = z.object({
  agent: z.string(),
  environment: z.string(),
  memory_store: z.string().optional(),
  budget_cents: z.string().regex(/^[1-9]\d*$/).optional(),
  approvals: z.string().default("./approvals.yaml"),
});

export const ConfigSchema = z.object({
  lockfile: z.string().default("./claude-lock.json"),
  workspace: z.string().default("default"),
  worker: WorkerSchema.prefault({}),
  session: SessionSchema,
});

export type Config = z.infer<typeof ConfigSchema> & { base_dir: string; path: string };

export function loadConfig(path: string): Config {
  const abs = resolve(path);
  const raw = parse(readFileSync(abs, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config ${abs}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return { ...parsed.data, base_dir: dirname(abs), path: abs };
}

export function resolveFrom(cfg: Config, p: string): string {
  return resolve(cfg.base_dir, p);
}
