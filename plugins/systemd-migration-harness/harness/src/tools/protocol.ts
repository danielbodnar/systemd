// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Wire format between the worker (which holds the environment key) and the
// tool executor (which holds nothing and runs as its own user): one JSON
// object per line over a Unix socket. The worker sends `hello` with the
// per-session tool context, then `call` messages; the executor answers each
// call with `result` or `error`. A `cancel` aborts a call still in flight.

import { z } from "zod";

export const ToolContextSchema = z.object({
  workdir: z.string().min(1),
  allowedRoots: z.array(z.string()).default([]),
  readOnlyRoots: z.array(z.string()).default([]),
});
export type WireToolContext = z.infer<typeof ToolContextSchema>;

export const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), ctx: ToolContextSchema }),
  z.object({ type: z.literal("call"), id: z.number().int(), tool: z.string().min(1), input: z.unknown(), toolUse: z.unknown().optional() }),
  z.object({ type: z.literal("cancel"), id: z.number().int() }),
]);
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), tools: z.array(z.string()) }),
  z.object({ type: z.literal("result"), id: z.number().int(), result: z.unknown() }),
  z.object({ type: z.literal("error"), id: z.number().int().nullable(), error: z.string() }),
]);
export type Response = z.infer<typeof ResponseSchema>;

export function encode(message: Request | Response): string {
  return JSON.stringify(message) + "\n";
}

/**
 * Incremental line decoder: feed it chunks as they arrive and it yields every
 * complete line as a parsed object, keeping a partial trailing line for the
 * next chunk. Malformed lines surface as errors rather than being skipped.
 */
export class LineDecoder {
  private buffer = "";

  feed(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      out.push(JSON.parse(line));
    }
    return out;
  }
}
