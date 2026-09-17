// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Data plane on the production host: long-poll the self-hosted environment's
// work queue and execute the agent's bash and file tools here. The worker
// holds only the environment key (never an organization API key), confines the
// file tools to the workspace plus the configured roots, and stops cleanly on
// SIGTERM so memory stores flush before exit.

import Anthropic from "@anthropic-ai/sdk";
import { EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments";
import { betaAgentToolset20260401, type AgentToolContext } from "@anthropic-ai/sdk/tools/agent-toolset/node";
import { existsSync, mkdirSync } from "node:fs";
import type { Config } from "../config.ts";
import { resolveFrom } from "../config.ts";
import { readCredential } from "../credentials.ts";
import { readLockfile, resolveResource } from "../lock.ts";

export function resolveEnvironmentId(cfg: Config): string {
  const fromEnv = process.env.ANTHROPIC_ENVIRONMENT_ID;
  if (fromEnv) return fromEnv;
  const lockfile = resolveFrom(cfg, cfg.lockfile);
  if (existsSync(lockfile)) {
    return resolveResource(readLockfile(lockfile), lockfile, cfg.session.environment, "environment").id;
  }
  throw new Error("environment id unknown: set ANTHROPIC_ENVIRONMENT_ID or ship the lockfile with the worker");
}

export async function worker(cfg: Config, opts: { once?: boolean }): Promise<number> {
  const environmentKey = readCredential("environment-key", "ANTHROPIC_ENVIRONMENT_KEY");
  if (!environmentKey) {
    console.error("no environment key: provide it as the systemd credential `environment-key` or ANTHROPIC_ENVIRONMENT_KEY");
    return 2;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.error("refusing to start: ANTHROPIC_API_KEY is set on the worker host; the worker must hold only the environment key");
    return 2;
  }
  const environmentId = resolveEnvironmentId(cfg);
  const { workdir, allowed_roots, read_only_roots, memory_sync_interval_ms, max_idle_ms } = cfg.worker;
  mkdirSync(workdir, { recursive: true });

  const client = new Anthropic({ authToken: environmentKey });
  const controller = new AbortController();
  const stop = (sig: string) => {
    console.error(`received ${sig}; finishing the in-flight tool call and flushing memory stores`);
    controller.abort();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  const tools = (ctx: AgentToolContext) => {
    ctx.allowedRoots = [...(ctx.allowedRoots ?? []), ...allowed_roots];
    ctx.readOnlyRoots = [...(ctx.readOnlyRoots ?? []), ...read_only_roots];
    return guardTools(betaAgentToolset20260401(ctx), cfg.worker.denied_paths);
  };

  const w = new EnvironmentWorker({
    client,
    environmentId,
    environmentKey,
    workdir,
    tools,
    maxIdleMs: max_idle_ms,
    memorySyncIntervalMs: memory_sync_interval_ms,
    signal: controller.signal,
    workerId: `swarm-agent@${process.env.HOSTNAME ?? "host"}`,
  });

  console.error(`worker polling ${environmentId} with workdir ${workdir}`);
  notifySystemd("READY=1");
  try {
    if (opts.once) await w.handleItem();
    else await w.run();
  } catch (err) {
    if (controller.signal.aborted) return 0;
    console.error(`worker failed: ${(err as Error).message}`);
    return 1;
  }
  notifySystemd("STOPPING=1");
  return 0;
}

/** Best-effort sd_notify over NOTIFY_SOCKET so Type=notify units see readiness. */
function notifySystemd(state: string): void {
  const sock = process.env.NOTIFY_SOCKET;
  if (!sock) return;
  try {
    const proc = Bun.spawn(["systemd-notify", state], { stdout: "ignore", stderr: "ignore" });
    void proc.exited;
  } catch {
    // systemd-notify absent; readiness falls back to Type=exec semantics.
  }
}

const PATH_KEYS = ["path", "file_path", "pattern", "glob", "directory", "cwd"];

/**
 * Wrap the file tools so any input path (or bash command text) that matches a
 * denied pattern is refused before execution. This runs on the worker host and
 * therefore applies regardless of the server-side permission policy, which is
 * what keeps `secrets/values` unreadable even for always_allow tools.
 */
export function guardTools<T extends { name: string; run: (input: any, ...rest: any[]) => any }>(tools: T[], deniedPatterns: string[]): T[] {
  if (deniedPatterns.length === 0) return tools;
  const regexes = deniedPatterns.map((p) => new RegExp(p));
  const offending = (input: Record<string, unknown>): string | null => {
    const candidates: string[] = [];
    for (const k of PATH_KEYS) if (typeof input[k] === "string") candidates.push(input[k] as string);
    if (typeof input.command === "string") candidates.push(input.command, ...input.command.split(/\s+/));
    for (const c of candidates) for (const re of regexes) if (re.test(c)) return c;
    return null;
  };
  return tools.map((tool) => ({
    ...tool,
    run: (input: any, ...rest: any[]) => {
      const hit = offending(input ?? {});
      if (hit) throw new Error(`refused by worker policy: ${tool.name} may not touch ${hit}`);
      return tool.run(input, ...rest);
    },
  }));
}
