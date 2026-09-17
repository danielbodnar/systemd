// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The extensions component: a stack's configuration files can ship as a
// configuration extension (a confext merged into /etc/) instead of plain
// files, which makes them one artifact that systemd-confext refreshes
// atomically. A pure-/usr image can ship as a system extension.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import { octal } from "../../../contract/unit.ts";

export function configsId(stack: string): string {
  return `sysext.configs.${stack}`;
}

export const sysextComponent: Component = {
  id: "sysext",
  title: "Extensions (systemd-sysext, systemd-confext, extension-release)",
  covers: ["systemd-sysext", "sysext.conf", "os-release"],
  after: ["service"],

  decide(ctx: PlanContext): DecisionSpec[] {
    return ctx.inventory.stacks
      .filter((s) => ctx.inventory.services.some((svc) => svc.stack === s.name && svc.configs.length > 0))
      .map((s) => ({
        id: configsId(s.name),
        kind: "choice" as const,
        subject: { kind: "stack" as const, name: s.name },
        question: `How do the config files of stack ${s.name} reach the hosts?`,
        options: [
          { value: "files", label: "plain files under /etc/<stack>/configs", consequence: "installed by install.sh with the ownership the source recorded; bound read-only into each service" },
          { value: "confext", label: "a configuration extension", consequence: "the files are packed into /var/lib/confexts/<stack>.raw (or a directory) and merged into /etc by systemd-confext; one artifact, atomic refresh", requires: { systemd: 251, tools: ["systemd-confext"] } },
        ],
        default: "files",
        evidence: ctx.inventory.services.filter((svc) => svc.stack === s.name).flatMap((svc) => svc.configs.map((c) => `services[${svc.name}].configs[${c.name}]`)),
      }));
  },

  render(ctx: RenderContext): void {
    const cfgByName = new Map(ctx.inventory.configs.map((c) => [c.name, c]));
    const stacks = new Set(ctx.instances.map((i) => i.stack));
    for (const stack of [...stacks].sort()) {
      if (ctx.valueOr(configsId(stack), "files") !== "confext") continue;
      const dir = `var/lib/confexts/${stack}`;
      const release = `${dir}/etc/extension-release.d/extension-release.${stack}`;
      ctx.file(release, [`# Rendered by ${ctx.rendererName}: configuration extension of stack ${stack}`, "ID=_any", "CONFEXT_LEVEL=1", ""].join("\n"));
      const manifest: string[] = [];
      for (const inst of ctx.instances.filter((i) => i.stack === stack)) {
        const u = ctx.unit(inst.unit);
        for (const c of inst.service.configs) {
          const def = cfgByName.get(c.name);
          const target = c.target.startsWith("/") ? c.target : `/${c.target}`;
          const rel = `${dir}/etc/${stack}/configs/${c.name}`;
          if (def?.data_base64) ctx.file(rel, Buffer.from(def.data_base64, "base64").toString("utf8"));
          else ctx.note(`${inst.service.name}: config ${c.name} has no payload in the inventory; place it at /${rel} by hand`, "decision");
          manifest.push(`${rel} ${c.uid} ${c.gid} ${octal(c.mode)}`);
          u.add("Service", "BindReadOnlyPaths", `/etc/${stack}/configs/${c.name}:${target}`);
        }
      }
      ctx.install("pre", `cp -a "$here/var/lib/confexts/." /var/lib/confexts/`);
      ctx.install("pre", ["while read -r path uid gid mode; do", '    chown "$uid:$gid" "/$path"', '    chmod "$mode" "/$path"', "done <<'MANIFEST'", ...manifest, "MANIFEST"].join("\n"));
      ctx.install("post", "systemd-confext refresh");
      ctx.note(`stack ${stack}: config files ship as confext ${stack} (decision ${configsId(stack)}); systemd-confext refresh merges them into /etc`);
    }
  },
};
