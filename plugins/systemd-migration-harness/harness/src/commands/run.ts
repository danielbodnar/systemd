// SPDX-License-Identifier: LGPL-2.1-or-later
import Anthropic from "@anthropic-ai/sdk";
import { hostname } from "node:os";
import { loadPolicy } from "../approvals.ts";
import type { Config } from "../config.ts";
import { resolveFrom } from "../config.ts";
import { environmentType, readLockfile, resolveResource } from "../lock.ts";
import { runSession } from "../session.ts";
import { TASKS } from "../tasks.ts";

export interface RunArgs {
  task?: string;
  message?: string;
  agent?: string;
  environment?: string;
  title?: string;
  noRubric?: boolean;
  nonInteractive?: boolean;
  approveAll?: boolean;
  budgetCents?: string;
  noMemory?: boolean;
}

export async function run(cfg: Config, args: RunArgs): Promise<number> {
  const task = args.task ? TASKS[args.task] : undefined;
  if (args.task && !task) {
    console.error(`unknown task ${args.task}; known: ${Object.keys(TASKS).join(", ")}`);
    return 2;
  }
  if (!task && !args.message) {
    console.error("pass a task name or --message");
    return 2;
  }
  const lockfile = resolveFrom(cfg, cfg.lockfile);
  const lock = readLockfile(lockfile);
  const agentPath = args.agent ?? task?.agent ?? cfg.session.agent;
  const agent = resolveResource(lock, lockfile, agentPath, "agent");
  const environmentPath = args.environment ?? cfg.session.environment;
  const environment = resolveResource(lock, lockfile, environmentPath, "environment");
  const memory = !args.noMemory && cfg.session.memory_store
    ? resolveResource(lock, lockfile, cfg.session.memory_store, "memory_store")
    : undefined;
  const policy = loadPolicy(resolveFrom(cfg, cfg.session.approvals));
  const workspace = lock.origin?.workspace_id ?? cfg.workspace;

  if (args.approveAll) {
    // The switch is a lab convenience. A self-hosted environment executes tools
    // on a real host, so it is refused there outright, and an environment whose
    // definition cannot be read is treated the same way.
    const type = environmentType(lockfile, environmentPath);
    if (type !== "cloud") {
      console.error(`--approve-all is refused for ${environmentPath}: only cloud lab environments accept it (config.type is ${type ?? "unreadable"})`);
      return 2;
    }
    console.error("warning: --approve-all answers every tool ask with allow on this cloud lab environment");
  }

  const result = await runSession({
    client: new Anthropic(),
    agentId: agent.id,
    agentVersion: agent.version ? Number(agent.version) : undefined,
    environmentId: environment.id,
    title: args.title ?? task?.title ?? `swarm-agent on ${hostname()}`,
    message: args.message ?? task?.message,
    rubric: args.noRubric || args.message ? undefined : task?.rubric,
    maxIterations: task?.max_iterations,
    memoryStoreId: memory?.id,
    budgetCents: args.budgetCents ?? cfg.session.budget_cents,
    policy,
    interactive: !args.nonInteractive,
    approveAll: args.approveAll,
    workspace,
    metadata: { task: task?.name ?? "ad-hoc", host: hostname(), agent_path: agentPath },
  });
  if (result.stopReason === "retries_exhausted") return 1;
  if (result.outcome && result.outcome !== "passed" && result.outcome !== "success") return 3;
  return 0;
}
