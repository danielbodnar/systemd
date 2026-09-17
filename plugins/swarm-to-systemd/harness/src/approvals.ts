// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Approval policy for tool calls that pause for confirmation. The policy is a
// list of (tool, regex) rules with a decision; it is deliberately small and
// readable because an operator has to be able to audit it at a glance.

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

export function evaluate(policy: Policy, tool: string, input: Record<string, unknown>): Verdict {
  const subject = subjectOf(tool, input);
  for (const rule of policy.rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;
    if (new RegExp(rule.match).test(subject)) {
      return { decision: rule.decision, reason: rule.reason || `matched rule ${rule.match}`, rule, subject };
    }
  }
  return { decision: policy.default, reason: "no rule matched; policy default", subject };
}
