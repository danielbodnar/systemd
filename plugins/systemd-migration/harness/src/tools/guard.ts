// SPDX-License-Identifier: LGPL-2.1-or-later

const PATH_KEYS = ["path", "file_path", "pattern", "glob", "directory", "cwd"];

/**
 * Wrap tools so any input path (or bash command text) that matches a denied
 * pattern is refused before execution. This runs in the tool executor and
 * therefore applies regardless of the server-side permission policy, which is
 * what keeps `secrets/values` unreadable even for always_allow tools.
 */
export function guardTools<T extends { name: string; run: (input: any, ...rest: any[]) => any }>(tools: T[], deniedPatterns: string[]): T[] {
  if (deniedPatterns.length === 0) return tools;
  const regexes = deniedPatterns.map((p) => new RegExp(p));
  const offending = (input: Record<string, unknown>): string | null => {
    const candidates: string[] = [];
    for (const k of PATH_KEYS) if (typeof input[k] === "string") candidates.push(input[k] as string);
    if (typeof input.command === "string") candidates.push(input.command, ...input.command.split(/\s+/));
    for (const c of candidates) for (const re of regexes) if (re.test(c)) return c;
    return null;
  };
  return tools.map((tool) => ({
    ...tool,
    run: (input: any, ...rest: any[]) => {
      const hit = offending(input ?? {});
      if (hit) throw new Error(`refused by worker policy: ${tool.name} may not touch ${hit}`);
      return tool.run(input, ...rest);
    },
  }));
}
