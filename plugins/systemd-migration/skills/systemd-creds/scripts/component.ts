// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The credentials component: every secret, and every environment value the
// capture redacted, becomes a systemd credential. Where the credential's
// value lives is a decision per secret; the default is an encrypted
// credential under /etc/credstore.encrypted, imported on the host by the
// rendered import-credentials.sh from files the operator places. Values
// never appear in the rendered tree.

import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import { shellQuote } from "../../../contract/unit.ts";

export function storeId(secret: string): string {
  return `creds.store.${secret}`;
}

export function credentialNameFor(service: string, variable: string): string {
  return `${service}-${variable.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

const STORES = [
  { value: "credstore.encrypted", label: "encrypted credential on the host", consequence: "systemd-creds encrypt writes /etc/credstore.encrypted/NAME bound to the host's TPM or key; the unit loads it with LoadCredentialEncrypted=", requires: { tools: ["systemd-creds"] } },
  { value: "credstore", label: "plain credential file on the host", consequence: "/etc/credstore/NAME, mode 0600, loaded with LoadCredential=; no encryption at rest" },
  { value: "external", label: "fetched at start from an external secret manager", consequence: "the unit loads nothing; a ExecStartPre= or a credential provider you add fetches the value into $CREDENTIALS_DIRECTORY" },
];

export const credsComponent: Component = {
  id: "creds",
  title: "Credentials (systemd-creds, LoadCredential=, LoadCredentialEncrypted=, ImportCredential=)",
  covers: ["systemd-creds", "systemd.system-credentials", "systemd-ask-password", "systemd-tty-ask-password-agent", "systemd-ask-password-console.service"],
  after: ["service"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    const names = new Map<string, string[]>();
    for (const s of ctx.inventory.secrets) names.set(s.name, [`secrets[${s.name}] used by ${s.used_by.join(", ") || "nothing"}`]);
    for (const svc of ctx.inventory.services) {
      for (const k of svc.redacted_env) names.set(credentialNameFor(svc.name, k), [`services[${svc.name}].env.${k} was redacted at capture`]);
    }
    for (const [name, evidence] of [...names].sort()) {
      out.push({
        id: storeId(name),
        kind: "choice",
        subject: { kind: "secret", name },
        question: `Where does the value of ${name} live on the target hosts?`,
        options: STORES,
        default: "credstore.encrypted",
        evidence,
      });
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const toImport = new Map<string, string>(); // credential -> store
    for (const inst of ctx.instances) {
      if (inst.form !== "service") continue;
      const shape = ctx.get<ServiceShape>(instanceKey(inst.base));
      if (!shape) continue;
      const svc = inst.service;
      const u = ctx.unit(shape.unit);
      const load = (name: string): boolean => {
        const store = ctx.value(storeId(name));
        if (store === "external") {
          ctx.note(`${svc.name}: credential ${name} is fetched externally by decision; add the fetch step to the unit (ExecStartPre= or a credential provider) so it appears under $CREDENTIALS_DIRECTORY`, "decision");
          return false;
        }
        if (store === "credstore") u.add("Service", "LoadCredential", `${name}:/etc/credstore/${name}`);
        else u.add("Service", "LoadCredentialEncrypted", `${name}:/etc/credstore.encrypted/${name}`);
        toImport.set(name, store);
        ctx.expect("credentials", name);
        return true;
      };
      for (const [k] of Object.entries(svc.env).sort()) {
        if (!svc.redacted_env.includes(k)) continue;
        const name = credentialNameFor(svc.name, k);
        if (load(name)) {
          u.add("Service", "Environment", `${k}_FILE=%d/${name}`);
          ctx.note(`${svc.name}: environment ${k} was redacted at capture; the value is loaded as credential ${name} at %d/${name}, and the process must read it from there or from ${k}_FILE`);
        }
      }
      for (const s of svc.secrets) {
        if (!load(s.name)) continue;
        const target = s.target.startsWith("/") ? s.target : `/run/secrets/${s.target}`;
        u.add("Service", "BindReadOnlyPaths", `%d/${s.name}:${target}`);
        if (s.uid !== "0" || s.gid !== "0") ctx.note(`${svc.name}: secret ${s.name} was owned by ${s.uid}:${s.gid} in the container; credentials are readable by the service user only, which is what the mode asked for`);
      }
    }
    const names = [...toImport.keys()].sort();
    if (names.length) ctx.file("secrets/import-credentials.sh", importScript(ctx.rendererName, names, toImport));
  },
};

function importScript(renderer: string, names: string[], stores: Map<string, string>): string {
  const encrypted = names.filter((n) => stores.get(n) === "credstore.encrypted");
  const plain = names.filter((n) => stores.get(n) === "credstore");
  return [
    "#!/usr/bin/env bash",
    "# SPDX-License-Identifier: LGPL-2.1-or-later",
    `# Rendered by ${renderer}. Turns each secret value into a systemd credential the`,
    "# units load: encrypted ones with systemd-creds encrypt into",
    "# /etc/credstore.encrypted, plain ones copied into /etc/credstore. Values are",
    "# read from one file per credential under /etc/swarm-migration/secrets/",
    "# (root-only, mode 0600), which the operator fills from the old cluster;",
    "# nothing here prints one.",
    "set -euo pipefail",
    'src="${1:-/etc/swarm-migration/secrets}"',
    '[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }',
    "missing=0",
    ...(encrypted.length
      ? [
          'install -d -m 0700 /etc/credstore.encrypted',
          `for name in ${encrypted.map(shellQuote).join(" ")}; do`,
          '    if [ ! -f "$src/$name" ]; then echo "missing $src/$name" >&2; missing=$((missing + 1)); continue; fi',
          '    systemd-creds encrypt --name="$name" "$src/$name" "/etc/credstore.encrypted/$name"',
          '    chmod 0600 "/etc/credstore.encrypted/$name"',
          '    echo "encrypted $name"',
          "done",
        ]
      : []),
    ...(plain.length
      ? [
          'install -d -m 0700 /etc/credstore',
          `for name in ${plain.map(shellQuote).join(" ")}; do`,
          '    if [ ! -f "$src/$name" ]; then echo "missing $src/$name" >&2; missing=$((missing + 1)); continue; fi',
          '    install -m 0600 "$src/$name" "/etc/credstore/$name"',
          '    echo "installed $name"',
          "done",
        ]
      : []),
    '[ "$missing" -eq 0 ] || { echo "$missing credential(s) missing" >&2; exit 1; }',
    "",
  ].join("\n");
}
