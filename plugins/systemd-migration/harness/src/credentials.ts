// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Credential resolution for the worker. systemd passes credentials through
// $CREDENTIALS_DIRECTORY (LoadCredential=/LoadCredentialEncrypted=); the
// environment variable is the fallback for interactive use.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readCredential(name: string, envVar: string): string | undefined {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (dir) {
    const p = join(dir, name);
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  const v = process.env[envVar];
  return v && v.length > 0 ? v : undefined;
}
