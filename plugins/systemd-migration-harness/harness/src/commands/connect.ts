// SPDX-License-Identifier: LGPL-2.1-or-later
export async function connect(sessionId: string, web: boolean): Promise<number> {
  const args = ["ant", "beta:sessions", "connect", sessionId];
  if (web) args.push("--web");
  const proc = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}
