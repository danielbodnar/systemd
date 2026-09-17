// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Named tasks the operator can run. Each is a kickoff message plus, where the
// job produces something checkable, an outcome rubric the platform grades the
// session against until it passes. Tune the rubrics per estate; they are
// starters, not laws.

export interface Task {
  name: string;
  agent?: string; // lockfile path override; defaults to config session.agent
  title: string;
  message: string;
  rubric?: string;
  max_iterations?: number;
  /** Access to the shared journal; only the auditor appends, everything else reads. */
  memory_access?: "read_only" | "read_write";
}

export const TASKS: Record<string, Task> = {
  capture: {
    name: "capture",
    agent: "./agents/swarm-auditor.md",
    memory_access: "read_write",
    title: "Discover the estate and the target hosts",
    message:
      "Capture the Docker Swarm cluster reachable from this host into ./capture and normalize it to ./inventory.json in the workspace; probe this host (and the other target hosts I named, if any) into ./hosts/. Report counts, warnings, host capabilities, and migration risks.",
    rubric: `# Discovery rubric (starter)
- ./inventory.json exists in the workspace and validates against the inventory schema in the plugin contract
- ./capture/raw contains services.json, nodes.json, networks.json, volumes.json, secrets.json, configs.json
- ./hosts/ contains one JSON file per target host with systemd.version, kernel, daemons, and tools
- Every normalizer warning is quoted in the final report
- The report lists at least the tasks not in running state, unpinned images, node-specific bind mounts, encrypted overlays, and hosts below systemd 260 or kernel 6.13, or states that none exist
- No docker command that modifies the swarm was run, and nothing on a host was changed`,
    max_iterations: 3,
  },
  plan: {
    name: "plan",
    agent: "./agents/migration-lead.md",
    title: "Draft the plan and walk its decisions",
    message:
      "Draft ./plan.yaml from ./inventory.json and ./hosts/ with the plugin's plan.ts, then walk every decision with me: the ones without a default first, then the defaulted ones grouped by component. Record only what I answer. Stop when review.ts --status reports nothing unresolved and nothing unapproved.",
    rubric: `# Plan rubric (starter)
- ./plan.yaml exists, validates, and review.ts --status reports 0 unresolved and 0 not yet approved
- Every decision without a default was presented with its options, consequences, and evidence before it was set
- Every chosen value carries a reason in the operator's words; no value was set that the operator did not give
- Defaulted decisions were accepted only per component group or individually on the operator's say-so
- Options a host cannot satisfy were pointed out where they applied`,
    max_iterations: 6,
  },
  render: {
    name: "render",
    agent: "./agents/unit-author.md",
    title: "Render the approved plan",
    message:
      "Render ./inventory.json with ./plan.yaml into ./rendered using the plugin's render.ts (no --accept-defaults). Resolve every item in rendered/MIGRATION-NOTES.md with a documented unit edit or a question in rendered/QUESTIONS.md naming the decision id, and run the verifier in dry-run for this host.",
    rubric: `# Render rubric (starter)
- ./rendered/expected.json and ./rendered/MIGRATION-NOTES.md exist
- Every host in expected.json has a directory under rendered/hosts with the units expected.json lists
- Each note under "needs a human decision" is either addressed by a commented edit in a unit or listed in rendered/QUESTIONS.md with the decision id to change
- No rendered file contains a secret value; credentials are LoadCredential references only
- The dry-run verifier output for this host is included in the report or written to rendered/verify-<host>-dry-run.json`,
    max_iterations: 4,
  },
  verify: {
    name: "verify",
    agent: "./agents/cutover-verifier.md",
    title: "Verify this host",
    message:
      "Run the verifier for this host against ./rendered/expected.json. Use dry-run unless the operator's message says live. Report failures first with reproduction commands and a verdict.",
  },
  migrate: {
    name: "migrate",
    agent: "./agents/migration-lead.md",
    title: "Lead the migration onto systemd",
    message:
      "Lead the migration for this estate: have the auditor discover the swarm and the hosts, draft plan.yaml and walk its decisions with me, have the unit author render the approved plan and resolve notes, have the verifier dry-run this host, then write ./MIGRATION-PLAN.md.",
    rubric: `# Migration rubric (starter)
- ./inventory.json, ./hosts/, ./plan.yaml, ./rendered/expected.json, and ./MIGRATION-PLAN.md exist in the workspace
- review.ts --status on ./plan.yaml reports 0 unresolved and 0 not yet approved, and every chosen value has a reason
- MIGRATION-PLAN.md has all nine sections from the plan template, in order, none empty, and its Decisions section lists every plan decision that had no default with its chosen value and reason
- Every service in the inventory appears in the host mapping table with a target host, its form, and a reason
- Every network with members on more than one host has a named transport in the networking section matching the plan
- Every credential in expected.json has a store and an owner in the secrets table
- Every stack has a runbook with a rollback trigger stated before its cutover steps
- No command in the plan was executed against the host; the session only read, planned, rendered, and wrote files`,
    max_iterations: 6,
  },
};
