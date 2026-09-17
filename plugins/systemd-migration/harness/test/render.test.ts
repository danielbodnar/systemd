import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Inventory } from "../../contract/types.ts";
import { addHost, nodeMatchesPlatform, nodeSatisfies, parseConstraint, placeService, render } from "../../skills/podman-quadlet/scripts/render.ts";

const inv = JSON.parse(readFileSync(resolve(import.meta.dir, "../../skills/discover-docker-swarm/references/example-inventory.json"), "utf8")) as Inventory;

describe("placement", () => {
  test("parses constraints", () => {
    expect(parseConstraint("node.labels.db == true")).toEqual({ key: "node.labels.db", op: "==", value: "true" });
    expect(parseConstraint("node.role!=manager")).toEqual({ key: "node.role", op: "!=", value: "manager" });
    expect(parseConstraint("garbage")).toBeNull();
  });
  test("evaluates node constraints", () => {
    const [mgr, wrk] = inv.nodes;
    expect(nodeSatisfies(mgr, ["node.role == manager"])).toBe(true);
    expect(nodeSatisfies(wrk, ["node.role == manager"])).toBe(false);
    expect(nodeSatisfies(wrk, ["node.labels.db == true", "node.hostname != swarm-mgr-1"])).toBe(true);
    expect(nodeSatisfies(wrk, ["node.labels.missing == x"])).toBe(false);
  });
  test("global services land on every eligible host", () => {
    const proxy = inv.services.find((s) => s.name === "web_proxy")!;
    expect([...placeService(proxy, inv.nodes, {}, []).keys()]).toEqual(["swarm-mgr-1"]);
  });
  test("replicated services get one instance per host unless scaled out", () => {
    const app = inv.services.find((s) => s.name === "web_app")!;
    const notes: string[] = [];
    expect([...placeService(app, inv.nodes, {}, notes).entries()]).toEqual([["swarm-wrk-1", 1]]);
    expect(notes[0]).toMatch(/wanted 2 replicas/);
    // max_replicas_per_node is 1 in the fixture, so scale-out still stops at one.
    expect([...placeService({ ...app, placement: { ...app.placement, max_replicas_per_node: null } }, inv.nodes, { scaleOut: true }, []).entries()]).toEqual([["swarm-wrk-1", 2]]);
  });
  test("host map overrides placement", () => {
    const pg = inv.services.find((s) => s.name === "data_postgres")!;
    expect([...placeService(pg, inv.nodes, { hostMap: { data_postgres: ["new-db-1"] } }, []).keys()]).toEqual(["new-db-1"]);
  });
  test("addHost reorders docker's ip-first form", () => {
    expect(addHost("10.0.9.9 legacy.internal")).toBe("legacy.internal:10.0.9.9");
    expect(addHost("legacy.internal:10.0.9.9")).toBe("legacy.internal:10.0.9.9");
  });
});

