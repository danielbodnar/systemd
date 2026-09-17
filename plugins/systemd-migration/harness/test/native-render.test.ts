// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The native service renderer: every unit it writes must use only documented
// directives, and the fixture estate must come out with the shapes the
// directive map promises.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkUnitText, fileTypeOf } from "../../contract/catalog.ts";
import type { Inventory, Service } from "../../contract/types.ts";
import { escapeUnitPath, imageName, splitImageRef } from "../../contract/unit.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { capabilitySet, commandLine, render } from "../../skills/systemd-service/scripts/render.ts";

const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const inv: Inventory = normalize(capture);
const result = render(inv);
const file = (host: string, rel: string) => result.files[`hosts/${host}/${rel}`] as string | undefined;
const unit = (host: string, name: string) => file(host, `etc/systemd/system/${name}`)!;

describe("contract helpers", () => {
  test("image names are derived from the reference", () => {
    expect(imageName("registry.example.com/acme/app:2026.09")).toBe("acme-app_2026.09");
    expect(imageName("docker.io/library/caddy:2")).toBe("library-caddy_2");
    expect(imageName("nginx")).toBe("library-nginx_latest");
    expect(imageName("quay.io/prometheuscommunity/postgres-exporter:v0.15.0")).toBe("prometheuscommunity-postgres-exporter_v0.15.0");
    expect(splitImageRef("localhost:5000/team/app@sha256:abc")).toEqual({ registry: "localhost:5000", repository: "team/app", tag: "latest", digest: "sha256:abc" });
  });

  test("mount unit names escape paths like systemd-escape --path", () => {
    expect(escapeUnitPath("/var/lib/data/data_backups")).toBe("var-lib-data-data_backups");
    expect(escapeUnitPath("/srv/my-share")).toBe("srv-my\\x2dshare");
    expect(escapeUnitPath("/")).toBe("-");
  });
});

