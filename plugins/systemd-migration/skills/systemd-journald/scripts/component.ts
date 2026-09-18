// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The journald component: every service logs to the journal with the stack
// and service as fields, under its own identifier, and a stack can get its
// own journal namespace when the plan asks for one.

import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";

export function namespaceId(stack: string): string {
  return `journald.namespace.${stack}`;
}

export const journaldComponent: Component = {
  id: "journald",
  title: "Logging (journald.conf, systemd.journal-fields, LogNamespace=)",
  covers: ["systemd-journald.service", "journald.conf", "systemd.journal-fields", "journalctl", "systemd-journal-remote.service", "journal-remote.conf", "systemd-journal-upload.service", "journal-upload.conf", "systemd-journal-gatewayd.service", "systemd-cat"],
  after: ["service"],

  decide(ctx: PlanContext): DecisionSpec[] {
    return ctx.inventory.stacks.map((s) => ({
      id: namespaceId(s.name),
      kind: "choice" as const,
      subject: { kind: "stack" as const, name: s.name },
      question: `Does stack ${s.name} log into the host's journal or into its own journal namespace?`,
      options: [
        { value: "shared", label: "the host's journal", consequence: "one journal; filter with SWARM_STACK=NAME or the unit name" },
        { value: "namespace", label: "its own namespace", consequence: `LogNamespace=${s.name} on every unit; journald@${s.name}.service keeps a separate journal with its own retention (journald@.conf)` },
      ],
      default: "shared",
      evidence: s.services.map((n) => `services[${n}].logging`),
    }));
  },

  render(ctx: RenderContext): void {
    const namespaced = new Set<string>();
    for (const inst of ctx.instances) {
      if (inst.form !== "service") continue;
      const shape = ctx.get<ServiceShape>(instanceKey(inst.base));
      if (!shape) continue;
      const svc = inst.service;
      const u = ctx.unit(shape.unit);
      u.add("Service", "SyslogIdentifier", inst.base);
      u.add("Service", "LogExtraFields", `SWARM_STACK=${inst.stack} SWARM_SERVICE=${svc.name}`);
      if (ctx.valueOr(namespaceId(inst.stack), "shared") === "namespace") {
        u.add("Service", "LogNamespace", inst.stack);
        namespaced.add(inst.stack);
      }
      if (svc.logging.driver && !["json-file", "journald", "local"].includes(svc.logging.driver)) ctx.note(`${svc.name}: log driver ${svc.logging.driver} rendered as the journal`);
    }
    for (const stack of [...namespaced].sort()) {
      ctx.file(`etc/systemd/journald@${stack}.conf`, [`# Rendered by ${ctx.rendererName}: journal namespace of stack ${stack}`, "[Journal]", "Storage=persistent", ""].join("\n"));
      ctx.note(`stack ${stack}: logs go to journal namespace ${stack}; read them with journalctl --namespace=${stack}`);
    }
  },
};
