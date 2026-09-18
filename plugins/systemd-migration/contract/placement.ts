// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Host placement shared by every renderer: which hosts run a service, and
// how many instances each host gets, derived from Swarm placement
// constraints, platforms, the observed task placement, and an optional host
// map that overrides all of it.

import type { Node, Service, Task } from "./types.ts";

export interface Constraint {
  key: string;
  op: "==" | "!=";
  value: string;
}

export function parseConstraint(raw: string): Constraint | null {
  const m = raw.match(/^\s*([\w.\-/]+)\s*(==|!=)\s*(.+?)\s*$/);
  if (!m) return null;
  return { key: m[1]!, op: m[2] as "==" | "!=", value: m[3]! };
}

const ARCH_ALIASES: Record<string, string> = {
  amd64: "x86_64",
  x86_64: "x86_64",
  arm64: "aarch64",
  aarch64: "aarch64",
  arm: "arm",
  armv7l: "arm",
  "386": "i386",
  i386: "i386",
  ppc64le: "ppc64le",
  s390x: "s390x",
  riscv64: "riscv64",
};

export function normalizeArch(a: string): string {
  return ARCH_ALIASES[a.toLowerCase()] ?? a.toLowerCase();
}

export function nodeMatchesPlatform(node: Node, platforms: string[]): boolean {
  if (platforms.length === 0) return true;
  return platforms.some((p) => {
    const [os, arch] = p.split("/");
    return (!os || os.toLowerCase() === node.os.toLowerCase()) && (!arch || normalizeArch(arch) === normalizeArch(node.arch));
  });
}

/** The value of a node attribute a constraint or a spread preference names, or undefined when the node has none. */
export function nodeValue(node: Node, key: string): string | undefined {
  if (key === "node.id") return node.id;
  if (key === "node.hostname") return node.hostname;
  if (key === "node.role") return node.role;
  if (key === "node.platform.os") return node.os;
  if (key === "node.platform.arch") return node.arch;
  if (key.startsWith("node.labels.")) return node.labels[key.slice("node.labels.".length)];
  if (key.startsWith("engine.labels.")) return node.engine_labels[key.slice("engine.labels.".length)];
  return undefined;
}

export function nodeSatisfies(node: Node, constraints: string[]): boolean {
  for (const raw of constraints) {
    const c = parseConstraint(raw);
    if (!c) return false;
    const v = nodeValue(node, c.key);
    const eq = v !== undefined && v === c.value;
    if (c.op === "==" && !eq) return false;
    if (c.op === "!=" && eq) return false;
  }
  return true;
}

/** A placement preference the source recorded; Swarm documents one kind, spread over a node attribute. */
export interface Preference {
  kind: "spread";
  /** The node attribute the instances spread over: `node.labels.zone`, `engine.labels.region`, `node.role`. */
  descriptor: string;
}

/**
 * Parse one entry of `services[].placement.preferences`. The capture records
 * the API object (`{"Spread":{"SpreadDescriptor":"node.labels.zone"}}`); the
 * CLI spelling (`spread=node.labels.zone`) is accepted too, so a preference
 * that reached the inventory from a compose file still resolves.
 */
export function parsePreference(raw: string): Preference | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
    const descriptor = (obj as { Spread?: { SpreadDescriptor?: unknown } } | null)?.Spread?.SpreadDescriptor;
    return typeof descriptor === "string" && descriptor ? { kind: "spread", descriptor } : null;
  }
  const m = /^spread\s*=\s*(\S+)$/i.exec(text);
  return m ? { kind: "spread", descriptor: m[1]! } : null;
}

/**
 * Order the eligible hosts so that instances handed out in this order spread
 * over each preference's values, as Swarm's scheduler does: the hosts are
 * grouped by the first preference's descriptor and the groups are taken
 * round-robin, each group ordered by the remaining preferences and then by
 * the tie-break. Hosts the descriptor says nothing about form the last group,
 * which is where Swarm puts them too.
 */
