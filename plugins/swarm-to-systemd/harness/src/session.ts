// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Drives one Managed Agents session from the operator's machine: creates it,
// opens the stream before sending the kickoff, consolidates history so a
// dropped connection loses nothing, answers tool-permission asks through the
// approval policy (or the operator at a terminal), and stops on the correct
// idle gate rather than the first idle event.

import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import type { Policy } from "./approvals.ts";
import { evaluate } from "./approvals.ts";

type StreamEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;
type PersistedEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type ToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentToolUseEvent | Anthropic.Beta.Sessions.BetaManagedAgentsAgentMCPToolUseEvent;

export interface RunOptions {
  client: Anthropic;
  agentId: string;
  agentVersion?: number;
  environmentId: string;
  title: string;
  message?: string;
  rubric?: string;
  maxIterations?: number;
  memoryStoreId?: string;
  budgetCents?: string;
  policy: Policy;
  interactive: boolean;
  approveAll?: boolean;
  workspace: string;
  metadata?: Record<string, string>;
  log?: (line: string) => void;
}

export interface RunResult {
  sessionId: string;
  status: string;
  stopReason: string | null;
  listCost?: string;
  outcome?: string;
}

export function consoleLink(workspace: string, sessionId: string): string {
  return `https://platform.claude.com/workspaces/${workspace}/sessions/${sessionId}`;
}

async function askOperator(tool: string, subject: string, reason: string): Promise<{ allow: boolean; message?: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`\n[approval] ${tool}: ${subject}\n[approval] policy: ${reason}\n`);
    const answer = (await rl.question("[approval] allow? (y)es / (n)o / (r)eason then deny: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { allow: true };
    if (answer === "r") {
      const message = await rl.question("[approval] tell the agent why: ");
      return { allow: false, message: message.trim() || "denied by operator" };
    }
    return { allow: false, message: "denied by operator" };
  } finally {
    rl.close();
  }
}

