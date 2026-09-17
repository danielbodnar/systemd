#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// swarm-agent: operator and worker CLI for the systemd-migration-harness Managed Agents
// harness. Control plane goes through `ant apply` (declarative files in this
// directory); the data plane (sessions, the self-hosted worker) goes through
// the Anthropic SDK.

import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { apply } from "./commands/apply.ts";
import { connect } from "./commands/connect.ts";
import { doctor } from "./commands/doctor.ts";
import { run } from "./commands/run.ts";
import { status } from "./commands/status.ts";
import { tools } from "./commands/tools.ts";
import { worker } from "./commands/worker.ts";
import { TASKS } from "./tasks.ts";

const USAGE = `swarm-agent <command> [options]

Commands
  apply      reconcile agents, environments, skills, memory stores, and deployments with \`ant apply\`
             --dry-run  --yes  --prune  --force
  run        start a session and drive it to completion
             <task> | --message TEXT   tasks: ${Object.keys(TASKS).join(", ")}
             --agent PATH  --environment PATH  --title TEXT  --budget-cents N
             --no-rubric  --no-memory  --non-interactive  --approve-all
  worker     run the self-hosted sandbox worker on this host (long-polls the work queue)
             --once   handle one already-claimed work item (for \`ant beta:worker poll --on-work\`)
  tools      run the tool executor on this host (separate user, no credentials; the worker connects to it)
  status     list this harness's sessions      --limit N  --queue
  connect    attach a terminal to a session    <session-id>  --web
  doctor     preflight checks                  --host (check a worker host instead of an operator machine)

Global
  --config PATH   harness config (default: ./swarm-agent.yaml)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string", default: "swarm-agent.yaml" },
      help: { type: "boolean", short: "h", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      prune: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      message: { type: "string" },
      agent: { type: "string" },
      environment: { type: "string" },
      title: { type: "string" },
      "budget-cents": { type: "string" },
      "no-rubric": { type: "boolean", default: false },
      "no-memory": { type: "boolean", default: false },
      "non-interactive": { type: "boolean", default: false },
      "approve-all": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      limit: { type: "string" },
      queue: { type: "boolean", default: false },
      web: { type: "boolean", default: false },
      host: { type: "boolean", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if (command === "connect") {
    if (!rest[0]) { console.error("connect needs a session id"); return 2; }
    return connect(rest[0], values.web);
  }
  const cfg = loadConfig(values.config);
  switch (command) {
    case "apply":
      return apply(cfg, { dryRun: values["dry-run"], yes: values.yes, prune: values.prune, force: values.force });
    case "run":
      return run(cfg, {
        task: rest[0],
        message: values.message,
        agent: values.agent,
        environment: values.environment,
        title: values.title,
        budgetCents: values["budget-cents"],
        noRubric: values["no-rubric"],
        noMemory: values["no-memory"],
        nonInteractive: values["non-interactive"],
        approveAll: values["approve-all"],
      });
    case "worker":
      return worker(cfg, { once: values.once });
    case "tools":
      return tools(cfg);
    case "status":
      return status(cfg, { limit: values.limit ? Number(values.limit) : undefined, queue: values.queue });
    case "doctor":
      return doctor(cfg, { host: values.host });
    default:
      console.error(`unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`swarm-agent: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
