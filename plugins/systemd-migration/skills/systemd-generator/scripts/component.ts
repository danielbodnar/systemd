// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The generator component: how the rendered estate is materialized on a host.
// The default keeps every rendered unit as a file under /etc/systemd/system.
// The alternative installs a declarative description of each stack under
// /etc/systemd-migration/stacks.d/ and a systemd generator (systemd.generator(7),
// shipped by this skill) emits the stack targets, slices, and their Wants= at
// boot and on daemon-reload, so the host carries no generated grouping units.
// Preset files (systemd.preset(5)) make the enable state declarative either way.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import { shellQuote } from "../../../contract/unit.ts";

/** The resource-control component's accounting decision; named here rather than imported, so the two components do not import each other. */
const ACCOUNTING = "resource-control.accounting.estate";

/** Whether stack grouping units are rendered as files or emitted by the generator. */
export const MATERIALIZE = "generator.stacks.estate";
/** Whether a preset file decides which rendered units are enabled. */
export const PRESET = "generator.preset.estate";

/** The generator this skill ships, as installed on a host. */
export const GENERATOR_NAME = "systemd-migration-generator";
export const GENERATOR_PATH = `usr/lib/systemd/system-generators/${GENERATOR_NAME}`;
/** Where install.sh writes the stack descriptions the generator reads. */
export const STACKS_DIR = "etc/systemd-migration/stacks.d";
/** The preset file, named per systemd.preset(5): a two-digit priority, a dash, and the policy name. */
export const PRESET_PATH = "usr/lib/systemd/system-preset/80-systemd-migration.preset";

export function materializedByGenerator(ctx: RenderContext): boolean {
  return ctx.valueOr(MATERIALIZE, "static") === "generator";
}

export function presetDecidesEnableState(ctx: RenderContext): boolean {
  return ctx.valueOr(PRESET, "no") === "yes";
}

/** The generator's own text, read from this skill's scripts/ directory. */
export function generatorText(): string {
  return readFileSync(resolve(import.meta.dir, GENERATOR_NAME), "utf8");
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
          { value: "generator", label: "systemd-migration-generator", consequence: "install.sh writes /etc/systemd-migration/stacks.d/<stack>.conf and installs the generator under /usr/lib/systemd/system-generators/; the manager emits the targets, slices, and Wants= into the generator directory on every boot and every daemon-reload, so an edit to the description needs no re-render" },
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
          { value: "yes", label: "a preset file", consequence: "/usr/lib/systemd/system-preset/80-systemd-migration.preset enables every rendered unit with an [Install] section and disables what the estate runs no replica of; install.sh runs systemctl preset over those units, never preset-all" },
        ],
        default: "no",
        evidence: stacks.map((s) => `stacks[${s}]`),
      },
    ];
  },

  render(_ctx: RenderContext): void {
    // Everything this component writes depends on what the other components
    // registered for each stack, so it all happens in finish().
  },

  finish(ctx: RenderContext): void {
    if (materializedByGenerator(ctx)) renderGenerator(ctx);
    renderPreset(ctx);
  },
};

/**
 * The generator path: one description per stack, the generator itself under
 * /usr/lib/, and the install lines that put the generator in place before the
 * engine's daemon-reload runs it. The service and resource-control components
 * skipped their target and slice files, so the expectations recorded here are
 * the only record the verifier has of them.
 */
function renderGenerator(ctx: RenderContext): void {
  const stacks = ctx.stacks();
  const accounting = ctx.valueOr(ACCOUNTING, "yes") === "yes";
  for (const [stack, units] of stacks) {
    ctx.file(
      `${STACKS_DIR}/${stack}.conf`,
      [
        `# Rendered by ${ctx.rendererName} for ${ctx.host}: the description ${GENERATOR_NAME}`,
        `# turns into ${stack}.target and stack-${stack}.slice on every boot and every`,
        `# daemon-reload. Edit this file and run "systemctl daemon-reload"; nothing here`,
        "# needs re-rendering. The format is documented in the systemd-generator skill",
        "# (references/stacks-d.md).",
        "",
        "[Stack]",
        `Name=${stack}`,
        `Description=stack ${stack}`,
        ...units.map((u) => `Units=${u}`),
        `Slice=stack-${stack}.slice`,
        `Accounting=${accounting ? "yes" : "no"}`,
        "WantedBy=multi-user.target",
        "",
      ].join("\n"),
    );
    // The units do not exist as files, but they exist on a running host, so
    // the live verifier still checks them against expected.json.
    ctx.expect("targets", `${stack}.target`);
    ctx.expect("slices", `stack-${stack}.slice`);
  }
  ctx.file(GENERATOR_PATH, generatorText(), 0o755);
  // install.sh copies etc/ on its own; /usr/ is explicit, and the copy must
  // land before the engine's daemon-reload, which is what first runs the
  // generator over the descriptions.
  ctx.install("pre", `install -D -m 0755 "$here/${GENERATOR_PATH}" ${shellQuote(`/${GENERATOR_PATH}`)}`);
  ctx.install("post", `systemctl cat -- ${[...stacks.keys()].map((s) => shellQuote(`${s}.target`)).join(" ")} >/dev/null || echo ${shellQuote(`warning: ${GENERATOR_NAME} produced no stack targets; run it by hand against a temporary directory to see why`)} >&2`);
  ctx.note(`stack grouping is generated: ${GENERATOR_NAME} emits ${[...stacks.keys()].map((s) => `${s}.target and stack-${s}.slice`).join(", ")} from /${STACKS_DIR}/ on every daemon-reload, so no grouping unit is a file under /etc/systemd/system`, "decision");
  ctx.note(`a dry-run verifier cannot see generator-emitted units: ${[...stacks.keys()].map((s) => `${s}.target`).join(", ")} and their slices exist only after daemon-reload on the host, so systemd-analyze verify over the rendered tree skips them; verify.sh should learn to run the generator into a temporary directory (or read systemctl show on the host) before reporting them missing`);
  ctx.note(`"install.sh --start" ends in "systemctl enable --now ${[...stacks.keys()].map((s) => `${s}.target`).join(" ")}", which a generated target refuses because it has no [Install] section; start those targets with "systemctl start" instead, and treat the enable failure as expected until the engine's install.sh learns the difference`);
}

