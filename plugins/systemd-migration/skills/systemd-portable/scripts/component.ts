// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The portable component: a service the plan marks as portable ships as an
// image under /var/lib/portables that portablectl attaches, and a stack can
// run under its own capsule manager. Both are forms the plan selects per
// service or per stack; this module renders the attach step and notes what
// the image must contain.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import { imageName } from "../../../contract/unit.ts";

export function capsuleId(stack: string): string {
  return `portable.capsule.${stack}`;
}

export const portableComponent: Component = {
  id: "portable",
  title: "Portable services and capsules (portablectl, capsule@.service)",
  covers: ["portablectl", "systemd-portabled.service", "capsule@.service"],
  after: ["service", "machined"],

  decide(ctx: PlanContext): DecisionSpec[] {
    return ctx.inventory.stacks.map((s) => ({
      id: capsuleId(s.name),
      kind: "choice" as const,
      subject: { kind: "stack" as const, name: s.name },
      question: `Does stack ${s.name} run under the system manager or under its own capsule?`,
      options: [
        { value: "system", label: "the system manager", consequence: "units under /etc/systemd/system grouped by the stack target and slice" },
        { value: "capsule", label: "a capsule", consequence: `capsule@${s.name}.service starts a per-stack user manager; the stack's units become its user units under /var/lib/capsules/${s.name}/.config/systemd/user`, requires: { systemd: 256 } },
      ],
      default: "system",
      evidence: s.services.map((n) => `services[${n}]`),
    }));
  },

  render(ctx: RenderContext): void {
    for (const inst of ctx.instances) {
      if (inst.form !== "portable") continue;
      const name = imageName(inst.service.image);
      ctx.install("post", `portablectl attach --now --profile=default '/var/lib/portables/${name}'`);
      ctx.note(`${inst.service.name}: the plan runs it as a portable service; the image under /var/lib/portables/${name} must carry ${inst.base}.service and an os-release, which the pulled OCI image does not; build it from the rendered unit before attaching (see the systemd-portable skill)`, "decision");
      ctx.expect("units", inst.unit);
    }
    for (const stack of new Set(ctx.instances.map((i) => i.stack))) {
      if (ctx.valueOr(capsuleId(stack), "system") === "capsule") ctx.note(`stack ${stack}: the plan runs it under capsule@${stack}.service; move the stack's units to /var/lib/capsules/${stack}/.config/systemd/user and start the capsule (decision ${capsuleId(stack)})`, "decision");
    }
  },
};