describe("render", () => {
  const result = render(inv, { outDir: "unused" });
  const unit = (host: string, name: string) => result.files[`hosts/${host}/etc/containers/systemd/${name}`];

  test("produces one container unit per placed service plus networks, volumes, and targets", () => {
    expect(Object.keys(result.hosts).sort()).toEqual(["swarm-mgr-1", "swarm-wrk-1"]);
    expect(result.hosts["swarm-wrk-1"].units.sort()).toEqual(["data_postgres.service", "web_app.service"]);
    expect(unit("swarm-wrk-1", "data_backend.network")).toContain("Internal=true");
    expect(unit("swarm-wrk-1", "data_pgdata.volume")).toContain("VolumeName=data_pgdata");
    expect(result.files["hosts/swarm-wrk-1/etc/systemd/system/data.target"]).toContain("Wants=data_postgres.service");
  });
  test("translates the service spec faithfully", () => {
    const app = unit("swarm-wrk-1", "web_app.container");
    expect(app).toContain("Image=registry.example.com/acme/app:2026.09");
    expect(app).toContain("Exec=serve --port 8080");
    expect(app).toContain("Secret=web_app-app-secret-key,type=env,target=APP_SECRET_KEY");
    expect(app).not.toContain("fixture-placeholder-not-a-secret");
    expect(app).toContain("Secret=web_app_signing_key,type=mount,target=signing_key,uid=1000,gid=1000,mode=0400");
    expect(app).toContain("HealthCmd=curl -fsS http://localhost:8080/healthz || exit 1");
    expect(app).toContain("Notify=healthy");
    expect(app).toContain("CPUQuota=150%");
    expect(app).toContain("MemoryMax=536870912");
    expect(app).toContain("StartLimitBurst=5");
    expect(app).toContain("Restart=on-failure");
    expect(app).toContain("Tmpfs=/tmp:size=67108864");
    expect(app).toContain("DropCapability=all");
    expect(app).toContain("AddHost=legacy.internal:10.0.9.9");
    expect((app as string).match(/NetworkAlias=app/g)?.length).toBe(1);
    expect(app).toContain("WantedBy=multi-user.target web.target");
  });
  test("mounts configs as read-only files and writes their payload", () => {
    expect(unit("swarm-mgr-1", "web_proxy.container")).toContain("Volume=/etc/containers/swarm-configs/web_caddyfile:/etc/caddy/Caddyfile:ro");
    expect(new TextDecoder().decode(result.files["hosts/swarm-mgr-1/etc/containers/swarm-configs/web_caddyfile"] as Uint8Array)).toContain(":80");
  });
  test("pins digests and records host expectations", () => {
    expect(unit("swarm-mgr-1", "web_proxy.container")).toContain("Image=docker.io/library/caddy:2@sha256:");
    expect(result.hosts["swarm-mgr-1"].ports).toEqual([{ port: 80, protocol: "tcp" }, { port: 443, protocol: "tcp" }]);
    expect(result.hosts["swarm-wrk-1"].secrets.sort()).toEqual(["data_pg_password", "web_app-app-secret-key", "web_app_signing_key"]);
  });
  test("secret import script never contains values and lists every secret", () => {
    const script = result.files["hosts/swarm-wrk-1/secrets/import-secrets.sh"];
    expect(script).toContain("'data_pg_password'");
    expect(script).toContain("podman secret create --replace");
    expect(script).not.toContain("fixture-placeholder-not-a-secret");
  });
  test("notes call out the decisions", () => {
    expect(result.notes.some((n) => n.includes("ingress-mode ports"))).toBe(true);
    expect(result.notes.some((n) => n.includes("bind mount /srv/backups"))).toBe(true);
    expect(result.files["MIGRATION-NOTES.md"]).toContain("## Items that need a human decision");
  });
  test("selinux flag relabels bind mounts", () => {
    const r = render(inv, { outDir: "unused", selinux: true });
    expect(r.files["hosts/swarm-wrk-1/etc/containers/systemd/data_postgres.container"]).toContain("Volume=/srv/backups:/backups,Z");
  });
});