/**
 * The enable state. With a preset file the policy is declarative and
 * install.sh applies it with `systemctl preset` over the units it rendered,
 * not preset-all, so nothing outside this estate changes. Without one,
 * install.sh enables the stack targets, which no other component does.
 */
function renderPreset(ctx: RenderContext): void {
  const generated = materializedByGenerator(ctx);
  // A generated target carries no [Install] section: the generator writes the
  // multi-user.target.wants/ symlink itself, so neither preset nor enable
  // applies to it.
  const installable = ctx
    .unitFiles()
    .filter(({ path, unit }) => path.startsWith("etc/systemd/system/") && unit.has("Install"))
    .map(({ path }) => path.slice("etc/systemd/system/".length))
    .sort();
  const targets = generated ? [] : [...ctx.stacks().keys()].map((s) => `${s}.target`).filter((t) => installable.includes(t));

  if (!presetDecidesEnableState(ctx)) {
    if (generated) {
      ctx.note(`the stack targets are generated, so install.sh does not enable them: ${GENERATOR_NAME} writes the multi-user.target.wants/ symlink from WantedBy= in each description`);
      return;
    }
    if (targets.length) {
      ctx.install("post", `systemctl enable ${targets.map(shellQuote).join(" ")}`);
      ctx.note("the service component gives each stack target [Install] WantedBy=multi-user.target but enables nothing; install.sh now runs systemctl enable over the stack targets, and install.sh --start still enables and starts them");
    }
    return;
  }

  // Units the estate defines but runs none of. A preset file is where that
  // belongs, although the unit is still rendered and still wanted by its
  // stack target, so the line only keeps it from being enabled on its own.
  const idle = ctx.inventory.services.filter((s) => s.replicas === 0).map((s) => `${s.name}.service`).sort();
  const lines = [
    `# Rendered by ${ctx.rendererName} for ${ctx.host}.`,
    "# systemd.preset(5): the enable state of the units this migration rendered.",
    "# install.sh applies it with systemctl preset over those units only, so the",
    "# rest of the host's policy is untouched. Override it with a file of the same",
    "# name under /etc/systemd/system-preset/, or mask it with a symlink to /dev/null.",
    "",
  ];
  if (generated) lines.push(`# ${[...ctx.stacks().keys()].map((s) => `${s}.target`).join(", ")} ${ctx.stacks().size === 1 ? "is" : "are"} emitted by ${GENERATOR_NAME} with the`, "# multi-user.target.wants/ symlink already in place, so no preset applies to it.", "");
  for (const u of installable) lines.push(`enable ${u}`);
  if (idle.length) {
    lines.push("", "# The estate defines these but runs no replica of them.");
    for (const u of idle) lines.push(`disable ${u}`);
    ctx.note(`the preset file disables ${idle.join(", ")}, which the estate defines with no replica; the unit is still rendered and the stack target still wants it, so the disable line only keeps it from being enabled on its own. Leaving a zero-replica service out of the stack's Wants= belongs to the service component and contract/placement.ts`);
  }
  lines.push("");
  ctx.file(PRESET_PATH, lines.join("\n"));
  ctx.install("pre", `install -D -m 0644 "$here/${PRESET_PATH}" ${shellQuote(`/${PRESET_PATH}`)}`);
  if (installable.length) ctx.install("post", `systemctl preset ${installable.map(shellQuote).join(" ")}`);
  ctx.note(`the enable state comes from /${PRESET_PATH}; install.sh runs systemctl preset over the ${installable.length} rendered unit(s) that carry an [Install] section rather than preset-all, which would re-apply policy to the whole host`, "decision");
  if (!idle.length) ctx.note("no disable line was inferable: every service in the inventory runs at least one replica, so the preset file only enables");
}
