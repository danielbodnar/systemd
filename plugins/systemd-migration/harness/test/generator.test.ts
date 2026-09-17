// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The generator component (PLAN.md 10.3). With generator.stacks.estate set
// to "generator" the rendered tree carries no <stack>.target and no
// stack-<stack>.slice: it carries one stack description under
// etc/systemd-migration/stacks.d/, the generator itself under usr/lib/, and
// the install lines that put both in place. The generator is then run under
// a POSIX shell against a temporary tree, and what it emits is checked
// against the directive catalogue, so the two halves are tested against
// each other rather than against a transcript.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkUnitText } from "../../contract/catalog.ts";
import { composeRender } from "../../contract/compose.ts";
import { type Plan, resolveDecision } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { GENERATOR_NAME, GENERATOR_PATH, MATERIALIZE, PRESET, PRESET_PATH, STACKS_DIR } from "../../skills/systemd-generator/scripts/component.ts";
import { ACCOUNTING } from "../../skills/systemd-resource-control/scripts/component.ts";
import { planFor } from "../../skills/systemd-service/scripts/render.ts";

const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const inv: Inventory = normalize(capture);
const generatorScript = resolve(import.meta.dir, "../../skills/systemd-generator/scripts", GENERATOR_NAME);

const WRK = "hosts/swarm-wrk-1";
const MGR = "hosts/swarm-mgr-1";

/** The fixture plan with the two decisions of 10.3 set; every other decision keeps its default. */
function planWith(materialize: string, preset: string, accounting = "yes"): Plan {
  const plan = planFor(inv);
  resolveDecision(plan, MATERIALIZE, materialize);
  resolveDecision(plan, PRESET, preset);
  resolveDecision(plan, ACCOUNTING, accounting);
  return plan;
}

function render(plan: Plan) {
  return composeRender(inv, plan, COMPONENTS, { acceptDefaults: true, rendererName: "systemd-migration test" });
}

function text(files: Record<string, string | Uint8Array>, path: string): string {
  const content = files[path];
  expect(content, `${path} is missing from the rendered tree`).toBeDefined();
  return content as string;
}

/** The values of one key of a stack description, in file order. */
function values(description: string, key: string): string[] {
  return description
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1));
}

/**
 * Run the generator under `sh` with the descriptions in `stacks`, and return
 * its exit status, its stderr, and every file and symlink it emitted into the
 * normal generator directory. The three output directories are distinct, so a
 * test can tell which one the generator chose.
 */
