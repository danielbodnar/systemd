// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Helpers every renderer uses to write unit-style files: an INI builder that
// keeps section order, value quoting per systemd.syntax(7), the path
// escaping of systemd.unit(5), and the conversions from inventory values to
// directive values.

/** Quote a value for a space-separated directive (ExecStart=, Environment=): systemd.syntax(7) rules. */
export function quote(value: string): string {
  if (value === "") return '""';
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The order sections are written in; unknown sections follow, and X- sections come last. */
export const SECTION_ORDER = [
  "Unit",
  "Service",
  "Socket",
  "Timer",
  "Path",
  "Mount",
  "Automount",
  "Swap",
  "Slice",
  "Scope",
  "Install",
  "Match",
  "NetDev",
  "Link",
  "Network",
  "Address",
  "Route",
  "DHCPServer",
  "DHCPServerStaticLease",
  "Bridge",
  "VXLAN",
  "WireGuard",
  "WireGuardPeer",
  "MACVLAN",
  "IPVLAN",
  "Exec",
  "Files",
  "Partition",
];

/** A unit-style file under construction: header comments, then sections in a fixed order. */
export class UnitFile {
  private sections = new Map<string, string[]>();
  constructor(private header: string[] = []) {}

  /** Append `key=value`; null, undefined, and the empty string are skipped so callers can pass optional values. */
  add(section: string, key: string, value: string | number | boolean | null | undefined): this {
    if (value === null || value === undefined || value === "") return this;
    const list = this.sections.get(section) ?? [];
    list.push(`${key}=${typeof value === "boolean" ? (value ? "yes" : "no") : String(value)}`);
    this.sections.set(section, list);
    return this;
  }

  /** One `key=` line per value. */
  addAll(section: string, key: string, values: Iterable<string | number>): this {
    for (const v of values) this.add(section, key, v);
    return this;
  }

  /** Append `key=` with no value, which resets a list setting such as CapabilityBoundingSet= to empty. */
  addEmpty(section: string, key: string): this {
    const list = this.sections.get(section) ?? [];
    list.push(`${key}=`);
    this.sections.set(section, list);
    return this;
  }

  has(section: string): boolean {
    return (this.sections.get(section)?.length ?? 0) > 0;
  }

  render(order: string[] = SECTION_ORDER): string {
    const out = this.header.map((l) => (l ? `# ${l}` : "#"));
    const known = order.filter((s) => this.has(s));
    const rest = [...this.sections.keys()].filter((s) => !order.includes(s));
    const plain = rest.filter((s) => !s.startsWith("X-"));
    const extension = rest.filter((s) => s.startsWith("X-"));
    for (const s of [...known, ...plain, ...extension]) {
      out.push("", `[${s}]`, ...this.sections.get(s)!);
    }
    return out.join("\n") + "\n";
  }
}

/** Quote a value for a POSIX shell script so it is inert whatever it contains. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Whether a value can be embedded in a rendered script or unit name without quoting surprises. */
export function isPlainName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/** Whether an installation directory is an absolute path made of plain characters. */
export function isPlainPath(value: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("/..") && !value.includes("//");
}

/** Escape a path the way systemd-escape --path does, for mount unit names. */
export function escapeUnitPath(path: string): string {
  let p = path.replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return "-";
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "/") out += "-";
    else if (/[A-Za-z0-9:_]/.test(ch) || (ch === "." && i > 0)) out += ch;
    else out += "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  }
  return out;
}

/** A Swarm nano-CPU limit as a CPUQuota= percentage. */
export function cpuQuota(nanoCpus: number | null | undefined): string | null {
  if (!nanoCpus) return null;
  return `${Math.round(nanoCpus / 10_000_000)}%`;
}

/** A byte count as the suffixed form systemd accepts, exact where possible. */
export function bytes(n: number | null | undefined): string | null {
  if (!n) return null;
  const units: Array<[number, string]> = [
    [1024 ** 4, "T"],
    [1024 ** 3, "G"],
    [1024 ** 2, "M"],
    [1024, "K"],
  ];
  for (const [size, suffix] of units) if (n % size === 0) return `${n / size}${suffix}`;
  return String(n);
}

/** A file mode as the four-digit octal string tmpfiles.d and BindPaths= consumers expect. */
export function octal(mode: number): string {
  return "0" + mode.toString(8).padStart(3, "0");
}

/**
 * The owner and mode of a file the inventory describes, checked before they
 * reach a shell manifest: uid and gid must be plain decimal, the mode must fit
 * in the twelve permission bits. Anything else is a malformed capture, and the
 * renderer refuses it rather than interpolating it into install.sh.
 */
export function fileOwnership(ref: { uid: string; gid: string; mode: number }, what: string): { uid: string; gid: string; mode: string } {
  const id = /^[0-9]{1,10}$/;
  if (!id.test(ref.uid)) throw new Error(`${what}: uid ${JSON.stringify(ref.uid)} is not a numeric id`);
  if (!id.test(ref.gid)) throw new Error(`${what}: gid ${JSON.stringify(ref.gid)} is not a numeric id`);
  if (!Number.isInteger(ref.mode) || ref.mode < 0 || ref.mode > 0o7777) throw new Error(`${what}: mode ${JSON.stringify(ref.mode)} is not a file mode`);
  return { uid: ref.uid, gid: ref.gid, mode: octal(ref.mode) };
}

/** The shell command a Docker healthcheck runs, or null for NONE. */
export function healthCommand(test: string[]): string | null {
  if (test.length === 0) return null;
  const [kind, ...rest] = test;
  if (kind === "NONE") return null;
  if (kind === "CMD-SHELL") return rest.join(" ");
  if (kind === "CMD") return rest.map(quote).join(" ");
  return test.map(quote).join(" ");
}

export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
  digest: string | null;
}

/** Split a Docker image reference into registry, repository, tag, and digest, applying Docker's defaults. */
export function splitImageRef(ref: string): ImageRef {
  let rest = ref;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = "latest";
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split("/");
  let registry = "docker.io";
  if (parts.length > 1 && (parts[0]!.includes(".") || parts[0]!.includes(":") || parts[0] === "localhost")) registry = parts.shift()!;
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  return { registry, repository: parts.join("/"), tag, digest };
}

/**
 * The local image name for a reference: the last two repository components
 * and the tag, in the characters machine names allow. Two references that
 * differ only in registry collide, which the renderer reports.
 */
export function imageName(ref: string): string {
  const r = splitImageRef(ref);
  const base = r.repository.split("/").slice(-2).join("-");
  return `${base}_${r.tag}`.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Prefix a docker stack and service name so the two cannot collide across stacks. */
export function unitBaseName(serviceName: string, instance: number, total: number): string {
  return total > 1 ? `${serviceName}-${instance}` : serviceName;
}