describe("review fixes", () => {
  test("platform constraints exclude incompatible nodes with architecture aliases", () => {
    const [mgr] = inv.nodes;
    expect(nodeMatchesPlatform(mgr, ["linux/amd64"])).toBe(true);
    expect(nodeMatchesPlatform(mgr, ["linux/arm64"])).toBe(false);
    expect(nodeMatchesPlatform(mgr, [])).toBe(true);
    const app = inv.services.find((s) => s.name === "web_app")!;
    const notes: string[] = [];
    const placed = placeService({ ...app, placement: { ...app.placement, platforms: ["linux/arm64"] } }, inv.nodes, {}, notes);
    expect(placed.size).toBe(0);
    expect(notes[0]).toMatch(/platforms linux\/arm64/);
  });
  test("explicit zero durations are kept rather than defaulted", () => {
    const app = inv.services.find((s) => s.name === "web_app")!;
    const zero = { ...inv, services: [{ ...app, stop_grace_period: "0s", restart_policy: { ...app.restart_policy, delay: "0s" } }] };
    const unit = render(zero, { outDir: "unused" }).files["hosts/swarm-wrk-1/etc/containers/systemd/web_app.container"] as string;
    expect(unit).toContain("StopTimeout=0");
    expect(unit).toContain("RestartSec=0");
  });
  test("rollback config and dropped service labels are noted", () => {
    const proxy = inv.services.find((s) => s.name === "web_proxy")!;
    const withRollback = { ...inv, services: [{ ...proxy, rollback_config: { parallelism: 2, delay: null, failure_action: "pause", monitor: null, max_failure_ratio: 0, order: "stop-first" } }] };
    const r = render(withRollback, { outDir: "unused" });
    expect(r.notes.some((n) => n.includes("rollback_config (stop-first, parallelism 2"))).toBe(true);
    const app = render(inv, { outDir: "unused" });
    expect(app.notes.some((n) => n.includes("service labels not rendered") && n.includes("traefik.enable"))).toBe(true);
  });
  test("config payloads are written as bytes with an ownership manifest", () => {
    const r = render(inv, { outDir: "unused" });
    const payload = r.files["hosts/swarm-mgr-1/etc/containers/swarm-configs/web_caddyfile"];
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(r.files["hosts/swarm-mgr-1/etc/containers/swarm-configs/.manifest"]).toBe("web_caddyfile 0 0 0444\n");
    const install = r.files["hosts/swarm-mgr-1/install.sh"] as string;
    expect(install).toContain("chown \"$uid:$gid\" '/etc/containers/swarm-configs'/\"$name\"");
    expect(install).toContain("-exec install -m 0644 {} '/etc/containers/swarm-configs'/ \\;");
    expect(install).toMatch(/if ! systemd-analyze verify[\s\S]*exit 1[\s\S]*if \[ "\$start" -eq 1 \]/);
  });
  test("a mount naming an uninventoried volume with driver options gets a synthesized .volume", () => {
    const pg = inv.services.find((s) => s.name === "data_postgres")!;
    const nfs = { ...inv, services: [{ ...pg, mounts: [{ type: "volume" as const, source: "shared_backups", target: "/backups", readonly: false, volume_driver: "local", volume_options: { type: "nfs", device: ":/export/backups", o: "addr=10.0.0.5,rw" } }] }] };
    const r = render(nfs, { outDir: "unused" });
    const vol = r.files["hosts/swarm-wrk-1/etc/containers/systemd/shared_backups.volume"] as string;
    expect(vol).toContain("Type=nfs");
    expect(vol).toContain("Device=:/export/backups");
    expect(r.files["hosts/swarm-wrk-1/etc/containers/systemd/data_postgres.container"]).toContain("Volume=shared_backups.volume:/backups");
  });
  test("secret import reads from the operator directory outside the workspace", () => {
    const script = render(inv, { outDir: "unused" }).files["hosts/swarm-wrk-1/secrets/import-secrets.sh"] as string;
    expect(script).toContain("SWARM_SECRETS_DIR:-/etc/swarm-migration/secrets");
    expect(script).not.toContain("secrets/values");
  });
});

describe("install scripts are inert to hostile values", () => {
  test("directories with shell syntax are rejected before anything is rendered", () => {
    expect(() => render(inv, { outDir: "unused", unitDir: "/etc/$(id)" })).toThrow(/--unit-dir/);
    expect(() => render(inv, { outDir: "unused", configDir: "relative/path" })).toThrow(/--config-dir/);
    expect(() => render(inv, { outDir: "unused", unitDir: "/etc/../x" })).toThrow(/--unit-dir/);
  });
  test("a hostile service name is rejected", () => {
    const hostile = JSON.parse(JSON.stringify(inv)) as typeof inv;
    hostile.services[0]!.name = "web;rm -rf /";
    expect(() => render(hostile, { outDir: "unused" })).toThrow(/service name/);
  });
  test("every value in the script is single-quoted", () => {
    const install = render(inv, { outDir: "unused", unitDir: "/srv/quadlet-units" }).files["hosts/swarm-mgr-1/install.sh"] as string;
    expect(install).toContain("'/srv/quadlet-units'");
    expect(install).not.toMatch(/\$\{unitDir\}|\$\{configDir\}/);
  });
});