function runGenerator(stacks: Record<string, string>, args?: { argc?: number }): { status: number; stderr: string; files: Record<string, string>; links: Record<string, string>; early: string[]; late: string[] } {
  const work = mkdtempSync(join(tmpdir(), "systemd-migration-generator."));
  try {
    const descriptions = join(work, "stacks.d");
    mkdirSync(descriptions, { recursive: true });
    for (const [name, body] of Object.entries(stacks)) writeFileSync(join(descriptions, name), body);
    const normal = join(work, "generator");
    const early = join(work, "generator.early");
    const late = join(work, "generator.late");
    for (const d of [normal, early, late]) mkdirSync(d, { recursive: true });
    const argv = [normal, early, late].slice(0, args?.argc ?? 3);
    const run = Bun.spawnSync(["sh", generatorScript, ...argv], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SYSTEMD_MIGRATION_STACKS_DIRS: descriptions },
    });
    const files: Record<string, string> = {};
    const links: Record<string, string> = {};
    const walk = (dir: string, prefix = "") => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) links[rel] = readFileSync(join(dir, entry.name), "utf8") === "" ? "" : "unit";
        else if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else files[rel] = readFileSync(join(dir, entry.name), "utf8");
      }
    };
    walk(normal);
    return { status: run.exitCode, stderr: run.stderr.toString(), files, links, early: readdirSync(early), late: readdirSync(late) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A description in the format the component renders, for the cases the fixture cannot produce. */
function description(body: string[]): string {
  return body.join("\n") + "\n";
}

describe("the rendered tree with the generator chosen", () => {
  const { files, hosts } = render(planWith("generator", "no"));

  test("no stack target and no stack slice is a file on any host", () => {
    const grouping = Object.keys(files).filter((p) => /\/etc\/systemd\/system\/(?:[^/]+\.target|stack-[^/]+\.slice)$/.test(p));
    expect(grouping).toEqual([]);
  });

  test("each stack on a host gets a description with the units the components registered", () => {
    expect(Object.keys(files).filter((p) => p.includes(`/${STACKS_DIR}/`)).sort()).toEqual([`${MGR}/${STACKS_DIR}/web.conf`, `${WRK}/${STACKS_DIR}/data.conf`, `${WRK}/${STACKS_DIR}/web.conf`]);
    const data = text(files, `${WRK}/${STACKS_DIR}/data.conf`);
    expect(values(data, "Name")).toEqual(["data"]);
    expect(values(data, "Units")).toEqual(["data_exporter.service", "data_postgres.service", "var-lib-data-data_backups.mount"]);
    expect(values(data, "Slice")).toEqual(["stack-data.slice"]);
    expect(values(data, "WantedBy")).toEqual(["multi-user.target"]);
    // The manager host runs only the global proxy of the web stack.
    expect(values(text(files, `${MGR}/${STACKS_DIR}/web.conf`), "Units")).toEqual(["web_proxy.service"]);
  });

  test("the accounting decision of the resource-control component reaches the description", () => {
    expect(values(text(files, `${WRK}/${STACKS_DIR}/web.conf`), "Accounting")).toEqual(["yes"]);
    const off = render(planWith("generator", "no", "no")).files;
    expect(values(text(off, `${WRK}/${STACKS_DIR}/web.conf`), "Accounting")).toEqual(["no"]);
  });

  test("the generator itself is rendered under usr/ with mode 0755 and is the file this skill ships", () => {
    expect(text(files, `${WRK}/${GENERATOR_PATH}`)).toBe(readFileSync(generatorScript, "utf8"));
    expect(text(files, `${MGR}/${GENERATOR_PATH}`)).toStartWith("#!/bin/sh\n");
  });

  test("install.sh copies the generator into /usr/ before the daemon-reload that first runs it", () => {
    const install = text(files, `${WRK}/install.sh`).split("\n");
    const copy = install.findIndex((l) => l.includes(`install -D -m 0755 "$here/${GENERATOR_PATH}"`) && l.includes(`'/${GENERATOR_PATH}'`));
    const reload = install.indexOf("systemctl daemon-reload");
    expect(copy).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(copy);
    // Nothing tries to enable a generated target: the description's WantedBy= does that.
    expect(install.some((l) => l.startsWith("systemctl enable "))).toBe(false);
    expect(install.some((l) => l.startsWith("systemctl cat -- ") && l.includes("'web.target'"))).toBe(true);
  });

  test("the expectations still list the targets and slices, so the live verifier checks them", () => {
    expect(hosts["swarm-wrk-1"]!.targets).toEqual(["data.target", "web.target"]);
    expect(hosts["swarm-wrk-1"]!.slices).toEqual(["stack-data.slice", "stack-web.slice"]);
  });

  test("the notes say a dry run cannot see generated units and name the verifier that should learn", () => {
    const { notes } = render(planWith("generator", "no"));
    expect(notes.some((n) => n.includes("a dry-run verifier cannot see generator-emitted units") && n.includes("verify.sh"))).toBe(true);
  });

  test("with the default decision nothing of the generator is rendered and the grouping units come back", () => {
    const stat = render(planWith("static", "no")).files;
    expect(Object.keys(stat).filter((p) => p.includes("systemd-migration/stacks.d") || p.includes(GENERATOR_PATH))).toEqual([]);
    expect(text(stat, `${WRK}/etc/systemd/system/data.target`)).toContain("Wants=data_postgres.service");
    expect(text(stat, `${WRK}/etc/systemd/system/stack-data.slice`)).toContain("MemoryAccounting=yes");
  });
});

describe("the generator under sh", () => {
  const { files } = render(planWith("generator", "no"));
  const web = text(files, `${WRK}/${STACKS_DIR}/web.conf`);
  const data = text(files, `${WRK}/${STACKS_DIR}/data.conf`);

  test("the rendered descriptions produce the stack target, the slice, and the wants symlink", () => {
    const run = runGenerator({ "web.conf": web, "data.conf": data });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(Object.keys(run.files).sort()).toEqual(["data.target", "stack-data.slice", "stack-web.slice", "web.target"]);
    expect(Object.keys(run.links).sort()).toEqual(["multi-user.target.wants/data.target", "multi-user.target.wants/web.target"]);
    // argv[1] is the generator's default per systemd.generator(7); the other two stay empty.
    expect(run.early).toEqual([]);
    expect(run.late).toEqual([]);
  });

  test("the emitted units list the units of the description and pass the directive catalogue", () => {
    const run = runGenerator({ "web.conf": web, "data.conf": data });
    expect(values(run.files["data.target"]!, "Wants")).toEqual(values(data, "Units"));
    expect(values(run.files["web.target"]!, "Description")).toEqual(["stack web"]);
    expect(run.files["data.target"]!).toStartWith(`# Automatically generated by ${GENERATOR_NAME}`);
    expect(values(run.files["data.target"]!, "SourcePath")[0]).toEndWith("/stacks.d/data.conf");
    expect(run.files["stack-web.slice"]!).toContain("MemoryAccounting=yes");
    expect(run.files["stack-web.slice"]!).toContain("TasksAccounting=yes");
    for (const [name, body] of Object.entries(run.files)) {
      const check = checkUnitText(body, name.endsWith(".slice") ? "slice" : "target");
      expect(check.unknown, name).toEqual([]);
      expect(check.resolved.length, name).toBeGreaterThan(0);
    }
  });

  test("Accounting=no leaves the manager's defaults on the slice", () => {
    const off = render(planWith("generator", "no", "no")).files;
    const run = runGenerator({ "web.conf": text(off, `${WRK}/${STACKS_DIR}/web.conf`) });
    expect(run.files["stack-web.slice"]!).not.toContain("Accounting");
    expect(checkUnitText(run.files["stack-web.slice"]!, "slice").unknown).toEqual([]);
  });

  test("one argument means one output directory, as systemd.generator(7) asks of a test invocation", () => {
    const run = runGenerator({ "web.conf": web }, { argc: 1 });
    expect(run.status).toBe(0);
    expect(Object.keys(run.files).sort()).toEqual(["stack-web.slice", "web.target"]);
  });

  test("an empty WantedBy= emits the units without pulling them into the boot", () => {
    const run = runGenerator({ "web.conf": description(["[Stack]", "Name=web", "Units=web_app.service", "WantedBy="]) });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(Object.keys(run.links)).toEqual([]);
    expect(values(run.files["web.target"]!, "Wants")).toEqual(["web_app.service"]);
  });

  test("repeated Units= lines append, as a list setting does in systemd.unit(5)", () => {
    const run = runGenerator({ "web.conf": description(["[Stack]", "Name=web", "Units=a.service", "Units=b.service c.timer"]) });
    expect(values(run.files["web.target"]!, "Wants")).toEqual(["a.service", "b.service", "c.timer"]);
  });
});

describe("the generator on input it cannot use", () => {
  const good = description(["[Stack]", "Name=web", "Units=web_app.service", "WantedBy=multi-user.target"]);

  test("a malformed description is skipped with a message on stderr, the good one is still emitted, and the status is 0", () => {
    const run = runGenerator({ "web.conf": good, "broken.conf": "this is not an ini line\n" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("broken.conf:1: not a key=value line; skipping the file");
    expect(run.stderr).toContain("skipped 1 description(s) with problems");
    expect(Object.keys(run.files).sort()).toEqual(["stack-web.slice", "web.target"]);
  });

  test("a description without a usable Name= is skipped", () => {
    const run = runGenerator({ "web.conf": good, "nameless.conf": description(["[Stack]", "Units=a.service"]) });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Name= is missing or is not usable as a unit name");
    expect(run.files["web.target"]).toBeDefined();
  });

  test("an assignment before any section, and an unterminated section header, are both refused", () => {
    const a = runGenerator({ "a.conf": description(["Name=web"]) });
    expect(a.status).toBe(0);
    expect(a.stderr).toContain("assignment before any section");
    const b = runGenerator({ "b.conf": description(["[Stack", "Name=web"]) });
    expect(b.status).toBe(0);
    expect(b.stderr).toContain("malformed section header");
  });

  test("an unknown key and an unknown section are reported but do not lose the stack", () => {
    const run = runGenerator({ "web.conf": description(["[Stack]", "Name=web", "Colour=blue", "Units=a.service", "[Other]", "Name=ignored"]) });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("key Colour= is not known and is ignored");
    expect(run.stderr).toContain("section [Other] is not known and is ignored");
    expect(values(run.files["web.target"]!, "Wants")).toEqual(["a.service"]);
  });

  test("a unit name that is not a unit name is left out of Wants=, and a bad WantedBy= gets no symlink", () => {
    const run = runGenerator({ "web.conf": description(["[Stack]", "Name=web", "Units=ok.service not a unit", "WantedBy=multi-user.service"]) });
    expect(run.status).toBe(0);
    expect(values(run.files["web.target"]!, "Wants")).toEqual(["ok.service"]);
    expect(run.stderr).toContain("is not a target and is left out");
    expect(Object.keys(run.links)).toEqual([]);
  });

  test("a Slice= that is not a slice falls back to stack-<name>.slice", () => {
    const run = runGenerator({ "web.conf": description(["[Stack]", "Name=web", "Slice=web.service"]) });
    expect(run.stderr).toContain("does not end in .slice");
    expect(run.files["stack-web.slice"]).toBeDefined();
  });

  test("an Accounting= that is not a boolean keeps the manager's default and says so", () => {
    const run = runGenerator({ "web.conf": description(["[Stack]", "Name=web", "Accounting=maybe"]) });
    expect(run.stderr).toContain("is not a boolean");
    expect(run.files["stack-web.slice"]!).not.toContain("Accounting");
  });

  test("two descriptions claiming the same stack keep the first and report the second", () => {
    const run = runGenerator({ "a.conf": description(["[Stack]", "Name=web", "Units=first.service"]), "b.conf": description(["[Stack]", "Name=web", "Units=second.service"]) });
    expect(run.status).toBe(0);
    expect(values(run.files["web.target"]!, "Wants")).toEqual(["first.service"]);
    expect(run.stderr).toContain("was already generated from another description");
  });

  test("no description directory at all is not an error", () => {
    const run = runGenerator({});
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(Object.keys(run.files)).toEqual([]);
  });

  test("an empty file masks the stack, and a later directory does not bring it back", () => {
    const work = mkdtempSync(join(tmpdir(), "systemd-migration-generator.mask."));
    try {
      const high = join(work, "etc");
      const low = join(work, "usr");
      mkdirSync(high, { recursive: true });
      mkdirSync(low, { recursive: true });
      writeFileSync(join(high, "web.conf"), "");
      writeFileSync(join(low, "web.conf"), description(["[Stack]", "Name=web", "Units=a.service"]));
      writeFileSync(join(low, "data.conf"), description(["[Stack]", "Name=data", "Units=b.service"]));
      const out = join(work, "generator");
      mkdirSync(out, { recursive: true });
      const run = Bun.spawnSync(["sh", generatorScript, out], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SYSTEMD_MIGRATION_STACKS_DIRS: `${high}:${low}` } });
      expect(run.exitCode).toBe(0);
      expect(readdirSync(out).sort()).toEqual(["data.target", "stack-data.slice"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a description masked with a symlink to /dev/null is skipped like an empty file", () => {
    const work = mkdtempSync(join(tmpdir(), "systemd-migration-generator.null."));
    try {
      const dir = join(work, "stacks.d");
      mkdirSync(dir, { recursive: true });
      symlinkSync("/dev/null", join(dir, "web.conf"));
      const out = join(work, "generator");
      mkdirSync(out, { recursive: true });
      const run = Bun.spawnSync(["sh", generatorScript, out], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SYSTEMD_MIGRATION_STACKS_DIRS: dir } });
      expect(run.exitCode).toBe(0);
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("the user manager and the initrd are not this generator's business", () => {
    const work = mkdtempSync(join(tmpdir(), "systemd-migration-generator.scope."));
    try {
      const dir = join(work, "stacks.d");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "web.conf"), description(["[Stack]", "Name=web", "Units=a.service"]));
      for (const env of [{ SYSTEMD_SCOPE: "user" }, { SYSTEMD_IN_INITRD: "1" }]) {
        const out = mkdtempSync(join(work, "out."));
        const run = Bun.spawnSync(["sh", generatorScript, out], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SYSTEMD_MIGRATION_STACKS_DIRS: dir, ...env } });
        expect(run.exitCode).toBe(0);
        expect(readdirSync(out)).toEqual([]);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("with no output directory it says how it is called and refuses, which is the only non-zero status", () => {
    const run = Bun.spawnSync(["sh", generatorScript], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("usage:");
  });
});

describe("the preset file", () => {
  test("with the preset decision the rendered units that carry [Install] are enabled by policy, not by install.sh", () => {
    const { files } = render(planWith("static", "yes"));
    const preset = text(files, `${WRK}/${PRESET_PATH}`);
    expect(preset.split("\n").filter((l) => l.startsWith("enable "))).toEqual(["enable data.target", "enable var-lib-data-data_backups.mount", "enable web.target"]);
    const install = text(files, `${WRK}/install.sh`).split("\n");
    expect(install).toContain(`install -D -m 0644 "$here/${PRESET_PATH}" '/${PRESET_PATH}'`);
    expect(install).toContain("systemctl preset 'data.target' 'var-lib-data-data_backups.mount' 'web.target'");
    // preset-all would re-apply policy to every unit on the host, not only these.
    expect(install.some((l) => l.includes("preset-all"))).toBe(false);
    expect(install.some((l) => l.startsWith("systemctl enable "))).toBe(false);
  });

  test("the preset file names only units that exist in the tree and parses as systemd.preset(5) directives", () => {
    const { files } = render(planWith("static", "yes"));
    for (const line of text(files, `${WRK}/${PRESET_PATH}`).split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [verb, unit, ...rest] = line.split(" ");
      expect(["enable", "disable", "ignore"], line).toContain(verb!);
      expect(rest, line).toEqual([]);
      if (verb === "enable") expect(files[`${WRK}/etc/systemd/system/${unit}`], line).toBeDefined();
    }
  });

  test("with the generator the stack targets stay out of the preset file, because a generated unit has no [Install]", () => {
    const { files } = render(planWith("generator", "yes"));
    const preset = text(files, `${WRK}/${PRESET_PATH}`);
    expect(preset).not.toContain("enable web.target");
    expect(preset).not.toContain("enable data.target");
    expect(preset).toContain("enable var-lib-data-data_backups.mount");
    expect(preset).toContain(`emitted by ${GENERATOR_NAME}`);
  });

  test("without the preset decision install.sh enables the stack targets and no preset file is written", () => {
    const { files, notes } = render(planWith("static", "no"));
    expect(files[`${WRK}/${PRESET_PATH}`]).toBeUndefined();
    expect(text(files, `${WRK}/install.sh`).split("\n")).toContain("systemctl enable 'data.target' 'web.target'");
    expect(notes.some((n) => n.includes("the service component gives each stack target [Install] WantedBy=multi-user.target but enables nothing"))).toBe(true);
  });

  test("the fixture estate runs every service it defines, so no disable line is inferable and the notes say so", () => {
    const { notes } = render(planWith("static", "yes"));
    expect(inv.services.some((s) => s.replicas === 0)).toBe(false);
    expect(notes.some((n) => n.includes("no disable line was inferable"))).toBe(true);
  });

  test("a service the estate defines but runs no replica of becomes a disable line", () => {
    const idle: Inventory = { ...inv, services: inv.services.map((s) => (s.name === "data_exporter" ? { ...s, replicas: 0 } : s)) };
    const plan = planFor(idle);
    resolveDecision(plan, MATERIALIZE, "static");
    resolveDecision(plan, PRESET, "yes");
    // A service with no replica gets no placement default, and the planner
    // refuses to invent one, so the estate has to name a host for it.
    for (const d of plan.decisions) if (d.chosen == null && d.default == null) resolveDecision(plan, d.id, "swarm-wrk-1", "runs nowhere");
    const out = composeRender(idle, plan, COMPONENTS, { acceptDefaults: true, rendererName: "systemd-migration test" });
    expect(text(out.files, `${WRK}/${PRESET_PATH}`)).toContain("disable data_exporter.service");
    // A disable line cannot stop a unit the stack target wants; the note says so.
    expect(out.notes.some((n) => n.includes("the stack target still wants it") && n.includes("contract/placement.ts"))).toBe(true);
  });
});

describe("the generator as a file", () => {
  test("it is a POSIX sh script this repository can execute", () => {
    const text = readFileSync(generatorScript, "utf8");
    expect(text).toStartWith("#!/bin/sh\n");
    expect(text).toContain("set -eu");
    expect(statSync(generatorScript).mode & 0o111).toBeGreaterThan(0);
    // No bashism reaches it: dash is the reference, sh is what systemd runs it under.
    for (const shell of ["sh", "bash"]) {
      const check = Bun.spawnSync([shell, "-n", generatorScript]);
      expect(check.exitCode, `${shell} -n`).toBe(0);
    }
  });

  test("it documents the description format and the directories it reads, at the top of the file", () => {
    const header = readFileSync(generatorScript, "utf8").split("\nset -eu")[0]!;
    for (const key of ["[Stack]", "Name=", "Units=", "Slice=", "Accounting=", "WantedBy=", "Description="]) expect(header, key).toContain(key);
    for (const dir of ["/etc/systemd-migration/stacks.d", "/run/systemd-migration/stacks.d", "/usr/lib/systemd-migration/stacks.d"]) expect(header, dir).toContain(dir);
  });

  test("the copy rendered into the tree is executable where the install line says 0755", () => {
    const work = mkdtempSync(join(tmpdir(), "systemd-migration-generator.mode."));
    try {
      const { files } = render(planWith("generator", "no"));
      const target = join(work, GENERATOR_NAME);
      writeFileSync(target, text(files, `${WRK}/${GENERATOR_PATH}`));
      chmodSync(target, 0o755);
      const run = Bun.spawnSync([target, work], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SYSTEMD_MIGRATION_STACKS_DIRS: work } });
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
