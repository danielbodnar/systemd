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
}

export const TASKS: Record<string, Task> = {
  capture: {
    name: "capture",
    agent: "./agents/swarm-auditor.md",
    title: "Capture swarm inventory",
    message:
      "Capture the Docker Swarm cluster reachable from this host into ./capture and normalize it to ./inventory.json in the workspace. Report counts, warnings, and migration risks.",
    rubric: `# Capture rubric (starter)
- ./inventory.json exists in the workspace and validates against the swarm-capture inventory schema
- ./capture/raw contains services.json, nodes.json, networks.json, volumes.json, secrets.json, configs.json
- Every normalizer warning is quoted in the final report
- The report lists at least the tasks not in running state, unpinned images, node-specific bind mounts, and encrypted overlays, or states that none exist
- No docker command that modifies the swarm was run`,
    max_iterations: 3,
  },
  render: {
    name: "render",
    agent: "./agents/unit-author.md",
    title: "Render Quadlet units",
    message:
      "Render ./inventory.json into ./rendered using host-map.json if present, resolve every item in rendered/MIGRATION-NOTES.md with a documented unit edit or a question in rendered/QUESTIONS.md, and run the verifier in dry-run for this host.",
    rubric: `# Render rubric (starter)
- ./rendered/expected.json and ./rendered/MIGRATION-NOTES.md exist
- Every host in expected.json has a directory under rendered/hosts with .container files for each expected unit
- Each note under "needs a human decision" is either addressed by a commented edit in a unit or listed in rendered/QUESTIONS.md
- No rendered file contains a secret value; secrets are Secret= references only
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
    title: "Plan the swarm to systemd migration",
    message:
      "Lead the migration for this estate: have the auditor capture the swarm, the unit author render and resolve notes, and the verifier dry-run this host; then ask me the five planning questions and write ./MIGRATION-PLAN.md.",
    rubric: `# Migration plan rubric (starter)
- ./inventory.json, ./rendered/expected.json, and ./MIGRATION-PLAN.md exist in the workspace
- MIGRATION-PLAN.md has all nine sections from the plan template, in order, none empty
- Every service in the inventory appears in the host mapping table with a target host and a reason
- Every network with members on more than one host has a named transport in the networking section
- Every Podman secret in expected.json has a source and an owner in the secrets table
- Every stack has a runbook with a rollback trigger stated before its cutover steps
- No command in the plan was executed against the host; the session only read, rendered, and wrote files`,
    max_iterations: 5,
  },
};
