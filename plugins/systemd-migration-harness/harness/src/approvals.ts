// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Approval policy for tool calls that pause for confirmation. The policy is a
// list of (tool, regex) rules with a decision; it is deliberately small and
// readable because an operator has to be able to audit it at a glance.
//
// Bash commands are split on shell control operators before matching so that
// `docker service ls; rm -rf /` cannot ride an allow rule for its first word.
// Every segment must be allowed for the whole command to be allowed; a deny on
// any segment denies the command; command substitution, backticks, and
// redirections make the command an `ask` unless a deny matches.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const Decision = z.enum(["allow", "deny", "ask"]);
export type Decision = z.infer<typeof Decision>;

const RuleSchema = z.object({
  tool: z.string().default("*"),
  match: z.string(),
  decision: Decision,
  reason: z.string().default(""),
});

export const PolicySchema = z.object({
  default: Decision.default("ask"),
  rules: z.array(RuleSchema).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;
export type Rule = z.infer<typeof RuleSchema>;

export interface Verdict {
  decision: Decision;
  reason: string;
  rule?: Rule;
  subject: string;
}

export function loadPolicy(path: string): Policy {
  const parsed = PolicySchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`invalid approval policy ${path}: ${parsed.error.message}`);
  for (const r of parsed.data.rules) new RegExp(r.match); // fail early on a bad regex
  return parsed.data;
}

/** The string a rule's regex is tested against: the bash command, or the tool input otherwise. */
export function subjectOf(tool: string, input: Record<string, unknown>): string {
  if (tool === "bash" && typeof input.command === "string") return input.command;
  if ((tool === "read" || tool === "write" || tool === "edit") && typeof input.path === "string") return input.path;
  if (typeof input.file_path === "string") return input.file_path;
  return JSON.stringify(input);
}

const CONTROL_OPERATORS = /\|\||&&|;|\||&|\n/;
const UNSAFE_SYNTAX = /\$\(|`|<\(|>\(|(^|[^<>])[<>]{1,2}(?![<>])/;

/** Split a shell command into simple-command segments on control operators. */
export function shellSegments(command: string): string[] {
  return command
    .split(CONTROL_OPERATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function firstMatch(policy: Policy, tool: string, subject: string): Rule | undefined {
  for (const rule of policy.rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;
    if (new RegExp(rule.match).test(subject)) return rule;
  }
  return undefined;
}

export function evaluate(policy: Policy, tool: string, input: Record<string, unknown>): Verdict {
  const subject = subjectOf(tool, input);

  // Deny rules are checked against the whole subject first so nothing can
  // hide a denied token inside an otherwise allowed command.
  const whole = firstMatch(policy, tool, subject);
  if (whole?.decision === "deny") return { decision: "deny", reason: whole.reason || `matched rule ${whole.match}`, rule: whole, subject };

  if (tool !== "bash") {
    if (whole) return { decision: whole.decision, reason: whole.reason || `matched rule ${whole.match}`, rule: whole, subject };
    return { decision: policy.default, reason: "no rule matched; policy default", subject };
  }

  const segments = shellSegments(subject);
  const verdicts = segments.map((seg) => ({ seg, rule: firstMatch(policy, tool, seg) }));
  const denied = verdicts.find((v) => v.rule?.decision === "deny");
  if (denied) return { decision: "deny", reason: denied.rule!.reason || `matched rule ${denied.rule!.match}`, rule: denied.rule, subject };

  if (UNSAFE_SYNTAX.test(subject)) {
    return { decision: policy.default === "deny" ? "deny" : "ask", reason: "command uses substitution or redirection; allow rules do not apply", subject };
  }
  if (segments.length > 0 && verdicts.every((v) => v.rule?.decision === "allow")) {
    const rule = verdicts[0].rule!;
    return { decision: "allow", reason: segments.length > 1 ? "every command in the chain matches an allow rule" : rule.reason || `matched rule ${rule.match}`, rule, subject };
  }
  const asked = verdicts.find((v) => v.rule?.decision === "ask");
  if (asked) return { decision: "ask", reason: asked.rule!.reason || `matched rule ${asked.rule!.match}`, rule: asked.rule, subject };
  return { decision: policy.default, reason: "no rule matched every command; policy default", subject };
}
