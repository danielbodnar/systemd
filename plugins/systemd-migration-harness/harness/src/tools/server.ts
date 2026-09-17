// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The tool executor. It listens on a Unix socket, builds the agent toolset
// for the context each worker connection announces, and runs the calls it is
// sent. It never sees the environment key: the worker that does is a
// different process under a different user, and the only thing that crosses
// the socket is tool names, inputs, and results.

import { betaAgentToolset20260401, type AgentToolContext } from "@anthropic-ai/sdk/tools/agent-toolset/node";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { guardTools } from "./guard.ts";
import { encode, LineDecoder, RequestSchema, type Response } from "./protocol.ts";

export interface ToolServerOptions {
  socketPath: string;
  deniedPatterns: string[];
  /** Socket file mode; the group is the executor's primary group. */
  mode?: number;
  signal?: AbortSignal;
  onListening?: () => void;
}

interface ConnectionState {
  tools: BetaRunnableTool[] | null;
  inflight: Map<number, AbortController>;
}

function send(socket: Socket, message: Response): void {
  if (!socket.destroyed) socket.write(encode(message));
}

async function handleMessage(socket: Socket, state: ConnectionState, raw: unknown, denied: string[]): Promise<void> {
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    send(socket, { type: "error", id: null, error: `malformed request: ${parsed.error.issues.map((i) => i.message).join("; ")}` });
    return;
  }
  const msg = parsed.data;
  if (msg.type === "hello") {
    if (state.tools) {
      send(socket, { type: "error", id: null, error: "hello already received on this connection" });
      return;
    }
    const ctx: AgentToolContext = { workdir: msg.ctx.workdir, allowedRoots: msg.ctx.allowedRoots, readOnlyRoots: msg.ctx.readOnlyRoots };
    state.tools = guardTools(betaAgentToolset20260401(ctx), denied);
    send(socket, { type: "ready", tools: state.tools.map((t) => t.name) });
    return;
  }
  if (msg.type === "cancel") {
    state.inflight.get(msg.id)?.abort();
    return;
  }
  if (!state.tools) {
    send(socket, { type: "error", id: msg.id, error: "call before hello" });
    return;
  }
  const tool = state.tools.find((t) => t.name === msg.tool);
  if (!tool) {
    send(socket, { type: "error", id: msg.id, error: `unknown tool ${msg.tool}` });
    return;
  }
  const controller = new AbortController();
  state.inflight.set(msg.id, controller);
  try {
    const input = tool.parse(msg.input);
    const toolUse = msg.toolUse as any;
    const result = await tool.run(input, { toolUse, toolUseBlock: toolUse, signal: controller.signal });
    send(socket, { type: "result", id: msg.id, result });
  } catch (err) {
    send(socket, { type: "error", id: msg.id, error: (err as Error).message });
  } finally {
    state.inflight.delete(msg.id);
  }
}

function handleConnection(socket: Socket, denied: string[]): void {
  const state: ConnectionState = { tools: null, inflight: new Map() };
  const decoder = new LineDecoder();
  let chain: Promise<void> = Promise.resolve();
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let messages: unknown[];
    try {
      messages = decoder.feed(chunk);
    } catch (err) {
      send(socket, { type: "error", id: null, error: `bad line: ${(err as Error).message}` });
      return;
    }
    for (const m of messages) {
      // Cancels must not wait behind the call they cancel; everything else runs in order.
      if (typeof m === "object" && m !== null && (m as { type?: unknown }).type === "cancel") {
        void handleMessage(socket, state, m, denied);
      } else {
        chain = chain.then(() => handleMessage(socket, state, m, denied));
      }
    }
  });
  const teardown = () => {
    for (const c of state.inflight.values()) c.abort();
    for (const t of state.tools ?? []) {
      try {
        void t.close?.();
      } catch {
        // a tool that was never used has nothing to release
      }
    }
    state.tools = null;
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
}

/** Listen until the signal aborts; resolves once the server has closed. */
export function serveTools(opts: ToolServerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
    const open = new Set<Socket>();
    const server: Server = createServer((socket) => {
      open.add(socket);
      socket.once("close", () => open.delete(socket));
      handleConnection(socket, opts.deniedPatterns);
    });
    server.on("error", reject);
    server.listen(opts.socketPath, () => {
      chmodSync(opts.socketPath, opts.mode ?? 0o660);
      opts.onListening?.();
    });
    const stop = () => {
      // Shutdown must not wait on a worker that never hangs up.
      for (const s of open) s.destroy();
      server.close(() => {
        if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
        resolve();
      });
    };
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener("abort", stop, { once: true });
  });
}
