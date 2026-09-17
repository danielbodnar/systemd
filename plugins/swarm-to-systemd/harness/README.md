# swarm-agent harness

A Managed Agents harness for the swarm-to-systemd plugin. The agents, their environments, the skills they carry, a memory store, and a scheduled audit are all files in this directory, reconciled with the Claude API by `ant apply`. A small Bun CLI, `swarm-agent`, does the two things the files cannot: it runs the self-hosted sandbox worker on a production host, and it drives sessions from an operator's machine with an approval policy between the agent and the host.

The split follows the platform's own advice. The control plane (what agents exist, with which prompts, tools, and skills) is declarative and lives in version control; the data plane (a session doing work on a particular host, today) is code that reads the lockfile `ant apply` wrote and talks to the SDK.

## Layout

```
harness/
  agents/           Markdown agents: frontmatter is the API body, the prose is the system prompt
  environments/     production-host.yaml (self_hosted) and lab-cloud.yaml (cloud)
  memory_stores/    migration-journal.yaml, shared across sessions and audits
  deployments/      weekly-drift-audit.md, a cron-scheduled re-capture
  swarm-agent.yaml  harness configuration (workdir, roots, defaults, budget)
  approvals.yaml    what a paused tool call may do without a human
  src/              the swarm-agent CLI
  systemd/          worker unit, slice, installer for production hosts
  claude-lock.json  written by ant apply; commit it
```

The agents reference the plugin's skills by relative path (`../../skills/swarm-capture`), so the same `SKILL.md` files serve Claude Code locally and the managed agents remotely. Editing a skill and re-running `ant apply` uploads a new skill version and re-pins every agent that uses it.

## Roles and hosts

There are two machines in play, and they hold different credentials.

The **operator machine** has the `ant` CLI, a Claude API key or OAuth profile with access to the workspace, and this directory. It runs `swarm-agent apply`, `swarm-agent run`, `swarm-agent status`, and `swarm-agent connect`.

The **production host** (a Swarm manager, or a target systemd host) runs `swarm-agent worker` under the provided unit. It holds only an environment key, delivered as an encrypted systemd credential, and never an organization API key; the worker refuses to start if it finds one in its environment. Tool calls from the agents execute here, confined to the workspace for file tools, and gated by the approval policy for bash on the agents that can change anything.

## Setup

On the operator machine:

```bash
cd plugins/swarm-to-systemd/harness
bun install
bun run src/cli.ts doctor          # ant present, credentials, lockfile
bun run src/cli.ts apply --dry-run # the plan ant apply would execute
bun run src/cli.ts apply           # creates agents, environments, skills, memory store, deployment
git add claude-lock.json && git commit -m "harness: record applied resources"
```

Generate the environment key for `swarm-migration-production` in the Console (open the environment, choose Generate environment key); key generation is Console-only. Then, on the production host, with Bun installed and this repository checked out or copied:

```bash
sudo bash harness/systemd/install-worker.sh --environment-id env_...   # prompts for the key, stores it with systemd-creds
sudo systemctl enable --now swarm-agent-worker.service
sudo bun run /opt/swarm-agent/harness/src/cli.ts doctor --host --config /etc/swarm-agent/swarm-agent.yaml
```

The installer copies the harness and the plugin skills to `/opt/swarm-agent`, writes `/etc/swarm-agent/swarm-agent.yaml` and `approvals.yaml` if they do not exist, and installs the unit and slice. Review `swarm-agent.yaml` on the host: `worker.workdir` is where every artifact lands, and `worker.allowed_roots` is the only way the file tools reach anything else.

## Running a migration

Each named task starts a session for one agent with a kickoff message and, where the deliverable is checkable, an outcome rubric the platform grades until it passes. Run them in order from the operator machine while the worker is polling:

```bash
bun run src/cli.ts run capture      # swarm-auditor writes inventory.json in the workspace
bun run src/cli.ts run render       # unit-author renders and resolves notes
bun run src/cli.ts run verify       # cutover-verifier dry-runs this host
bun run src/cli.ts run migrate      # migration-lead coordinates all three and writes MIGRATION-PLAN.md
```

`run` opens the event stream before it sends the kickoff, prints agent messages to stdout, and logs tool activity to stderr. When a tool call pauses for confirmation, the approval policy decides first; anything it marks `ask` prompts you at the terminal, or is denied with an explanation when there is no terminal. `--approve-all` exists for lab environments and says so loudly. `--message` runs an ad-hoc prompt against the default agent, `--agent` and `--environment` accept lockfile paths, and `--budget-cents` overrides the per-session cap from the config.

`swarm-agent connect <session>` hands the session to `ant beta:sessions connect` for a live transcript with allow and deny prompts; `--web` opens the Console viewer locally. `swarm-agent status --queue` lists this harness's sessions and the worker queue depth, which is the quickest way to tell whether the production worker is polling.

## The approval policy

`approvals.yaml` is a short ordered list of rules: a tool name, a regular expression over the bash command (or file path), and a decision. Read-only Docker queries, the plugin's own scripts, and common inspection commands are allowed; anything that changes the swarm or the host (`docker service update`, `systemctl start`, `install.sh`, `import-secrets.sh`) is denied with a reason the agent sees; secret value files are denied for bash and the read tool; everything else asks. The policy is the operator's contract with the agents, so keep it readable and test changes with `bun test`.

The policy only applies to calls that pause. The auditor's tools run under the server's `auto` policy, which allows safe calls and denies high-risk ones on its own and pauses only when unsure; the writer agents put `bash` on `always_ask` so every command crosses the policy.

## Lab environment

`environments/lab-cloud.yaml` is an Anthropic-hosted sandbox for planning without a production host. Cloud environments accept file resources, so an `inventory.json` captured earlier can be uploaded with `ant beta:files upload` and mounted at session creation; run `swarm-agent run render --environment ./environments/lab-cloud.yaml` after adding the resource, or use `ant beta:sessions create` directly with `resources:`. Memory stores attach to either environment type.

## Scheduled drift audit

`deployments/weekly-drift-audit.md` runs the auditor every Monday against the production environment with a per-run budget, appending to the journal. Pause it with `ant beta:deployments pause --deployment-id <id>` (the id is in the lockfile) during the cutover window so an audit does not compete with the migration session for the single worker.

## Security notes

The worker executes whatever bash the agents are allowed to run, on a host you care about. Three layers stand between the agent and a mistake: the server-side permission policies on each agent, this harness's approval policy, and the fact that the plan tells the operator what to run instead of letting the agent run it. Keep `install.sh` and `import-secrets.sh` denied in the policy, keep `secrets/values/` out of the workspace the agent can read, and treat the environment key like any other host secret: it is bound to one environment, stored encrypted with `systemd-creds`, and rotated from the Console if exposed. Web search and fetch are disabled on every agent; the migration needs no internet.

## Development

```bash
bun run check   # typecheck the harness and the plugin's Bun scripts
bun test        # policy, lockfile, normalizer, and renderer tests
just shellcheck # shell scripts in the plugin and the harness
```

## Dependency note

`@anthropic-ai/sdk` depends on `standardwebhooks`, which depends on the unmaintained `fast-sha256` package for one HMAC call. The harness never verifies webhooks, but the package would still enter the dependency tree, so `package.json` overrides it with `vendor/fast-sha256`, a small shim that delegates the same `hash` and `hmac` calls to `node:crypto`. Remove the override if a maintained upstream replaces the dependency.
