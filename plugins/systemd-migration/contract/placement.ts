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

function nodeValue(node: Node, key: string): string | undefined {
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
  const perNodeCap = svc.placement.max_replicas_per_node ?? (opts.scaleOut ? Number.POSITIVE_INFINITY : 1);
  const running = new Set(svc.tasks.filter((t: Task) => t.desired_state === "running").map((t) => t.node));
  const ordered = [...candidates].sort((a, b) => Number(running.has(b.hostname)) - Number(running.has(a.hostname)) || a.hostname.localeCompare(b.hostname));
  let remaining = wanted;
  // First pass: one per host, preferring hosts already running the service.
  for (const n of ordered) {
    if (remaining <= 0) break;
    placement.set(n.hostname, 1);
    remaining -= 1;
  }
  // Second pass: scale out round-robin within the per-node cap.
  while (remaining > 0 && opts.scaleOut) {
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
    notes.push(`${svc.name}: wanted ${wanted} replicas but rendered ${wanted - remaining} (one per eligible host; pass --scale-out for numbered instances)`);
  }
  return placement;
}