describe("native service renderer on the fixture estate", () => {
  test("renders every host with its stacks", () => {
    expect(Object.keys(result.hosts).sort()).toEqual(["swarm-mgr-1", "swarm-wrk-1"]);
    expect(result.hosts["swarm-wrk-1"]!.targets.sort()).toEqual(["data.target", "web.target"]);
    expect(result.hosts["swarm-mgr-1"]!.units).toEqual(["web_proxy.service"]);
  });

  test("every rendered unit uses only directives the tree documents", () => {
    const unknown: string[] = [];
    let checked = 0;
    for (const [path, content] of Object.entries(result.files)) {
      const type = fileTypeOf(path);
      if (!type) continue;
      checked++;
      const r = checkUnitText(content as string, type);
      for (const u of r.unknown) unknown.push(`${path}:${u.line} [${u.section}] ${u.name}`);
      expect(r.skipped_sections.filter((s) => !s.startsWith("X-"))).toEqual([]);
    }
    expect(unknown).toEqual([]);
    expect(checked).toBeGreaterThan(15);
  });

  test("the service needs systemd 260 for RootMStack= and records its origin", () => {
    const app = unit("swarm-wrk-1", "web_app.service");
    const r = checkUnitText(app, "service");
    expect(r.minimum_version).toBe(260);
    expect(app).toContain("RootMStack=/var/lib/machines/acme-app_2026.09.mstack");
    expect(app).toContain("[X-Migration]");
    expect(app).toContain("ImageDigest=sha256:0000000000000000000000000000000000000000000000000000000000000002");
  });

  test("takes the entrypoint from the image configuration and the args from the service", () => {
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("ExecStart=/usr/bin/app serve --port 8080");
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("WorkingDirectory=/srv/app");
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("User=1000\nGroup=1000");
    // caddy: no entrypoint, a bare command resolved through the image PATH
    const proxy = unit("swarm-mgr-1", "web_proxy.service");
    expect(proxy).toContain("ExecStart=caddy run --config /etc/caddy/Caddyfile --adapter caddyfile");
    expect(proxy).toContain("ExecSearchPath=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(proxy).toContain("DynamicUser=yes");
    expect(proxy).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE\nNoNewPrivileges=yes");
    // postgres: image unknown, placeholder plus a note
    expect(unit("swarm-wrk-1", "data_postgres.service")).toContain("ExecStart=/bin/false");
    expect(result.notes.some((n) => n.startsWith("data_postgres:") && n.includes("placeholder"))).toBe(true);
  });

  test("secrets become encrypted credentials bound where the container saw them", () => {
    const app = unit("swarm-wrk-1", "web_app.service");
    expect(app).toContain("LoadCredentialEncrypted=web_app_signing_key:/etc/credstore.encrypted/web_app_signing_key");
    expect(app).toContain("BindReadOnlyPaths=%d/web_app_signing_key:/run/secrets/signing_key");
    expect(app).toContain("Environment=APP_SECRET_KEY_FILE=%d/web_app-app-secret-key");
    expect(app).not.toContain("fixture-placeholder-not-a-secret");
    const script = file("swarm-wrk-1", "secrets/import-credentials.sh")!;
    expect(script).toContain("systemd-creds encrypt");
    expect(script).toContain("web_app_signing_key");
    expect(script).toContain("data_postgres_password");
    expect(result.hosts["swarm-wrk-1"]!.credentials).toContain("web_app-app-secret-key");
  });

  test("a *_FILE variable that points at a secret path is kept, not redacted", () => {
    const pg = unit("swarm-wrk-1", "data_postgres.service");
    expect(pg).toContain("Environment=POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password");
    expect(pg).toContain("BindReadOnlyPaths=%d/data_postgres_password:/run/secrets/postgres_password");
  });

  test("volumes become tmpfiles directories or mount units", () => {
    expect(file("swarm-wrk-1", "etc/tmpfiles.d/web.conf")).toContain("d /var/lib/web/web_cache 0750 1000 1000 -");
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("BindPaths=/var/lib/web/web_cache:/cache");
    const mount = unit("swarm-wrk-1", "var-lib-data-data_backups.mount");
    expect(mount).toContain("What=10.0.0.50:/exports/backups");
    expect(mount).toContain("Type=nfs");
    expect(mount).toContain("Options=rw,nfsvers=4");
    expect(unit("swarm-wrk-1", "data_postgres.service")).toContain("RequiresMountsFor=/var/lib/data/data_backups");
    expect(unit("swarm-wrk-1", "data.target")).toContain("Wants=var-lib-data-data_backups.mount");
    expect(unit("swarm-wrk-1", "data_postgres.service")).toContain("BindReadOnlyPaths=/etc/localtime:/etc/localtime");
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("TemporaryFileSystem=/tmp:size=67108864");
  });

  test("configs are files with their ownership applied by install.sh", () => {
    expect(file("swarm-mgr-1", "etc/web/configs/web_caddyfile")).toBe(':80 {\n  respond "ok"\n}\n');
    expect(unit("swarm-mgr-1", "web_proxy.service")).toContain("BindReadOnlyPaths=/etc/web/configs/web_caddyfile:/etc/caddy/Caddyfile");
    expect(file("swarm-mgr-1", "install.sh")).toContain("web/configs/web_caddyfile 0 0 0444");
  });

  test("resources, limits, lifecycle, and ports", () => {
    const app = unit("swarm-wrk-1", "web_app.service");
    expect(app).toContain("CPUQuota=150%\nMemoryMax=512M\nMemoryLow=128M\nTasksMax=512");
    expect(app).toContain("LimitNOFILE=65536");
    expect(app).toContain("Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=mixed");
    expect(app).toContain("StartLimitBurst=5\nStartLimitIntervalSec=120");
    expect(app).toContain("SocketBindAllow=tcp:8080\nSocketBindDeny=any");
    expect(app).toContain("CapabilityBoundingSet=\n");
    expect(app).toContain("ProtectSystem=strict");
    expect(app).not.toContain("ProtectKernelTunables");
    expect(file("swarm-wrk-1", "etc/sysctl.d/90-web.conf")).toContain("net.core.somaxconn = 1024");
    const pg = unit("swarm-wrk-1", "data_postgres.service");
    expect(pg).toContain("KillSignal=SIGINT");
    expect(pg).toContain("TimeoutStopSec=60");
  });

  test("healthchecks become a timer, a check service in the same root, and a restart handler", () => {
    const timer = unit("swarm-wrk-1", "web_app-health.timer");
    expect(timer).toContain("OnActiveSec=20\nOnUnitActiveSec=15\nUnit=web_app-health.service");
    const check = unit("swarm-wrk-1", "web_app-health.service");
    expect(check).toContain("RootMStack=/var/lib/machines/acme-app_2026.09.mstack");
    expect(check).toContain("OnFailure=web_app-restart.service");
    expect(check).toContain("if ( curl -fsS http://localhost:8080/healthz || exit 1 ); then exit 0; fi");
    expect(unit("swarm-wrk-1", "web_app-restart.service")).toContain("ExecStart=systemctl restart web_app.service");
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("Wants=web_app-health.timer");
  });

  test("stacks become targets and slices", () => {
    const target = unit("swarm-wrk-1", "web.target");
    expect(target).toContain("Wants=web_app.service");
    expect(target).toContain("WantedBy=multi-user.target");
    expect(unit("swarm-wrk-1", "stack-web.slice")).toContain("MemoryAccounting=yes");
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("Slice=stack-web.slice\n");
    expect(unit("swarm-wrk-1", "web_app.service")).toContain("PartOf=web.target");
  });

  test("images.json lists every image with its hosts", () => {
    expect(Object.keys(result.images).sort()).toEqual(["acme-app_2026.09", "library-caddy_2", "library-postgres_16.4", "prometheuscommunity-postgres-exporter_v0.15.0"]);
    expect(result.images["acme-app_2026.09"]!.hosts).toEqual(["swarm-wrk-1"]);
    expect(result.images["library-caddy_2"]!.hosts.sort()).toEqual(["swarm-mgr-1"]);
    expect(JSON.parse(result.files["images.json"] as string)["acme-app_2026.09"].digest).toMatch(/^sha256:/);
  });

  test("decisions land in the notes", () => {
    const notes = result.files["MIGRATION-NOTES.md"] as string;
    expect(notes).toContain("## Needs a human decision");
    expect(notes).toContain("networkd.publish.web_app.8080-tcp");
    expect(notes).toContain("data_postgres: neither the service nor the inventoried image says what to run");
  });

  test("root-image mode writes RootImage= and needs no mount stack", () => {
    const r = render(inv, { rootImage: true });
    const app = r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app.service"] as string;
    expect(app).toContain("RootImage=/var/lib/machines/acme-app_2026.09.raw");
    expect(app).not.toContain("RootMStack=");
    expect(checkUnitText(app, "service").minimum_version).toBeLessThan(260);
  });

  test("a host map overrides placement", () => {
    const r = render(inv, { hostMap: { web_app: ["swarm-mgr-1", "swarm-wrk-1"] } });
    expect(Object.keys(r.files).filter((f) => f.endsWith("/web_app.service")).sort()).toEqual([
      "hosts/swarm-mgr-1/etc/systemd/system/web_app.service",
      "hosts/swarm-wrk-1/etc/systemd/system/web_app.service",
    ]);
  });
});

describe("service semantics from the source's fields", () => {
  /** The fixture estate with one service's fields changed, rendered on its own. */
  function withService(name: string, patch: (s: Service) => void) {
    const copy = JSON.parse(JSON.stringify(inv)) as Inventory;
    patch(copy.services.find((s) => s.name === name)!);
    const r = render(copy);
    for (const [path, content] of Object.entries(r.files)) {
      const type = fileTypeOf(path);
      if (type) expect(checkUnitText(content as string, type).unknown, path).toEqual([]);
    }
    return r;
  }
  const unitOf = (r: { files: Record<string, unknown> }, host: string, name: string) => r.files[`hosts/${host}/etc/systemd/system/${name}`] as string;

  test("every restart condition maps to its Restart= value", () => {
    for (const [condition, value] of [["none", "no"], ["on-failure", "on-failure"], ["any", "always"]] as const) {
      const r = withService("data_exporter", (s) => {
        s.restart_policy = { condition, delay: null, max_attempts: null, window: null };
      });
      expect(unitOf(r, "swarm-wrk-1", "data_exporter.service")).toContain(`Restart=${value}\n`);
    }
  });

  test("a source that never gives up turns systemd's own start rate limit off", () => {
    const unit = unitOf(withService("data_exporter", (s) => {
      s.restart_policy = { condition: "any", delay: null, max_attempts: null, window: null };
    }), "swarm-wrk-1", "data_exporter.service");
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).not.toContain("StartLimitBurst=");
  });

  test("a capped count with no window becomes StartLimitIntervalSec=infinity, which counts over any interval", () => {
    const unit = unitOf(withService("data_exporter", (s) => {
      s.restart_policy = { condition: "on-failure", delay: null, max_attempts: 3, window: null };
    }), "swarm-wrk-1", "data_exporter.service");
    expect(unit).toContain("StartLimitBurst=3\nStartLimitIntervalSec=infinity");
  });

  test("Restart= and the start limit are left off a service that is never restarted", () => {
    const unit = unitOf(withService("data_exporter", (s) => {
      s.restart_policy = { condition: "none", delay: null, max_attempts: 4, window: "1m" };
    }), "swarm-wrk-1", "data_exporter.service");
    expect(unit).toContain("Restart=no");
    expect(unit).not.toContain("StartLimit");
  });

  test("a sub-second delay and grace period keep their precision", () => {
    const unit = unitOf(withService("data_exporter", (s) => {
      s.restart_policy = { condition: "any", delay: "500ms", max_attempts: null, window: null };
      s.stop_grace_period = "1500ms";
    }), "swarm-wrk-1", "data_exporter.service");
    expect(unit).toContain("RestartSec=500ms");
    expect(unit).toContain("TimeoutStopSec=1500ms");
  });

  test("a zero grace period keeps the source's behaviour and says what it means", () => {
    const r = withService("data_exporter", (s) => { s.stop_grace_period = "0s"; });
    expect(unitOf(r, "swarm-wrk-1", "data_exporter.service")).toContain("TimeoutStopSec=0");
    expect(r.notes.some((n) => n.includes("stop_grace_period was 0"))).toBe(true);
  });

  test("a restart limit that a healthcheck restart also counts against is said so once", () => {
    const r = withService("data_exporter", (s) => {
      s.restart_policy = { condition: "on-failure", delay: null, max_attempts: 2, window: "30s" };
      s.healthcheck = { test: ["CMD", "/bin/true"], interval: "10s", timeout: "5s", retries: 2, start_period: null };
    });
    expect(r.notes.some((n) => n.startsWith("data_exporter: StartLimitBurst=2") && n.includes("data_exporter-restart.service"))).toBe(true);
  });

  test("a stop signal systemd does not accept is noted rather than written into KillSignal=", () => {
    const r = withService("data_exporter", (s) => {
      s.stop_signal = "SIGINT\nExecStartPre=/bin/rm -rf /";
    });
    const unit = unitOf(r, "swarm-wrk-1", "data_exporter.service");
    expect(unit).not.toContain("ExecStartPre");
    expect(unit).not.toContain("KillSignal=");
    expect(r.notes.some((n) => n.includes("is not a signal KillSignal= accepts"))).toBe(true);
    expect(unitOf(withService("data_exporter", (s) => { s.stop_signal = "QUIT"; }), "swarm-wrk-1", "data_exporter.service")).toContain("KillSignal=SIGQUIT");
  });

  test("ulimits become Limit*= with infinity for unlimited, and an undocumented name is a note", () => {
    const r = withService("data_exporter", (s) => {
      s.ulimits = [
        { name: "nproc", soft: 1024, hard: 2048 },
        { name: "RLIMIT_MEMLOCK", soft: -1, hard: -1 },
        { name: "sigpending", soft: 62793, hard: 62793 },
        { name: "nofilehandles", soft: 1, hard: 1 },
      ];
    });
    const unit = unitOf(r, "swarm-wrk-1", "data_exporter.service");
    expect(unit).toContain("LimitNPROC=1024:2048");
    expect(unit).toContain("LimitMEMLOCK=infinity");
    expect(unit).toContain("LimitSIGPENDING=62793");
    expect(unit).not.toContain("LIMITNOFILEHANDLES");
    expect(r.notes.some((n) => n.includes("ulimit nofilehandles") && n.includes("no Limit*= directive"))).toBe(true);
  });

  test("hostname is set in the service's own UTS namespace", () => {
    const r = withService("data_exporter", (s) => { s.hostname = "exporter.internal"; });
    expect(unitOf(r, "swarm-wrk-1", "data_exporter.service")).toContain("ProtectHostname=private:exporter.internal");
    const hostile = withService("data_exporter", (s) => { s.hostname = "x\nExecStopPost=/bin/false"; });
    expect(unitOf(hostile, "swarm-wrk-1", "data_exporter.service")).not.toContain("ProtectHostname=");
    expect(hostile.notes.some((n) => n.includes("is not a host name ProtectHostname= accepts"))).toBe(true);
  });

  test("init says which init the image runs through, or that none was found", () => {
    const withInit = withService("web_proxy", (s) => {
      s.init = true;
      s.command = ["/sbin/tini", "--", "caddy", "run"];
    });
    expect(withInit.notes.some((n) => n.startsWith("web_proxy: init was set and the image already runs through /sbin/tini"))).toBe(true);
    const withoutInit = withService("web_proxy", (s) => { s.init = true; });
    expect(withoutInit.notes.some((n) => n.startsWith("web_proxy: init was set,") && n.includes("reaps the orphans"))).toBe(true);
  });

  test("tty, dns, and extra_hosts say what owns them instead of inventing a directive", () => {
    const r = withService("data_exporter", (s) => {
      s.tty = true;
      s.dns = { nameservers: ["10.0.0.53"], search: ["corp.example"], options: ["ndots:2"] };
      s.extra_hosts = ["10.0.9.9 legacy.internal"];
    });
    const unit = unitOf(r, "swarm-wrk-1", "data_exporter.service");
    expect(unit).not.toContain("TTYPath=");
    expect(r.notes.some((n) => n.includes("tty gave the container a pseudo-terminal") && n.includes("TTYPath="))).toBe(true);
    expect(r.notes.some((n) => n.includes("nameservers 10.0.0.53") && n.includes("the resolved component owns the resolver"))).toBe(true);
    expect(r.notes.some((n) => n.includes("extra_hosts 10.0.9.9 legacy.internal"))).toBe(true);
  });

  test("a job is a oneshot unit with no restart, no start limit, and no health timer", () => {
    const r = withService("web_app", (s) => {
      s.mode = "replicated-job";
      s.replicas = 1;
    });
    const unit = unitOf(r, "swarm-wrk-1", "web_app.service");
    expect(unit).toContain("Type=oneshot\nRemainAfterExit=no");
    expect(unit).not.toContain("Restart=");
    expect(unit).not.toContain("StartLimit");
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app-health.timer"]).toBeUndefined();
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app.timer"]).toBeUndefined();
    expect(r.hosts["swarm-wrk-1"]!.timers).not.toContain("web_app.timer");
    expect(unitOf(r, "swarm-wrk-1", "web.target")).toContain("Wants=web_app.service");
    expect(r.notes.some((n) => n.includes("the healthcheck is not rendered for a replicated-job"))).toBe(true);
    expect(r.notes.some((n) => n.includes("runs once when web.target starts") && n.includes("service.schedule.web_app"))).toBe(true);
    expect(r.notes.some((n) => n.includes("restart_policy on-failure is not rendered for a replicated-job"))).toBe(true);
  });
});

