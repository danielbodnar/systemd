// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Host placement: which hosts run a service and how many instances each one
// gets, from the source's constraints, platforms, spread preferences,
// max_replicas_per_node, and observed task placement. Every case here is
// built from synthetic nodes and services so nothing about an estate is
// assumed; the fixture estate is exercised by compose.test.ts.

import { describe, expect, test } from "bun:test";
import { maxPerHost, nodeMatchesPlatform, nodeSatisfies, nodeValue, normalizeArch, parseConstraint, parsePreference, placeService, spreadOrder } from "../../contract/placement.ts";
import type { Node, Service, ServiceMode } from "../../contract/types.ts";

function node(hostname: string, labels: Record<string, string> = {}, over: Partial<Node> = {}): Node {
  return {
    id: `id-${hostname}`,
    hostname,
    role: "worker",
    leader: false,
    availability: "active",
    state: "ready",
    addr: "",
    labels,
    engine_labels: {},
    engine_version: "",
    os: "linux",
    arch: "x86_64",
    nano_cpus: 0,
    memory_bytes: 0,
    ...over,
  };
}

interface ServiceOver {
  mode?: ServiceMode;
  replicas?: number | null;
  constraints?: string[];
  preferences?: string[];
  maxPerNode?: number | null;
  platforms?: string[];
  running?: string[];
}

function service(name: string, over: ServiceOver = {}): Service {
  return {
    id: `id-${name}`,
    name,
    short_name: name,
    stack: "stack",
    image: "example.com/app:1",
    image_digest: null,
    command: [],
    args: [],
    env: {},
    redacted_env: [],
    labels: {},
    container_labels: {},
    mode: over.mode ?? "replicated",
    replicas: over.replicas === undefined ? 1 : over.replicas,
    placement: {
      constraints: over.constraints ?? [],
      preferences: over.preferences ?? [],
      max_replicas_per_node: over.maxPerNode ?? null,
      platforms: over.platforms ?? [],
    },
    networks: [],
    ports: [],
    mounts: [],
    secrets: [],
    configs: [],
    healthcheck: null,
    resources: { limits: { nano_cpus: null, memory_bytes: null, pids: null }, reservations: { nano_cpus: null, memory_bytes: null, pids: null } },
    restart_policy: { condition: "any", delay: null, max_attempts: null, window: null },
    update_config: null,
    rollback_config: null,
    stop_grace_period: null,
    stop_signal: null,
    user: null,
    workdir: null,
    hostname: null,
    dns: { nameservers: [], search: [], options: [] },
    extra_hosts: [],
    cap_add: [],
    cap_drop: [],
    sysctls: {},
    ulimits: [],
    read_only: false,
    init: false,
    tty: false,
    privileged: false,
    logging: { driver: null, options: {} },
    endpoint_mode: "vip",
    tasks: (over.running ?? []).map((h, i) => ({ id: `task-${i}`, node: h, desired_state: "running", current_state: "running", error: "" })),
  };
}

const spread = (descriptor: string) => JSON.stringify({ Spread: { SpreadDescriptor: descriptor } });
const place = (svc: Service, nodes: Node[], scaleOut = false) => {
  const notes: string[] = [];
  return { placement: Object.fromEntries(placeService(svc, nodes, { scaleOut }, notes)), notes };
};

