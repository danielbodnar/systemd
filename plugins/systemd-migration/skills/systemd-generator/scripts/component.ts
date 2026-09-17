// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The generator component: how the rendered estate is materialized on a host.
// The default keeps every rendered unit as a file under /etc/systemd/system.
// The alternative installs a declarative description of each stack under
// /etc/systemd-migration/stacks.d/ and a systemd generator (systemd.generator(7),
// shipped by this skill) emits the stack targets, slices, and their Wants= at
// boot and on daemon-reload, so the host carries no generated grouping units.
// Preset files (systemd.preset(5)) make the enable state declarative either way.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";

/** Whether stack grouping units are rendered as files or emitted by the generator. */
export const MATERIALIZE = "generator.stacks.estate";
/** Whether a preset file decides which rendered units are enabled. */
export const PRESET = "generator.preset.estate";

export function materializedByGenerator(ctx: RenderContext): boolean {
  return ctx.valueOr(MATERIALIZE, "static") === "generator";
}

export const generatorComponent: Component = {
  id: "generator",
  title: "Generators and presets (systemd.generator, systemd.preset)",
  covers: ["systemd.generator", "systemd.preset"],
  after: ["service", "resource-control"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const stacks = ctx.inventory.stacks.map((s) => s.name);
    return [
      {
        id: MATERIALIZE,
        subject: { kind: "estate", name: "estate" },
        kind: "choice",
        question: "How do the stack targets and slices reach the host: rendered unit files, or a generator reading a declarative stack description at boot?",
        options: [
          { value: "static", label: "rendered unit files", consequence: "<stack>.target and stack-<stack>.slice are files under /etc/systemd/system, installed by install.sh" },
          { value: "generator", label: "systemd-migration-generator", consequence: "install.sh writes /etc/systemd-migration/stacks.d/<stack>.conf and the generator emits the targets, slices, and Wants= into the early generator directory on every daemon-reload; edits to the description need no re-render" },
        ],
        default: "static",
        evidence: stacks.map((s) => `stacks[${s}]`),
      },
      {
        id: PRESET,
        subject: { kind: "estate", name: "estate" },
        kind: "choice",
        question: "Is the enable state of the rendered units decided by a preset file?",
        options: [
          { value: "no", label: "install.sh enables the stack targets", consequence: "systemctl enable <stack>.target per stack in install.sh; nothing else is enabled" },
          { value: "yes", label: "a preset file", consequence: "/usr/lib/systemd/system-preset/80-systemd-migration.preset enables the stack targets and disables what the estate does not run; install.sh runs systemctl preset-all on the rendered units" },
        ],
        default: "no",
        evidence: stacks.map((s) => `stacks[${s}]`),
      },
    ];
  },

  render(_ctx: RenderContext): void {
    // Filled in by the generator work stream (PLAN.md section 10.3).
  },
};
