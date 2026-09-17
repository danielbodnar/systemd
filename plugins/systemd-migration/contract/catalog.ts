// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The directive catalogue: what this systemd tree documents for every unit
// type, file format, and tool the migration targets. directives.json next to
// this file is generated from man/ by the planner skill's build-catalog.ts;
// this module answers "is this directive documented for this section of this
// file type, and since which version", and checks whole unit files.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directive name (or line type, variable, option, verb) to the version it was added in, null when undocumented. */
export type CatalogSection = Record<string, number | null>;

export interface CatalogPage {
  kind: "directive" | "line-type" | "variable" | "option";
  /** Unit sections that accept this page's directives, for pages shared by several unit types. */
  applies_to?: string[];
  sections: Record<string, CatalogSection>;
}

export interface Catalog {
  systemd_version: string;
  generated_by: string;
  pages: Record<string, CatalogPage>;
}

/** Where a directive is documented and since when. */
export interface DirectiveInfo {
  page: string;
  section: string;
  since: number | null;
}

/**
 * The file types the checker understands. Unit types map to their own page
 * plus the shared exec, kill, and resource-control pages; networkd, nspawn,
 * dnssd, and repart files map to their bracketed sections; the quadlet types
 * check only the systemd sections and leave Podman's own to Podman.
 */
export type FileType =
  | "service"
  | "socket"
  | "timer"
  | "path"
  | "mount"
  | "automount"
  | "swap"
  | "slice"
  | "scope"
  | "target"
  | "device"
  | "network"
  | "netdev"
  | "link"
  | "nspawn"
  | "dnssd"
  | "repart"
  | "quadlet";

const SHARED_EXEC = ["systemd.exec", "systemd.kill", "systemd.resource-control"];

/** For each file type, the unit sections it may contain and the pages that document each. */
const SECTION_SOURCES: Record<FileType, Record<string, string[]>> = {
  service: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Service: ["systemd.service", ...SHARED_EXEC] },
  socket: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Socket: ["systemd.socket", ...SHARED_EXEC] },
  timer: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Timer: ["systemd.timer"] },
  path: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Path: ["systemd.path"] },
  mount: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Mount: ["systemd.mount", ...SHARED_EXEC] },
  automount: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Automount: ["systemd.automount"] },
  swap: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Swap: ["systemd.swap", ...SHARED_EXEC] },
  slice: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Slice: ["systemd.slice", "systemd.resource-control"] },
  scope: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Scope: ["systemd.scope", "systemd.kill", "systemd.resource-control"] },
  target: { Unit: ["systemd.unit"], Install: ["systemd.unit"] },
  device: { Unit: ["systemd.unit"], Install: ["systemd.unit"] },
  network: { "*": ["systemd.network"] },
  netdev: { "*": ["systemd.netdev"] },
  link: { "*": ["systemd.link"] },
  nspawn: { "*": ["systemd.nspawn"] },
  dnssd: { "*": ["systemd.dnssd"] },
  repart: { "*": ["repart.d"] },
  quadlet: { Unit: ["systemd.unit"], Install: ["systemd.unit"], Service: ["systemd.service", ...SHARED_EXEC] },
};

/**
 * Directives the manager still accepts in a section other than the documented
 * one, kept from before they moved (src/core/load-fragment-gperf.gperf.in
 * carries the same aliases). They resolve to their documented home.
 */
const COMPAT_ALIASES: Record<string, Record<string, Record<string, [FileType, string]>>> = {
  service: { Service: { "FailureAction=": ["service", "Unit"], "SuccessAction=": ["service", "Unit"] } },
};

/** Section names the parsers still accept for a documented section (the shipped 80-container-host0.network uses [DHCP]). */
const SECTION_ALIASES: Record<string, Record<string, string>> = {
  network: { DHCP: "DHCPv4" },
};

/** Quadlet sections that belong to Podman's generator rather than systemd, so the checker leaves them alone. */
const QUADLET_SECTIONS = new Set(["Container", "Pod", "Volume", "Network", "Kube", "Image", "Build", "Quadlet"]);

