// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Reads claude-lock.json as written by `ant apply` and resolves the agent,
// environment, and memory store ids the harness needs. The lockfile is the
// only place ids live; the YAML files never carry them.

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface LockResource {
  kind: string;
  id: string;
  version?: string;
  hash?: string;
  remote_hash?: string;
}

export interface Lockfile {
  version: number;
  origin?: { base_url?: string; organization_id?: string; workspace_id?: string };
  resources: Record<string, LockResource>;
}

export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) {
    throw new Error(`lockfile not found at ${path}; run \`swarm-agent apply\` (or \`ant apply .\`) first`);
  }
  const lock = JSON.parse(readFileSync(path, "utf8")) as Lockfile;
  if (!lock.resources || typeof lock.resources !== "object") throw new Error(`lockfile ${path} has no resources map`);
  return lock;
}

/** Normalize a path to the "./relative/path" key form ant apply uses. */
export function lockKey(lockfilePath: string, resourcePath: string): string {
  const rel = relative(dirname(resolve(lockfilePath)), resolve(dirname(resolve(lockfilePath)), resourcePath)).replace(/\\/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function resolveResource(lock: Lockfile, lockfilePath: string, resourcePath: string, expectedKind?: string): LockResource {
  const key = lockKey(lockfilePath, resourcePath);
  const res = lock.resources[key] ?? lock.resources[resourcePath];
  if (!res) {
    const known = Object.keys(lock.resources).join(", ") || "none";
    throw new Error(`${key} is not in the lockfile (known: ${known}); apply it first`);
  }
  if (expectedKind && res.kind !== expectedKind) throw new Error(`${key} is a ${res.kind}, expected ${expectedKind}`);
  return res;
}

// Reads `config.type` from an environment definition file so callers can tell
// a cloud lab from a self-hosted production host before relaxing anything.
export function environmentType(lockfilePath: string, resourcePath: string): string | undefined {
  const file = resolve(dirname(lockfilePath), resourcePath);
  try {
    const doc = parseYaml(readFileSync(file, "utf8")) as { config?: { type?: unknown } } | null;
    return typeof doc?.config?.type === "string" ? doc.config.type : undefined;
  } catch {
    return undefined;
  }
}
