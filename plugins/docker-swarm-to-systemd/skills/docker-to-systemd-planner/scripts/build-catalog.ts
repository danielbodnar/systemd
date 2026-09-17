#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Build the directive catalogue from the systemd tree's own man pages.
//
// The catalogue lists, for every unit type, file format, and tool the
// migration targets, the directives, line types, options, and verbs that the
// man pages document, with the version each was added in (from the
// version-info.xml includes). Renderers validate their output against it, so
// a directive this tree does not document is a test failure rather than a
// surprise on the host.
//
//   bun build-catalog.ts [--man DIR] [--version FILE] [-o FILE]
//
// Defaults resolve from the script's location inside the systemd tree:
// ../../../../../man and meson.version, writing ../../../contract/directives.json.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalog, CatalogPage } from "../../../contract/catalog.ts";

interface PageSpec {
  /** How refsect1 titles map to section names. */
  layout: "bracket" | "single" | "grouped" | "command";
  /** For "single": the section every entry belongs to. For "grouped": the page's own grouping is kept. */
  section?: string;
  /** Unit sections that accept this page's directives (for systemd.exec and friends). */
  applies_to?: string[];
  /** What the entries are: directives (Name=), line types (tmpfiles.d), variables (os-release), or options and verbs. */
  kind: "directive" | "line-type" | "variable" | "option";
}

const PAGES: Record<string, PageSpec> = {
  "systemd.unit": { layout: "bracket", kind: "directive" },
  "systemd.service": { layout: "single", section: "Service", kind: "directive" },
  "systemd.socket": { layout: "single", section: "Socket", kind: "directive" },
  "systemd.timer": { layout: "single", section: "Timer", kind: "directive" },
  "systemd.path": { layout: "single", section: "Path", kind: "directive" },
  "systemd.mount": { layout: "single", section: "Mount", kind: "directive" },
  "systemd.automount": { layout: "single", section: "Automount", kind: "directive" },
  "systemd.swap": { layout: "single", section: "Swap", kind: "directive" },
  "systemd.slice": { layout: "single", section: "Slice", kind: "directive" },
  "systemd.scope": { layout: "single", section: "Scope", kind: "directive" },
  "systemd.exec": { layout: "grouped", applies_to: ["Service", "Socket", "Mount", "Swap"], kind: "directive" },
  "systemd.kill": { layout: "single", section: "Kill", applies_to: ["Service", "Socket", "Mount", "Swap", "Scope"], kind: "directive" },
  "systemd.resource-control": {
    layout: "single",
    section: "ResourceControl",
    applies_to: ["Service", "Socket", "Mount", "Swap", "Slice", "Scope"],
    kind: "directive",
  },
  "systemd.network": { layout: "bracket", kind: "directive" },
  "systemd.netdev": { layout: "bracket", kind: "directive" },
  "systemd.link": { layout: "bracket", kind: "directive" },
  "systemd.nspawn": { layout: "bracket", kind: "directive" },
  "systemd.dnssd": { layout: "bracket", kind: "directive" },
  "repart.d": { layout: "bracket", kind: "directive" },
  "tmpfiles.d": { layout: "single", section: "tmpfiles.d", kind: "line-type" },
  "sysusers.d": { layout: "single", section: "sysusers.d", kind: "line-type" },
  "os-release": { layout: "single", section: "os-release", kind: "variable" },
  "systemd-nspawn": { layout: "command", kind: "option" },
  "systemd-vmspawn": { layout: "command", kind: "option" },
  "systemd-mstack": { layout: "command", kind: "option" },
  "systemd-sysext": { layout: "command", kind: "option" },
  "systemd-dissect": { layout: "command", kind: "option" },
  "systemd-repart": { layout: "command", kind: "option" },
  "systemd-creds": { layout: "command", kind: "option" },
  importctl: { layout: "command", kind: "option" },
  portablectl: { layout: "command", kind: "option" },
  machinectl: { layout: "command", kind: "option" },
  networkctl: { layout: "command", kind: "option" },
  resolvectl: { layout: "command", kind: "option" },
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function sectionTitle(chunk: string): string {
  const m = /<title>([\s\S]*?)<\/title>/.exec(chunk);
  return m ? stripTags(m[1]!) : "";
}

interface Entry {
  name: string;
  since: number | null;
}

/** Every varlistentry in a refsect1 chunk, with its terms and version include. */
function entries(chunk: string, spec: PageSpec): Entry[] {
  const out: Entry[] = [];
  const re = /<varlistentry[^>]*>([\s\S]*?)<\/varlistentry>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) {
    const body = m[1]!;
    const v = /<xi:include href="version-info\.xml" xpointer="v(\d+)"\/>/.exec(body);
    const since = v ? Number(v[1]) : null;
    const termRe = /<term>([\s\S]*?)<\/term>/g;
    let t: RegExpExecArray | null;
    while ((t = termRe.exec(body))) {
      const term = t[1]!;
      let name: string | null = null;
      if (spec.kind === "option") {
        const o = /<option>([\s\S]*?)<\/option>/.exec(term);
        const c = /<command>([\s\S]*?)<\/command>/.exec(term);
        const raw = o ? stripTags(o[1]!) : c ? stripTags(c[1]!) : null;
        if (!raw) continue;
        // Keep the switch itself, dropping the placeholder after "=": --mstack=PATH becomes --mstack=.
        const eq = raw.indexOf("=");
        name = eq >= 0 ? raw.slice(0, eq + 1) : raw.split(/\s/)[0]!;
        if (!/^(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*=?|[a-z][a-z0-9-]*)$/.test(name)) continue;
      } else {
        // A term may list several names: <varname>MemoryMin=</varname>, <varname>MemoryLow=</varname>.
        const vnRe = /<varname>([\s\S]*?)<\/varname>/g;
        let vn: RegExpExecArray | null;
        while ((vn = vnRe.exec(term))) {
          let n = stripTags(vn[1]!);
          if (spec.kind !== "line-type") {
            const eq = n.indexOf("=");
            if (eq > 0) n = n.slice(0, eq + 1);
          }
          if (spec.kind === "directive" && !/^[A-Za-z][A-Za-z0-9]*=$/.test(n)) continue;
          if (spec.kind === "variable" && !/^[A-Z][A-Z0-9_]*=$/.test(n)) continue;
          if (spec.kind === "line-type" && !/^[A-Za-z][+!^~=:$-]*$/.test(n)) continue;
          if (!out.some((e) => e.name === n)) out.push({ name: n, since });
        }
        continue;
      }
      if (!out.some((e) => e.name === name)) out.push({ name, since });
    }
  }
  return out;
}