/** Map a file name to its file type from the extension; returns null for names the checker does not cover. */
export function fileTypeOf(name: string): FileType | null {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  if (["container", "pod", "volume", "kube", "image", "build"].includes(ext)) return "quadlet";
  if (ext in SECTION_SOURCES) return ext as FileType;
  if (ext === "conf" && /repart\.d\//.test(name)) return "repart";
  return null;
}

let cached: Catalog | null = null;

/** Load directives.json (the copy next to this module unless a path is given). */
export function loadCatalog(path?: string): Catalog {
  if (!path && cached) return cached;
  const p = path ?? join(dirname(fileURLToPath(import.meta.url)), "directives.json");
  const c = JSON.parse(readFileSync(p, "utf8")) as Catalog;
  if (!path) cached = c;
  return c;
}

function lookupInPages(catalog: Catalog, pages: string[], section: string | null, name: string): DirectiveInfo | null {
  for (const pageName of pages) {
    const page = catalog.pages[pageName];
    if (!page) continue;
    if (section && page.kind === "directive" && !page.applies_to) {
      // A page with bracketed or single sections: the section must match.
      const s = page.sections[section];
      if (s && name in s) return { page: pageName, section, since: s[name] ?? null };
      continue;
    }
    // Shared pages (exec, kill, resource-control) group directives by topic; any group counts.
    for (const [sec, entries] of Object.entries(page.sections)) {
      if (name in entries) return { page: pageName, section: sec, since: entries[name] ?? null };
    }
  }
  return null;
}

/** Whether `name` (with its trailing "=") is documented for `section` of a file of `type`. */
export function directive(type: FileType, section: string, name: string, catalog: Catalog = loadCatalog()): DirectiveInfo | null {
  section = SECTION_ALIASES[type]?.[section] ?? section;
  const sources = SECTION_SOURCES[type];
  const pages = sources[section] ?? sources["*"];
  if (!pages) return null;
  const found = lookupInPages(catalog, pages, section, name);
  const alias = COMPAT_ALIASES[type]?.[section]?.[name];
  if (!found && alias) return directive(alias[0], alias[1], name, catalog);
  // systemd.netdev documents [Tap] as taking the same keys as [Tun].
  if (!found && type === "netdev" && section === "Tap") return lookupInPages(catalog, pages, "Tun", name);
  return found;
}

/** Whether a tool documents an option (`--mstack=`) or a verb (`pull-oci`). */
export function toolOption(tool: string, name: string, catalog: Catalog = loadCatalog()): DirectiveInfo | null {
  const page = catalog.pages[tool];
  if (!page) return null;
  for (const [sec, entries] of Object.entries(page.sections)) {
    if (name in entries) return { page: tool, section: sec, since: entries[name] ?? null };
  }
  return null;
}

export interface UnknownDirective {
  line: number;
  section: string;
  name: string;
}

export interface UnitCheck {
  type: FileType;
  /** Directives the catalogue does not document for their section. */
  unknown: UnknownDirective[];
  /** Sections the checker skipped: X- prefixed, or Podman's quadlet sections. */
  skipped_sections: string[];
  /** The highest "added in version" among the directives found, or null when none is versioned. */
  minimum_version: number | null;
  /** Every directive that resolved, for reports. */
  resolved: Array<UnknownDirective & DirectiveInfo>;
}

/**
 * Parse a unit-style file and check every directive against the catalogue.
 * Sections and keys beginning with "X-" are ignored, as systemd ignores them.
 */
export function checkUnitText(text: string, type: FileType, catalog: Catalog = loadCatalog()): UnitCheck {
  const result: UnitCheck = { type, unknown: [], skipped_sections: [], minimum_version: null, resolved: [] };
  let section: string | null = null;
  let skip = false;
  let continued = "";
  let startLine = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (continued) {
      line = continued + line;
      continued = "";
    } else {
      startLine = i + 1;
    }
    if (line.endsWith("\\")) {
      continued = line.slice(0, -1) + " ";
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const sec = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sec) {
      section = sec[1]!;
      skip = section.startsWith("X-") || (type === "quadlet" && QUADLET_SECTIONS.has(section));
      if (skip && !result.skipped_sections.includes(section)) result.skipped_sections.push(section);
      continue;
    }
    if (!section || skip) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key.startsWith("X-")) continue;
    const name = `${key}=`;
    const info = directive(type, section, name, catalog);
    if (!info) {
      result.unknown.push({ line: startLine, section, name });
      continue;
    }
    result.resolved.push({ line: startLine, section, name, page: info.page, since: info.since });
    if (info.since !== null && (result.minimum_version === null || info.since > result.minimum_version)) result.minimum_version = info.since;
  }
  return result;
}