export function spreadOrder(nodes: Node[], preferences: Preference[], tieBreak: (a: Node, b: Node) => number): Node[] {
  if (preferences.length === 0) return [...nodes].sort(tieBreak);
  const [first, ...rest] = preferences;
  const groups = new Map<string, Node[]>();
  for (const n of nodes) {
    const key = nodeValue(n, first!.descriptor) ?? "";
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const ordered = keys.map((k) => spreadOrder(groups.get(k)!, rest, tieBreak));
  const out: Node[] = [];
  for (let round = 0; ordered.some((g) => round < g.length); round++) {
    for (const g of ordered) if (round < g.length) out.push(g[round]!);
  }
  return out;
}

export interface PlacementOptions {
  /** Service name to the hosts that run it; a host listed twice gets two instances. */
  hostMap?: Record<string, string[]>;
  /** Render numbered instances on one host when the replica count exceeds the eligible hosts. */
  scaleOut?: boolean;
}

/** Decide which hosts run a service, and how many instances each host gets. Problems go to `notes`. */
export function placeService(svc: Service, nodes: Node[], opts: PlacementOptions, notes: string[]): Map<string, number> {
  const placement = new Map<string, number>();
  const override = opts.hostMap?.[svc.name];
  if (override) {
    for (const h of override) placement.set(h, (placement.get(h) ?? 0) + 1);
    return placement;
  }
  const candidates = nodes.filter(
    (n) => n.availability === "active" && n.state === "ready" && nodeSatisfies(n, svc.placement.constraints) && nodeMatchesPlatform(n, svc.placement.platforms),
  );
  if (candidates.length === 0) {
    notes.push(
      `${svc.name}: no node satisfies constraints ${JSON.stringify(svc.placement.constraints)}${svc.placement.platforms.length ? ` and platforms ${svc.placement.platforms.join(", ")}` : ""}; rendered nowhere, add a host-map entry`,
    );
    return placement;
  }
  if (svc.mode === "global" || svc.mode === "global-job") {
    for (const n of candidates) placement.set(n.hostname, 1);
    return placement;
  }
  const wanted = svc.replicas ?? 1;
  // Swarm's MaxReplicas is 0 or absent when the service may run anywhere; a
  // positive value caps the instances one host may carry. Scale-out is the
  // estate's own decision, so without it a host still gets at most one.
  const declaredCap = maxPerHost(svc);
  const perNodeCap = Math.min(declaredCap, opts.scaleOut ? Number.POSITIVE_INFINITY : 1);
  const running = new Set(svc.tasks.filter((t: Task) => t.desired_state === "running").map((t) => t.node));
  const tieBreak = (a: Node, b: Node) => Number(running.has(b.hostname)) - Number(running.has(a.hostname)) || a.hostname.localeCompare(b.hostname);
  const preferences: Preference[] = [];
  for (const raw of svc.placement.preferences) {
    const parsed = parsePreference(raw);
    if (parsed) preferences.push(parsed);
    else notes.push(`${svc.name}: placement preference ${JSON.stringify(raw)} is not a spread preference this renderer understands; it is ignored, set the hosts by hand if the order matters`);
  }
  const ordered = spreadOrder(candidates, preferences, tieBreak);
  if (preferences.length) {
    notes.push(`${svc.name}: instances spread round-robin over ${preferences.map((p) => p.descriptor).join(", then ")} across ${ordered.map((n) => n.hostname).join(", ")}`);
  }
  let remaining = wanted;
  // First pass: one per host in the spread order, preferring hosts already running the service.
  for (const n of ordered) {
    if (remaining <= 0) break;
    placement.set(n.hostname, 1);
    remaining -= 1;
  }
  // Second pass: scale out round-robin within the per-node cap.
  while (remaining > 0 && perNodeCap > 1) {
    let progressed = false;
    for (const n of ordered) {
      if (remaining <= 0) break;
      const cur = placement.get(n.hostname) ?? 0;
      if (cur < perNodeCap) {
        placement.set(n.hostname, cur + 1);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  if (remaining > 0) {
    const capacity = declaredCap * ordered.length;
    const cappedOut = Number.isFinite(capacity) && wanted > capacity;
    notes.push(
      `${svc.name}: wanted ${wanted} replicas but rendered ${wanted - remaining}` +
        (cappedOut
          ? `; max_replicas_per_node ${declaredCap} over ${ordered.length} eligible host(s) places at most ${capacity}, add hosts for the rest`
          : ` (one per eligible host; pass --scale-out for numbered instances)`),
    );
  }
  return placement;
}

/** The instances one host may carry, from `max_replicas_per_node`; 0 and absent both mean no cap, as in Swarm. */
export function maxPerHost(svc: Service): number {
  const declared = svc.placement.max_replicas_per_node;
  return declared !== null && declared > 0 ? declared : Number.POSITIVE_INFINITY;
}
