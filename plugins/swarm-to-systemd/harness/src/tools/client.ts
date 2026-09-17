// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Worker side of the split: tools that look like the agent toolset to the
// environment worker but execute nothing locally. Each call is forwarded to
// the tool executor over the Unix socket; the definitions (names, schemas,
// input parsing) come from the real toolset so the model sees no difference.

import { betaAgentToolset20260401, type AgentToolContext } from "@anthropic-ai/sdk/tools/agent-toolset/node";
import type { BetaRunnableTool, BetaToolRunContext } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { createConnection, type Socket } from "node:net";
import { encode, LineDecoder, ResponseSchema, type WireToolContext } from "./protocol.ts";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** One connection to the executor, bound to one session's tool context. */
export class RemoteToolset {
  private socket: Socket;
  private ready: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(socketPath: string, ctx: WireToolContext) {
    const decoder = new LineDecoder();
    this.socket = createConnection(socketPath);
    this.socket.setEncoding("utf8");
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.once("connect", () => this.socket.write(encode({ type: "hello", ctx })));
      this.socket.once("error", (err) => {
        reject(new Error(`tool executor unreachable at ${socketPath}: ${err.message}`));
        this.failAll(err);
      });
      this.socket.on("data", (chunk: string) => {
        for (const raw of decoder.feed(chunk)) {
          const parsed = ResponseSchema.safeParse(raw);
          if (!parsed.success) continue;
          const msg = parsed.data;
          if (msg.type === "ready") resolve();
          else if (msg.type === "result") this.settle(msg.id, (p) => p.resolve(msg.result));
          else if (msg.id === null) reject(new Error(msg.error));
          else this.settle(msg.id, (p) => p.reject(new Error(msg.error)));
        }
      });
      this.socket.once("close", () => this.failAll(new Error("tool executor connection closed")));
    });
    this.ready.catch(() => {});
  }

  private settle(id: number, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    fn(p);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async call(tool: string, input: unknown, rc?: BetaToolRunContext): Promise<unknown> {
    await this.ready;
    if (this.closed) throw new Error("tool executor connection is closed");
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const onAbort = () => this.socket.write(encode({ type: "cancel", id }));
    rc?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.socket.write(encode({ type: "call", id, tool, input, toolUse: rc?.toolUse }));
      return await result;
    } finally {
      rc?.signal?.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}

/**
 * Build the proxy tools for one session. The factory is synchronous because
 * the environment worker calls it that way; the connection finishes
 * establishing before the first call is forwarded.
 */
export function remoteTools(socketPath: string, ctx: AgentToolContext): BetaRunnableTool[] {
  const wire: WireToolContext = { workdir: ctx.workdir, allowedRoots: ctx.allowedRoots ?? [], readOnlyRoots: ctx.readOnlyRoots ?? [] };
  const remote = new RemoteToolset(socketPath, wire);
  const local = betaAgentToolset20260401(ctx);
  const proxies = local.map((tool) => ({
    ...tool,
    run: (input: unknown, rc?: BetaToolRunContext) => remote.call(tool.name, input, rc) as any,
    close: () => remote.close(),
  }));
  // The local objects are only templates; release anything they may hold.
  for (const t of local) {
    try {
      void t.close?.();
    } catch {
      // nothing was started
    }
  }
  return proxies;
}