describe("constraints and platforms", () => {
  test("a constraint parses into key, operator, and value", () => {
    expect(parseConstraint("node.labels.zone == a")).toEqual({ key: "node.labels.zone", op: "==", value: "a" });
    expect(parseConstraint("node.role!=manager")).toEqual({ key: "node.role", op: "!=", value: "manager" });
    expect(parseConstraint("node.labels.zone ~= a")).toBeNull();
  });

  test("node attributes resolve for the keys Swarm names", () => {
    const n = node("h1", { zone: "a" }, { role: "manager", engine_labels: { region: "eu" } });
    expect(nodeValue(n, "node.hostname")).toBe("h1");
    expect(nodeValue(n, "node.role")).toBe("manager");
    expect(nodeValue(n, "node.labels.zone")).toBe("a");
    expect(nodeValue(n, "engine.labels.region")).toBe("eu");
    expect(nodeValue(n, "node.labels.absent")).toBeUndefined();
  });

  test("a node satisfies every constraint or none of them", () => {
    const n = node("h1", { zone: "a" });
    expect(nodeSatisfies(n, ["node.labels.zone == a", "node.role != manager"])).toBe(true);
    expect(nodeSatisfies(n, ["node.labels.zone == b"])).toBe(false);
    expect(nodeSatisfies(n, ["node.labels.absent != x"])).toBe(true);
    expect(nodeSatisfies(n, ["nonsense"])).toBe(false);
  });

  test("platforms match on normalized architecture", () => {
    expect(normalizeArch("amd64")).toBe("x86_64");
    const n = node("h1");
    expect(nodeMatchesPlatform(n, [])).toBe(true);
    expect(nodeMatchesPlatform(n, ["linux/amd64"])).toBe(true);
    expect(nodeMatchesPlatform(n, ["linux/arm64"])).toBe(false);
  });
});

describe("placement preferences", () => {
  test("a preference parses from the API object and from the CLI spelling", () => {
    expect(parsePreference(spread("node.labels.zone"))).toEqual({ kind: "spread", descriptor: "node.labels.zone" });
    expect(parsePreference("spread=engine.labels.region")).toEqual({ kind: "spread", descriptor: "engine.labels.region" });
    expect(parsePreference('{"Unknown":{}}')).toBeNull();
    expect(parsePreference("not json")).toBeNull();
    expect(parsePreference("")).toBeNull();
  });

  test("spreadOrder takes one host from each value of the descriptor in turn", () => {
    const nodes = [node("a1", { zone: "a" }), node("a2", { zone: "a" }), node("b1", { zone: "b" }), node("c1", { zone: "c" })];
    const order = spreadOrder(nodes, [{ kind: "spread", descriptor: "node.labels.zone" }], (x, y) => x.hostname.localeCompare(y.hostname));
    expect(order.map((n) => n.hostname)).toEqual(["a1", "b1", "c1", "a2"]);
  });

  test("hosts the descriptor says nothing about come last", () => {
    const nodes = [node("plain"), node("a1", { zone: "a" }), node("b1", { zone: "b" })];
    const order = spreadOrder(nodes, [{ kind: "spread", descriptor: "node.labels.zone" }], (x, y) => x.hostname.localeCompare(y.hostname));
    expect(order.map((n) => n.hostname)).toEqual(["a1", "b1", "plain"]);
  });

  test("a second preference orders within each group of the first", () => {
    const nodes = [
      node("a-x1", { zone: "a", rack: "x" }),
      node("a-y1", { zone: "a", rack: "y" }),
      node("b-x1", { zone: "b", rack: "x" }),
      node("b-y1", { zone: "b", rack: "y" }),
    ];
    const prefs = [
      { kind: "spread" as const, descriptor: "node.labels.zone" },
      { kind: "spread" as const, descriptor: "node.labels.rack" },
    ];
    expect(spreadOrder(nodes, prefs, (x, y) => x.hostname.localeCompare(y.hostname)).map((n) => n.hostname)).toEqual(["a-x1", "b-x1", "a-y1", "b-y1"]);
  });

  test("replicas spread over the preference's values instead of filling one of them", () => {
    const nodes = [node("a1", { zone: "a" }), node("a2", { zone: "a" }), node("b1", { zone: "b" })];
    const svc = service("web", { replicas: 2, preferences: [spread("node.labels.zone")] });
    const { placement, notes } = place(svc, nodes);
    expect(placement).toEqual({ a1: 1, b1: 1 });
    expect(notes.some((n) => n.includes("spread round-robin over node.labels.zone"))).toBe(true);
  });

  test("a preference this renderer does not understand is noted and ignored", () => {
    const nodes = [node("a1"), node("b1")];
    const { placement, notes } = place(service("web", { replicas: 2, preferences: ['{"Affinity":{}}'] }), nodes);
    expect(placement).toEqual({ a1: 1, b1: 1 });
    expect(notes.some((n) => n.includes("not a spread preference"))).toBe(true);
  });
});

