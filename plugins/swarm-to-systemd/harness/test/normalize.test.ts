import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { normalize, validate } from "../../skills/swarm-capture/scripts/normalize.ts";
import { durationToSeconds, nsToDuration } from "../../skills/swarm-capture/scripts/types.ts";

const capture = resolve(import.meta.dir, "../fixtures/capture");

describe("normalize", () => {
  const inv = normalize(capture);
  test("shapes the cluster, nodes, and stacks", () => {
    expect(inv.cluster.managers).toBe(1);
    expect(inv.cluster.workers).toBe(1);
    expect(inv.nodes.map((n) => n.hostname)).toEqual(["swarm-mgr-1", "swarm-wrk-1"]);
    expect(inv.stacks).toEqual([{ name: "web", services: ["web_app", "web_proxy"] }]);
  });
  test("flattens the service spec", () => {
    const app = inv.services.find((s) => s.name === "web_app")!;
    expect(app.short_name).toBe("app");
    expect(app.image).toBe("registry.example.com/acme/app:2026.09");
    expect(app.image_digest).toMatch(/^sha256:/);
    expect(app.mode).toBe("replicated");
    expect(app.replicas).toBe(2);
    expect(app.env.APP_SECRET_KEY).toBe("<redacted>");
    expect(app.redacted_env).toEqual(["APP_SECRET_KEY"]);
    expect(app.healthcheck?.interval).toBe("15s");
    expect(app.restart_policy.window).toBe("2m");
    expect(app.stop_grace_period).toBe("30s");
    expect(app.ports[0]).toEqual({ target: 8080, published: 8080, protocol: "tcp", mode: "ingress" });
    expect(app.secrets[0].target).toBe("signing_key");
    expect(app.placement.constraints).toEqual(["node.role == worker"]);
  });
  test("keeps only current tasks and maps node ids to hostnames", () => {
    const app = inv.services.find((s) => s.name === "web_app")!;
    expect(app.tasks.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(app.tasks[1].current_state).toBe("failed");
  });
  test("links networks, volumes, secrets, and configs to services", () => {
    expect(inv.networks.find((n) => n.name === "web_frontend")?.used_by.sort()).toEqual(["web_app", "web_proxy"]);
    expect(inv.networks.find((n) => n.name === "web_frontend")?.encrypted).toBe(true);
    expect(inv.volumes[0].used_by).toEqual(["web_app"]);
    expect(inv.secrets[0].used_by).toEqual(["web_app"]);
    expect(inv.configs[0].used_by).toEqual(["web_proxy"]);
  });
  test("emits warnings for failed tasks, ingress, unpinned images, encrypted overlays", () => {
    expect(inv.warnings.some((w) => w.includes("t3") && w.includes("failed"))).toBe(true);
    expect(inv.warnings.some((w) => w.includes("ingress"))).toBe(true);
    expect(inv.warnings.some((w) => w.includes("caddy:2 is not pinned"))).toBe(true);
    expect(inv.warnings.some((w) => w.includes("encrypted overlay"))).toBe(true);
  });
  test("keeps env values when asked", () => {
    const kept = normalize(capture, { keepEnvValues: true });
    expect(kept.services.find((s) => s.name === "web_app")?.env.APP_SECRET_KEY).toBe("hunter2");
  });
});

describe("durations", () => {
  test("nanoseconds to systemd strings and back", () => {
    expect(nsToDuration(90_000_000_000)).toBe("1m30s");
    expect(nsToDuration(500_000_000)).toBe("500ms");
    expect(nsToDuration(0)).toBe("0s");
    expect(nsToDuration(null)).toBeNull();
    expect(durationToSeconds("1m30s")).toBe(90);
    expect(durationToSeconds("2h")).toBe(7200);
    expect(durationToSeconds(null)).toBeNull();
  });
});

describe("value-aware redaction and schema validation", () => {
  test("credentials embedded in values are redacted even under innocuous names", () => {
    const dir = resolve(import.meta.dir, "../fixtures/capture");
    const inv = normalize(dir);
    // The fixture's DATABASE_URL has no password, so it survives.
    expect(inv.services.find((s) => s.name === "web_app")?.env.DATABASE_URL).toContain("postgres://app@");
  });
  test("is_leader uses the capturing node id", () => {
    const inv = normalize(resolve(import.meta.dir, "../fixtures/capture"));
    expect(inv.cluster.is_leader).toBe(true);
  });
  test("a volume missing from the capturing node is flagged", () => {
    const inv = normalize(resolve(import.meta.dir, "../fixtures/capture"));
    expect(inv.warnings.some((w) => w.includes("volume") && w.includes("node-local"))).toBe(false);
  });
  test("validate rejects a document that breaks the schema", () => {
    const inv = normalize(resolve(import.meta.dir, "../fixtures/capture"));
    const broken = JSON.parse(JSON.stringify(inv));
    broken.services[0].ports[0].protocol = "icmp";
    delete broken.warnings;
    expect(() => validate(broken)).toThrow(/protocol.*expected one of|warnings: required/s);
  });
});