describe("capability and command helpers", () => {
  const svc = inv.services.find((s) => s.name === "web_proxy")!;
  test("cap_add extends Docker's default set", () => {
    const caps = capabilitySet(svc);
    expect(caps.bounding).toContain("CAP_NET_BIND_SERVICE");
    expect(caps.bounding).toContain("CAP_CHOWN");
    expect(caps.ambient).toEqual(["CAP_NET_BIND_SERVICE"]);
  });
  test("cap_drop ALL empties the bounding set", () => {
    const app = inv.services.find((s) => s.name === "web_app")!;
    expect(capabilitySet(app)).toEqual({ bounding: [], ambient: [] });
  });
  test("the service command overrides the image entrypoint", () => {
    const notes: string[] = [];
    const custom = { ...svc, command: ["/bin/custom"], args: ["-x"] };
    expect(commandLine(custom, undefined, notes)).toEqual(["/bin/custom", "-x"]);
    expect(notes).toEqual([]);
  });
});

describe("native install scripts are inert to hostile values", () => {
  test("directories with shell syntax are rejected", () => {
    expect(() => render(inv, { imageDir: "/var/lib/$(id)" })).toThrow(/--image-dir/);
    expect(() => render(inv, { stateDir: "var/lib" })).toThrow(/--state-dir/);
  });
  test("a hostile hostname is rejected", () => {
    const hostile = JSON.parse(JSON.stringify(inv)) as Inventory;
    hostile.nodes[0]!.hostname = "mgr`id`";
    expect(() => render(hostile)).toThrow(/hostname/);
  });
  test("the install script single-quotes every embedded path and name", () => {
    const install = result.files["hosts/swarm-wrk-1/install.sh"]!;
    expect(install).toContain("[ \"$(hostname)\" = 'swarm-wrk-1' ]");
    expect(install).toContain("'/var/lib/machines/acme-app_2026.09.mstack'");
    expect(install).toContain("systemd-analyze verify '/etc/systemd/system/");
    expect(install).toContain("systemctl enable --now 'data.target' 'web.target'");
  });
});
