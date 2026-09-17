// SPDX-License-Identifier: LGPL-2.1-or-later
import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import type { Config } from "../config.ts";
import { resolveFrom } from "../config.ts";
import { readLockfile, resolveResource } from "../lock.ts";

export async function status(cfg: Config, opts: { limit?: number; queue?: boolean }): Promise<number> {
  const client = new Anthropic();
  const limit = opts.limit ?? 10;
  let shown = 0;
  console.log("session".padEnd(30), "status".padEnd(12), "updated".padEnd(22), "cost", " title");
  for await (const s of client.beta.sessions.list()) {
    if (s.metadata?.harness !== "systemd-migration-harness") continue;
    const cost = s.usage?.list_cost ? `${(Number(s.usage.list_cost.amount) / 100).toFixed(2)}` : "-";
    console.log(s.id.padEnd(30), s.status.padEnd(12), (s.updated_at ?? "").slice(0, 19).padEnd(22), cost.padStart(6), ` ${s.title ?? ""}`);
    if (++shown >= limit) break;
  }
  if (shown === 0) console.log("(no sessions created by this harness)");

  if (opts.queue) {
    const lockfile = resolveFrom(cfg, cfg.lockfile);
    if (!existsSync(lockfile)) {
      console.error("no lockfile; cannot resolve the environment for queue stats");
      return 1;
    }
    const env = resolveResource(readLockfile(lockfile), lockfile, cfg.session.environment, "environment");
    const stats = await client.beta.environments.work.stats(env.id);
    console.log(`work queue for ${env.id}: depth=${stats.depth} pending=${stats.pending} workers_polling=${stats.workers_polling} oldest_queued_at=${stats.oldest_queued_at ?? "-"}`);
  }
  return 0;
}