/**
 * Expand the cross-page xi:include references that share an element by id
 * (systemd.network takes its [Match] entries from systemd.link, for example).
 * version-info includes are left in place for the version scan, and the XPath
 * form of xpointer is not supported: it is only used for prose.
 */
export function expandIncludes(xml: string, manDir: string, depth = 0): string {
  if (depth > 3) return xml;
  return xml.replace(/<xi:include href="([a-z0-9.-]+)\.xml" xpointer="([A-Za-z0-9_-]+)"\s*\/>/g, (whole, file: string, id: string) => {
    if (file === "version-info") return whole;
    const path = join(manDir, `${file}.xml`);
    if (!existsSync(path)) return "";
    const source = readFileSync(path, "utf8");
    const open = new RegExp(`<(varlistentry|variablelist|refsect1|refsect2|para|listitem)\\b[^>]*\\bid=["']${id}["'][^>]*>`);
    const m = open.exec(source);
    if (!m) return "";
    const tag = m[1]!;
    // Walk to the matching close tag, counting nested elements of the same name.
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
    tagRe.lastIndex = m.index;
    let level = 0;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(source))) {
      if (t[1] === "/") {
        level--;
        if (level === 0) return expandIncludes(source.slice(m.index, t.index + t[0].length), manDir, depth + 1);
      } else if (!t[0].endsWith("/>")) level++;
    }
    return "";
  });
}

export function parsePage(xml: string, spec: PageSpec, manDir?: string): CatalogPage {
  const page: CatalogPage = { kind: spec.kind, sections: {} };
  if (spec.applies_to) page.applies_to = spec.applies_to;
  if (manDir) xml = expandIncludes(xml, manDir);
  const chunks = xml.split(/<refsect1[^>]*>/).slice(1);
  for (const chunk of chunks) {
    const title = sectionTitle(chunk);
    let section: string | null = null;
    switch (spec.layout) {
      case "bracket": {
        const m = /^\[([A-Za-z0-9-]+)\] Section Options$/.exec(title);
        if (m) section = m[1]!;
        break;
      }
      case "single":
        if (title === "Options" || title === "Configuration File Format") section = spec.section!;
        break;
      case "grouped":
        if (!["Description", "Implicit Dependencies", "Examples", "See Also", "Environment Variables in Spawned Processes", "Process Exit Codes"].includes(title))
          section = title;
        break;
      case "command":
        if (title === "Options") section = "options";
        else if (title.endsWith("Commands")) section = "commands";
        break;
    }
    if (!section) continue;
    const found = entries(chunk, spec);
    if (found.length === 0) continue;
    const target = (page.sections[section] ??= {});
    for (const e of found) if (!(e.name in target)) target[e.name] = e.since;
  }
  return page;
}

export function buildCatalog(manDir: string, version: string): Catalog {
  const catalog: Catalog = {
    systemd_version: version,
    generated_by: "docker-to-systemd-planner/scripts/build-catalog.ts",
    pages: {},
  };
  for (const [name, spec] of Object.entries(PAGES)) {
    const path = join(manDir, `${name}.xml`);
    if (!existsSync(path)) {
      console.error(`warning: ${path} not found; page skipped`);
      continue;
    }
    catalog.pages[name] = parsePage(readFileSync(path, "utf8"), spec, manDir);
  }
  return catalog;
}

function count(c: Catalog): number {
  let n = 0;
  for (const p of Object.values(c.pages)) for (const s of Object.values(p.sections)) n += Object.keys(s).length;
  return n;
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  const tree = resolve(here, "..", "..", "..", "..", "..");
  let manDir = join(tree, "man");
  let versionFile = join(tree, "meson.version");
  let out = resolve(here, "..", "..", "..", "contract", "directives.json");
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--man") manDir = resolve(args[++i]!);
    else if (a === "--version") versionFile = resolve(args[++i]!);
    else if (a === "-o" || a === "--output") out = resolve(args[++i]!);
    else if (a === "-h" || a === "--help") {
      console.log("usage: build-catalog.ts [--man DIR] [--version FILE] [-o FILE]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!existsSync(manDir) || !readdirSync(manDir).some((f) => f.endsWith(".xml"))) {
    console.error(`no man pages under ${manDir}; pass --man DIR pointing at a systemd checkout's man/ directory`);
    process.exit(1);
  }
  const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "unknown";
  const catalog = buildCatalog(manDir, version);
  writeFileSync(out, JSON.stringify(catalog, null, 1) + "\n");
  console.log(`wrote ${out}: ${Object.keys(catalog.pages).length} pages, ${count(catalog)} entries, systemd ${version}`);
}
