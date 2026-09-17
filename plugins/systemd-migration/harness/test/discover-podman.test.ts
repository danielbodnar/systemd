// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The Podman adapter: a capture of one pod with two containers, a network,
// a volume, and a secret normalizes into an inventory that validates
// against the shared schema, maps the container spec field by field, and
// feeds the same pipeline as a Swarm inventory.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composeRender, formId } from "../../contract/compose.ts";
import { resolveDecision } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import { validateSchema } from "../../contract/schema.ts";
import { normalize, validate } from "../../skills/discover-podman/scripts/normalize.ts";
import { planFor, render } from "../../skills/systemd-service/scripts/render.ts";

const fixture = resolve(import.meta.dir, "../fixtures/podman-capture");
const schema = JSON.parse(readFileSync(resolve(import.meta.dir, "../../contract/inventory-schema.json"), "utf8"));
const inv = normalize(fixture);
const web = inv.services.find((s) => s.name === "shop-web")!;
const db = inv.services.find((s) => s.name === "shop-db")!;

describe("podman normalize", () => {
  test("validates against the inventory schema and carries no secret value", () => {
    expect(validateSchema(inv, schema)).toEqual([]);
    expect(JSON.stringify(inv)).not.toContain("fixture-placeholder-not-a-secret");
    const broken = JSON.parse(JSON.stringify(inv));
    broken.services[0].mode = "swarm";
    expect(() => validate(broken)).toThrow(/mode/);
  });

  test("the host is the single manager node and the cluster is the host", () => {
    expect(inv.cluster).toEqual({ id: "podman:podman-host-1", engine_version: "5.4.1", managers: 1, workers: 0, is_leader: true });
    expect(inv.nodes).toHaveLength(1);
    expect(inv.nodes[0]).toMatchObject({ hostname: "podman-host-1", role: "manager", leader: true, availability: "active", state: "ready", arch: "amd64", nano_cpus: 4_000_000_000, memory_bytes: 8589934592, engine_version: "5.4.1" });
    expect(inv.nodes[0]!.engine_labels).toMatchObject({ "podman.rootless": "false", "podman.cgroup_version": "v2" });
    expect(inv.captured_on).toBe("podman-host-1");
  });

  test("pods become stacks and infra containers are skipped", () => {
    expect(inv.stacks).toEqual([{ name: "shop", services: ["shop-db", "shop-web"] }]);
    expect(inv.services.map((s) => s.name)).toEqual(["shop-db", "shop-web"]);
    expect(web.stack).toBe("shop");
    expect(web.short_name).toBe("web");
    expect(web.mode).toBe("replicated");
    expect(web.replicas).toBe(1);
    expect(web.tasks).toEqual([{ id: web.id, node: "podman-host-1", desired_state: "running", current_state: "running", error: "" }]);
  });

  test("maps the container spec: image, command, environment, ports, mounts, healthcheck, restart, resources", () => {
    expect(web.image).toBe("registry.example.com/acme/shop:2026.09");
    expect(web.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The entrypoint equals the image's, so only the changed command is recorded.
    expect(web.command).toEqual([]);
    expect(web.args).toEqual(["serve", "--port", "8080"]);
    expect(db.command).toEqual([]);
    expect(db.args).toEqual([]);
    // Podman's injected variables and the image's own are dropped; the secret-looking one is redacted.
    expect(web.env).toEqual({ SHOP_DB_URL: "postgres://shop@shop-db:5432/shop", SHOP_SESSION_SECRET: "<redacted>", LOG_LEVEL: "info" });
    expect(web.redacted_env).toEqual(["SHOP_SESSION_SECRET"]);
    expect(db.env.POSTGRES_PASSWORD_FILE).toBe("/run/secrets/db_password");
    expect(db.env.PG_MAJOR).toBeUndefined();
    expect(web.labels).toEqual({ PODMAN_SYSTEMD_UNIT: "shop-web.service", "io.podman.compose.project": "shop" });
    expect(web.container_labels).toEqual({ "app.tier": "web" });
    expect(web.ports).toEqual([{ target: 8080, published: 8080, protocol: "tcp", mode: "host" }]);
    expect(db.ports).toEqual([]);
    expect(web.mounts).toEqual([
      { type: "bind", source: "/srv/shop/static", target: "/srv/shop/static", readonly: true },
      { type: "tmpfs", source: null, target: "/tmp", readonly: false, tmpfs_size_bytes: 67108864, tmpfs_mode: 0o1777 },
    ]);
    expect(db.mounts).toEqual([{ type: "volume", source: "shop_pgdata", target: "/var/lib/postgresql/data", readonly: false }]);
    expect(web.healthcheck).toEqual({ test: ["CMD-SHELL", "curl -fsS http://localhost:8080/healthz || exit 1"], interval: "15s", timeout: "5s", retries: 3, start_period: "20s" });
    expect(web.restart_policy).toEqual({ condition: "on-failure", delay: null, max_attempts: 5, window: null });
    expect(db.restart_policy.condition).toBe("any");
    expect(web.resources).toEqual({ limits: { nano_cpus: 1_500_000_000, memory_bytes: 536870912, pids: 512 }, reservations: { nano_cpus: null, memory_bytes: 134217728, pids: null } });
    expect(web).toMatchObject({ user: "1000:1000", workdir: "/srv/shop", hostname: "shop", stop_grace_period: "30s", stop_signal: "SIGTERM", read_only: true, init: true, tty: false, privileged: false, endpoint_mode: "dnsrr" });
    expect(web.extra_hosts).toEqual(["legacy.internal:10.0.9.9"]);
    expect(web.cap_drop).toEqual(["CAP_NET_RAW"]);
    expect(web.sysctls).toEqual({ "net.core.somaxconn": "1024" });
    expect(web.ulimits).toEqual([{ name: "nofile", soft: 65536, hard: 65536 }]);
    expect(web.logging).toEqual({ driver: "journald", options: {} });
    expect(db.stop_signal).toBe("SIGINT");
    expect(db.user).toBeNull();
  });

  test("links networks, volumes, and secrets to the containers, taking the pod's network from its infra container", () => {
    expect(web.networks).toEqual([{ name: "shop_net", aliases: ["shop", "web"] }]);
    expect(inv.networks).toHaveLength(1);
    expect(inv.networks[0]).toMatchObject({ name: "shop_net", driver: "bridge", scope: "local", ingress: false, internal: false, ipv6: false, stack: "shop", used_by: ["shop-db", "shop-web"] });
    expect(inv.networks[0]!.ipam).toEqual({ driver: "host-local", config: [{ subnet: "10.89.0.0/24", gateway: "10.89.0.1" }] });
    expect(inv.volumes).toEqual([{ name: "shop_pgdata", driver: "local", scope: "local", mountpoint: "/var/lib/containers/storage/volumes/shop_pgdata/_data", options: {}, labels: { "io.podman.compose.project": "shop" }, stack: "shop", used_by: ["shop-db"] }]);
    // Secrets are recovered from the recorded create command; names only.
    expect(db.secrets).toEqual([{ name: "shop_db_password", id: "0fa1b2c3d4e5f6a7b8c9d0e1f", target: "db_password", uid: "999", gid: "999", mode: 0o400 }]);
    expect(inv.secrets).toEqual([{ id: "0fa1b2c3d4e5f6a7b8c9d0e1f", name: "shop_db_password", labels: { "podman.secret.driver": "file" }, created_at: "2026-09-01T11:58:00Z", stack: null, used_by: ["shop-db"] }]);
    expect(inv.configs).toEqual([]);
    expect(inv.images!.map((i) => [i.ref, i.used_by])).toEqual([
      ["docker.io/library/postgres:16", ["shop-db"]],
      ["registry.example.com/acme/shop:2026.09", ["shop-web"]],
    ]);
  });

  test("warns about what it does not map", () => {
    expect(inv.warnings.some((w) => w.includes("pod shop") && w.includes("ipc"))).toBe(true);
    expect(inv.warnings.some((w) => w.includes("shop-web: already run by systemd unit shop-web.service"))).toBe(true);
    expect(inv.warnings.some((w) => w.includes("existing Quadlet files") && w.includes("/etc/containers/systemd/shop-db.container"))).toBe(true);
    expect(inv.warnings.some((w) => w.includes("not pinned"))).toBe(false);
  });

  test("keeps env values when asked, like the Docker adapter", () => {
    expect(normalize(fixture, { keepEnvValues: true }).services.find((s) => s.name === "shop-web")!.env.SHOP_SESSION_SECRET).toBe("fixture-placeholder-not-a-secret");
  });
});

describe("a podman inventory feeds the pipeline", () => {
  test("the one-call renderer produces native services and a stack target for the pod", () => {
    const r = render(inv);
    expect(Object.keys(r.hosts)).toEqual(["podman-host-1"]);
    const unit = r.files["hosts/podman-host-1/etc/systemd/system/shop-web.service"] as string;
    expect(unit).toContain("ExecStart=/usr/bin/shop serve --port 8080");
    expect(unit).toContain("User=1000");
    expect(r.files["hosts/podman-host-1/etc/systemd/system/shop-db.service"]).toContain("ExecStart=docker-entrypoint.sh postgres");
    expect(r.files["hosts/podman-host-1/etc/systemd/system/shop.target"]).toContain("Wants=shop-db.service");
    expect(r.hosts["podman-host-1"]!.ports).toEqual([{ port: 8080, protocol: "tcp" }]);
    expect(r.files["hosts/podman-host-1/secrets/import-credentials.sh"]).toContain("shop_db_password");
  });

  test("the quadlet form renders the same containers as Quadlet files", () => {
    const plan = planFor(inv);
    resolveDecision(plan, formId("shop-db"), "quadlet");
    const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
    const c = r.files["hosts/podman-host-1/etc/containers/systemd/shop-db.container"] as string;
    expect(c).toContain("Image=docker.io/library/postgres:16@sha256:");
    expect(c).toContain("Secret=shop_db_password,type=mount,target=db_password,uid=999,gid=999,mode=0400");
    expect(c).toContain("Volume=shop_pgdata.volume:/var/lib/postgresql/data");
    expect(r.files["hosts/podman-host-1/etc/containers/systemd/shop_pgdata.volume"]).toContain("VolumeName=shop_pgdata");
    expect(r.files["hosts/podman-host-1/etc/systemd/system/shop-db.service"]).toBeUndefined();
    expect(r.files["hosts/podman-host-1/etc/systemd/system/shop.target"]).toContain("Wants=shop-db.service");
  });
});
