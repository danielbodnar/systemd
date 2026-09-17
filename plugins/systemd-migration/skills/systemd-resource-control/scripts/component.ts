// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The resource-control component: a stack becomes a slice, and a service's
// limits and reservations become control group properties on its unit.

import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import { bytes, cpuQuota } from "../../../contract/unit.ts";

export const ACCOUNTING = "resource-control.accounting.estate";

export const resourceControlComponent: Component = {
  id: "resource-control",
  title: "Resource control (systemd.resource-control, systemd.slice)",
  covers: ["systemd.resource-control", "systemd.slice", "systemd.scope", "systemd-oomd.service", "oomd.conf", "oomctl", "iocost.conf", "systemd-cgls", "systemd-cgtop", "systemd-system.conf"],
  after: ["service"],

  decide(_ctx: PlanContext): DecisionSpec[] {
    return [
      {
        id: ACCOUNTING,
        kind: "choice",
        subject: { kind: "estate", name: "estate" },
        question: "Turn on memory and task accounting on every stack slice?",
        options: [
          { value: "yes", label: "accounting on", consequence: "MemoryAccounting= and TasksAccounting= on each stack-NAME.slice; systemctl status shows usage per stack" },
          { value: "no", label: "leave the manager's default", consequence: "DefaultMemoryAccounting= and DefaultTasksAccounting= from system.conf apply" },
        ],
        default: "yes",
      },
    ];
  },

  render(ctx: RenderContext): void {
    const accounting = ctx.value(ACCOUNTING) === "yes";
    const stacks = new Set<string>();
    for (const inst of ctx.instances) {
      stacks.add(inst.stack);
      if (inst.form !== "service") continue;
      const shape = ctx.get<ServiceShape>(instanceKey(inst.base));
      if (!shape) continue;
      const svc = inst.service;
      const u = ctx.unit(shape.unit);
      u.add("Service", "Slice", `stack-${inst.stack}.slice`);
      u.add("Service", "CPUQuota", cpuQuota(svc.resources.limits.nano_cpus));
      u.add("Service", "MemoryMax", bytes(svc.resources.limits.memory_bytes));
      u.add("Service", "MemoryLow", bytes(svc.resources.reservations.memory_bytes));
      u.add("Service", "TasksMax", svc.resources.limits.pids ?? null);
      if (svc.resources.reservations.nano_cpus) u.add("Service", "CPUWeight", Math.min(10000, Math.max(1, Math.round(svc.resources.reservations.nano_cpus / 10_000_000))));
    }
    for (const stack of [...stacks].sort()) {
      const s = ctx.unit(`stack-${stack}.slice`, [`Rendered by ${ctx.rendererName}: resource group of stack ${stack} on ${ctx.host}`]);
      s.add("Unit", "Description", `stack ${stack} slice`);
      if (accounting) {
        s.add("Slice", "MemoryAccounting", "yes");
        s.add("Slice", "TasksAccounting", "yes");
      }
      ctx.expect("slices", `stack-${stack}.slice`);
    }
  },
};
