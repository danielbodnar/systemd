// SPDX-License-Identifier: LGPL-2.1-or-later
//
// `swarm-agent tools`: the tool executor service. Runs as its own user with
// no credentials and executes the agent toolset on behalf of the worker.

import type { Config } from "../config.ts";
import { notifySystemd } from "../notify.ts";
import { serveTools } from "../tools/server.ts";

export async function tools(cfg: Config): Promise<number> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_ENVIRONMENT_KEY || process.env.CREDENTIALS_DIRECTORY) {
    console.error("refusing to start: the tool executor must run without any Anthropic credential in its environment");
    return 2;
  }
  // Keep the manager's notify socket to ourselves: the bash tool inherits
  // this environment, and NotifyAccess=main already drops anything a child
  // sends, but a command that runs here has no business seeing the path.
  const notifySocket = process.env.NOTIFY_SOCKET;
  delete process.env.NOTIFY_SOCKET;
  const controller = new AbortController();
  const stop = (sig: string) => {
    console.error(`received ${sig}; closing the tool socket`);
    notifySystemd("STOPPING=1", notifySocket);
    controller.abort();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  try {
    await serveTools({
      socketPath: cfg.worker.tools_socket,
      deniedPatterns: cfg.worker.denied_paths,
      signal: controller.signal,
      onListening: () => {
        console.error(`tool executor listening on ${cfg.worker.tools_socket}`);
        notifySystemd("READY=1", notifySocket);
      },
    });
    return 0;
  } catch (err) {
    console.error(`tool executor failed: ${(err as Error).message}`);
    return 1;
  }
}