export async function runSession(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const { client } = opts;

  const session = await client.beta.sessions.create({
    agent: opts.agentVersion ? { type: "agent", id: opts.agentId, version: opts.agentVersion } : opts.agentId,
    environment_id: opts.environmentId,
    title: opts.title,
    ...(opts.memoryStoreId
      ? { resources: [{ type: "memory_store" as const, memory_store_id: opts.memoryStoreId, access: "read_write" as const }] }
      : {}),
    ...(opts.budgetCents ? { budget: { type: "limit" as const, max_list_cost: { amount: opts.budgetCents, currency: "USD" } } } : {}),
    metadata: { harness: "swarm-to-systemd", ...opts.metadata },
  });
  log(`session ${session.id} created (${session.status})`);
  log(`trace: ${consoleLink(opts.workspace, session.id)}`);

  // Stream first, then send: the stream only delivers events emitted after it opens.
  const stream = await client.beta.sessions.events.stream(session.id);
  const kickoff: Anthropic.Beta.Sessions.EventSendParams["events"] = opts.rubric
    ? [{
        type: "user.define_outcome",
        description: opts.message ?? opts.title,
        rubric: { type: "text", content: opts.rubric },
        ...(opts.maxIterations ? { max_iterations: opts.maxIterations } : {}),
      }]
    : [{ type: "user.message", content: [{ type: "text", text: opts.message ?? opts.title }] }];
  await client.beta.sessions.events.send(session.id, { events: kickoff });

  const seen = new Set<string>();
  const answered = new Set<string>();
  const result: RunResult = { sessionId: session.id, status: "running", stopReason: null };

  const confirm = async (ev: ToolUse) => {
    if (answered.has(ev.id)) return;
    answered.add(ev.id);
    const verdict = evaluate(opts.policy, ev.name, ev.input as Record<string, unknown>);
    let allow = verdict.decision === "allow";
    let denyMessage: string | undefined;
    if (verdict.decision === "deny") {
      denyMessage = verdict.reason;
    } else if (verdict.decision === "ask") {
      if (opts.approveAll) {
        allow = true;
      } else if (opts.interactive && process.stdin.isTTY) {
        const a = await askOperator(ev.name, verdict.subject, verdict.reason);
        allow = a.allow;
        denyMessage = a.message;
      } else {
        allow = false;
        denyMessage = "no operator available to approve this call; it is not covered by the approval policy";
      }
    }
    log(`[tool ${allow ? "allow" : "deny"}] ${ev.name}: ${verdict.subject.slice(0, 160)} (${verdict.reason})`);
    const threadId = "session_thread_id" in ev && ev.session_thread_id ? { session_thread_id: ev.session_thread_id } : {};
    try {
      await client.beta.sessions.events.send(session.id, {
        events: [{
          type: "user.tool_confirmation",
          tool_use_id: ev.id,
          result: allow ? "allow" : "deny",
          ...(allow ? {} : { deny_message: denyMessage ?? "denied" }),
          ...threadId,
        }],
      });
    } catch (err) {
      log(`[tool] confirmation for ${ev.id} rejected: ${(err as Error).message}`);
    }
  };

  const handle = async (ev: PersistedEvent | StreamEvent): Promise<boolean> => {
    switch (ev.type) {
      case "agent.message":
        for (const block of ev.content) if (block.type === "text") process.stdout.write(block.text + "\n");
        return false;
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        if (ev.evaluated_permission === "ask") await confirm(ev);
        else log(`[tool ${ev.evaluated_permission ?? "allow"}] ${ev.name}`);
        return false;
      case "agent.custom_tool_use":
        log(`[custom tool] ${ev.name} requested but this harness registers none; returning an error result`);
        await client.beta.sessions.events.send(session.id, {
          events: [{
            type: "user.custom_tool_result",
            custom_tool_use_id: ev.id,
            content: [{ type: "text", text: `No host-side implementation for ${ev.name}; use the bash and file tools instead.` }],
            is_error: true,
          }],
        });
        return false;
      case "session.error":
        log(`[error] ${JSON.stringify(ev.error ?? ev)}`);
        return false;
      case "session.thread_created":
      case "session.thread_status_running":
      case "session.thread_status_idle":
      case "session.thread_status_terminated":
        log(`[thread] ${ev.type.replace("session.thread_", "")} ${"agent_name" in ev ? ev.agent_name : ""}`.trim());
        return false;
      case "agent.thread_message_sent":
        log(`[lead -> ${"to_agent_name" in ev ? ev.to_agent_name : "agent"}]`);
        return false;
      case "agent.thread_message_received":
        log(`[${"from_agent_name" in ev ? ev.from_agent_name : "agent"} -> lead]`);
        return false;
      case "span.outcome_evaluation_end":
        result.outcome = ev.result;
        log(`[outcome] ${ev.result}`);
        return false;
      case "session.usage":
        if (ev.usage?.list_cost) result.listCost = `${ev.usage.list_cost.amount} ${ev.usage.list_cost.currency} (minor units)`;
        return false;
      case "session.status_idle":
        if (ev.stop_reason.type === "requires_action") return false;
        result.status = "idle";
        result.stopReason = ev.stop_reason.type;
        return true;
      case "session.status_terminated":
        result.status = "terminated";
        return true;
      default:
        return false;
    }
  };

  // History first (covers anything emitted between create and stream open), then the live tail.
  for await (const ev of client.beta.sessions.events.list(session.id)) {
    seen.add(ev.id);
    if (await handle(ev)) return finish(client, result, log);
  }
  for await (const ev of stream) {
    if ("id" in ev && ev.id) {
      if (seen.has(ev.id)) {
        if (ev.type === "session.status_terminated") break;
        if (ev.type === "session.status_idle" && ev.stop_reason.type !== "requires_action") break;
        continue;
      }
      seen.add(ev.id);
    }
    if (await handle(ev)) break;
  }
  return finish(client, result, log);
}

async function finish(client: Anthropic, result: RunResult, log: (l: string) => void): Promise<RunResult> {
  const s = await client.beta.sessions.retrieve(result.sessionId);
  result.status = s.status;
  if (s.usage?.list_cost) result.listCost = `${s.usage.list_cost.amount} ${s.usage.list_cost.currency} (minor units)`;
  log(`session ${result.sessionId} ${result.status}${result.stopReason ? ` (${result.stopReason})` : ""}${result.listCost ? `, list cost ${result.listCost}` : ""}`);
  return result;
}