describe("replica counts and the per-host cap", () => {
  test("max_replicas_per_node is unlimited when it is absent or zero", () => {
    expect(maxPerHost(service("web"))).toBe(Number.POSITIVE_INFINITY);
    expect(maxPerHost(service("web", { maxPerNode: 0 }))).toBe(Number.POSITIVE_INFINITY);
    expect(maxPerHost(service("web", { maxPerNode: 3 }))).toBe(3);
  });

  test("scale-out fills hosts round-robin and stops at the cap, noting what is left", () => {
    const nodes = [node("h1"), node("h2")];
    const capped = place(service("web", { replicas: 5, maxPerNode: 2 }), nodes, true);
    expect(capped.placement).toEqual({ h1: 2, h2: 2 });
    expect(capped.notes[0]).toContain("wanted 5 replicas but rendered 4");
    expect(capped.notes[0]).toContain("max_replicas_per_node 2 over 2 eligible host(s) places at most 4");
  });

  test("without a cap scale-out places every replica", () => {
    const { placement, notes } = place(service("web", { replicas: 5 }), [node("h1"), node("h2")], true);
    expect(placement).toEqual({ h1: 3, h2: 2 });
    expect(notes).toEqual([]);
  });

  test("without scale-out a host still gets one instance even when the cap allows more", () => {
    const { placement, notes } = place(service("web", { replicas: 4, maxPerNode: 3 }), [node("h1"), node("h2")]);
    expect(placement).toEqual({ h1: 1, h2: 1 });
    expect(notes[0]).toContain("pass --scale-out");
  });

  test("a cap of one is never exceeded, whatever the scale-out decision says", () => {
    const { placement, notes } = place(service("web", { replicas: 3, maxPerNode: 1 }), [node("h1"), node("h2")], true);
    expect(placement).toEqual({ h1: 1, h2: 1 });
    expect(notes[0]).toContain("max_replicas_per_node 1 over 2 eligible host(s) places at most 2");
  });

  test("hosts already running the service are filled first", () => {
    const { placement } = place(service("web", { replicas: 1, running: ["h2"] }), [node("h1"), node("h2")]);
    expect(placement).toEqual({ h2: 1 });
  });
});

describe("modes and eligibility", () => {
  test("a global service and a global job land on every eligible host", () => {
    const nodes = [node("h1", { db: "true" }), node("h2")];
    for (const mode of ["global", "global-job"] as const) {
      expect(place(service("web", { mode, constraints: ["node.labels.db == true"] }), nodes).placement).toEqual({ h1: 1 });
    }
  });

  test("a replicated job is placed like a replicated service", () => {
    expect(place(service("job", { mode: "replicated-job", replicas: 2 }), [node("h1"), node("h2")]).placement).toEqual({ h1: 1, h2: 1 });
  });

  test("drained, unready, and mismatched hosts are not candidates", () => {
    const nodes = [node("drained", {}, { availability: "drain" }), node("down", {}, { state: "down" }), node("arm", {}, { arch: "aarch64" })];
    const { placement, notes } = place(service("web", { platforms: ["linux/amd64"] }), nodes);
    expect(placement).toEqual({});
    expect(notes[0]).toContain("no node satisfies constraints");
    expect(notes[0]).toContain("add a host-map entry");
  });

  test("an explicit host map wins over every rule, and a host listed twice gets two instances", () => {
    const notes: string[] = [];
    const svc = service("web", { replicas: 1, constraints: ["node.labels.zone == nowhere"] });
    const placement = placeService(svc, [node("h1")], { hostMap: { web: ["h9", "h9", "h8"] } }, notes);
    expect(Object.fromEntries(placement)).toEqual({ h9: 2, h8: 1 });
    expect(notes).toEqual([]);
  });
});
