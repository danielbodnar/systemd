// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The rollout component and its controller: the decisions carry the source's
// own update_config as evidence, the rendered specification says exactly what
// each service is allowed to do, and stackctl turns that specification into a
// sequence of systemctl commands that a --dry-run prints without running.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { composePlan, composeRender } from "../../contract/compose.ts";
import { findDecision, resolveDecision } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { publishId } from "../../skills/systemd-networkd/scripts/shared.ts";
import { render } from "../../skills/systemd-service/scripts/render.ts";
import { CONTROLLER, MONITOR, failureId, longestMonitor, needsRollout, orderId } from "../../skills/systemd-rollout/scripts/component.ts";

const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const inv: Inventory = normalize(capture);
const script = resolve(import.meta.dir, "../../skills/systemd-rollout/scripts/stackctl");

const result = render(inv);
// The same estate with both replicas of web_app on one host, so the
// start-first walk has more than one instance to hold capacity with.
const scaled = render(inv, { scaleOut: true, hostMap: { web_app: ["swarm-wrk-1", "swarm-wrk-1"] } });
const spec = (r: typeof result, host: string, stack: string) => r.files[`hosts/${host}/etc/systemd-migration/rollout/${stack}.conf`] as string;

/** The value of a key in a section of a rendered specification. */
function key(text: string, section: string, name: string): string {
  let inSection = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inSection = t === `[${section}]`;
      continue;
    }
    if (inSection && t.startsWith(`${name}=`)) return t.slice(name.length + 1);
  }
  return "";
}

describe("rollout decisions", () => {
  const { plan } = composePlan(inv, COMPONENTS);

  test("a service with an update_config gets an order and a failure action, defaulted from the source", () => {
    const order = findDecision(plan, orderId("web_app"))!;
    expect(order.component).toBe("rollout");
    expect(order.kind).toBe("choice");
    expect(order.default).toBe("start-first");
    expect(order.options!.map((o) => o.value).sort()).toEqual(["start-first", "stop-first"]);
    expect(order.evidence).toContain("services[web_app].update_config.order=start-first");

    const failure = findDecision(plan, failureId("web_app"))!;
    expect(failure.default).toBe("rollback");
    expect(failure.options!.map((o) => o.value)).toEqual(["pause", "continue", "rollback"]);
    expect(failure.evidence).toContain("services[web_app].update_config.failure_action=rollback");
    expect(failure.evidence).toContain("services[web_app].healthcheck.test");
  });

  test("a service the source described more conservatively keeps its own values", () => {
    expect(findDecision(plan, orderId("data_postgres"))!.default).toBe("stop-first");
    expect(findDecision(plan, failureId("data_postgres"))!.default).toBe("pause");
  });

  test("a service with no update_config, no rollback_config, and one replica raises nothing", () => {
    expect(findDecision(plan, orderId("data_exporter"))).toBeUndefined();
    expect(findDecision(plan, failureId("data_exporter"))).toBeUndefined();
    expect(needsRollout(inv.services.find((s) => s.name === "data_exporter")!, 1)).toBe(false);
    expect(needsRollout(inv.services.find((s) => s.name === "web_app")!, 1)).toBe(true);
  });

  test("the estate's monitor window defaults to the longest the source names", () => {
    const monitor = findDecision(plan, MONITOR)!;
    expect(monitor.kind).toBe("value");
    expect(monitor.subject).toEqual({ kind: "estate", name: "estate" });
    expect(monitor.default).toBe("30s");
    expect(monitor.evidence).toContain("services[web_app].update_config.monitor=30s");
    expect(longestMonitor(inv.services).span).toBe("30s");
    expect(longestMonitor([]).span).toBe("30s");
    expect(longestMonitor([]).from).toBeNull();
  });

  test("every rollout decision has a default, so a render never stalls on one", () => {
    for (const d of plan.decisions.filter((x) => x.component === "rollout")) {
      expect(d.default, d.id).not.toBeNull();
      expect(d.evidence!.length, d.id).toBeGreaterThan(0);
    }
  });
});

describe("the rendered specification", () => {
  test("one file per stack on the host, and the controller beside it", () => {
    expect(spec(result, "swarm-wrk-1", "web")).toBeDefined();
    expect(spec(result, "swarm-wrk-1", "data")).toBeDefined();
    expect(spec(result, "swarm-mgr-1", "web")).toBeDefined();
    expect(result.files["hosts/swarm-mgr-1/etc/systemd-migration/rollout/data.conf"]).toBeUndefined();
    expect(result.files["hosts/swarm-wrk-1/usr/local/lib/systemd-migration/stackctl"]).toBe(readFileSync(script, "utf8"));
  });

  test("install.sh installs the controller by name with mode 0755, because it copies only etc/", () => {
    const install = result.files["hosts/swarm-wrk-1/install.sh"] as string;
    expect(install).toContain(`install -D -m 0755 "$here/usr/local/lib/systemd-migration/stackctl" '${CONTROLLER}'`);
    expect(install).toContain("install -d -m 0755 '/var/lib/systemd-migration/rollout'");
    expect(install).toContain('install -D -m 0700 "$here/secrets/import-credentials.sh"');
    // The rollout files under etc/ ride along with the tree copy.
    expect(install).toContain('cp -a "$here/etc/." /etc/');
  });

  test("the web stack carries the source's update_config and the units the service component rendered", () => {
    const web = spec(scaled, "swarm-wrk-1", "web");
    expect(key(web, "Rollout", "Stack")).toBe("web");
    expect(key(web, "Rollout", "Host")).toBe("swarm-wrk-1");
    expect(key(web, "Rollout", "Monitor")).toBe("30s");
    expect(key(web, "Rollout", "ConfigForm")).toBe("files");
    expect(key(web, "Service web_app", "Units")).toBe("web_app-1.service web_app-2.service");
    expect(key(web, "Service web_app", "Health")).toBe("web_app-1-health.service web_app-2-health.service");
    expect(key(web, "Service web_app", "Parallelism")).toBe("1");
    expect(key(web, "Service web_app", "Delay")).toBe("10s");
    expect(key(web, "Service web_app", "Order")).toBe("start-first");
    expect(key(web, "Service web_app", "FailureAction")).toBe("rollback");
    expect(key(web, "Service web_app", "Monitor")).toBe("30s");
    expect(key(web, "Service web_app", "MaxFailureRatio")).toBe("0");
    expect(key(web, "Service web_app", "Image")).toBe("/var/lib/machines/acme-app_2026.09.mstack");
    expect(key(web, "Service web_app", "Form")).toBe("service");
    expect(key(web, "Service web_app", "Credentials")).toBe("web_app-app-secret-key web_app_signing_key");
  });

  test("a service with no update_config falls back to one at a time with no delay, and the stack's sections are in rollout order", () => {
    const data = spec(result, "swarm-wrk-1", "data");
    expect(key(data, "Service data_exporter", "Parallelism")).toBe("1");
    expect(key(data, "Service data_exporter", "Delay")).toBe("0s");
    expect(key(data, "Service data_exporter", "Order")).toBe("stop-first");
    expect(key(data, "Service data_exporter", "Health")).toBe("");
    expect(key(data, "Service data_exporter", "Monitor")).toBe("30s");
    expect(key(data, "Service data_postgres", "Monitor")).toBe("5s");
    const sections = data.split("\n").filter((l) => l.startsWith("[Service "));
    expect(sections).toEqual(["[Service data_exporter]", "[Service data_postgres]"]);
  });

  test("the notes say where the values came from when the source said nothing", () => {
    expect(result.notes.some((n) => n.startsWith("data_exporter: the source describes no update_config"))).toBe(true);
    expect(result.notes.some((n) => n.includes("/usr/local/lib/systemd-migration/stackctl drives deploy"))).toBe(true);
  });

  test("Sockets= carries the socket-proxyd sockets the networkd component publishes for the service", () => {
    const { plan } = composePlan(inv, COMPONENTS);
    for (const d of plan.decisions) {
      if (d.chosen != null || d.default != null) continue;
      if (d.kind === "choice" && d.options?.length) resolveDecision(plan, d.id, d.options[0]!.value);
    }
    resolveDecision(plan, publishId("web_app", 8080, "tcp"), "socket-proxyd");
    const proxied = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true, rendererName: "test" });
    const web = proxied.files["hosts/swarm-wrk-1/etc/systemd-migration/rollout/web.conf"] as string;
    const sockets = key(web, "Service web_app", "Sockets").split(" ").filter(Boolean);
    expect(sockets.length).toBeGreaterThan(0);
    for (const s of sockets) expect(s.endsWith(".socket")).toBe(true);
    const table = proxied.hosts["swarm-wrk-1"]!;
    expect(sockets.every((s) => s.startsWith("web_app-") || table.sockets.includes(s))).toBe(true);
  });
});

/** A temporary host tree with the rendered specifications and a fake systemctl. */
function tree(files: Record<string, string>): { dir: string; run: (args: string[]) => { out: string; err: string; code: number; log: string[] } } {
  mkdirSync(resolve(import.meta.dir, "../.tmp"), { recursive: true });
  const dir = mkdtempSync(resolve(import.meta.dir, "../.tmp/rollout-"));
  mkdirSync(join(dir, "rollout"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "rollout", name), content);
  // The fake logs every call and answers the two queries the controller makes.
  const fake = [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$FAKE_LOG"',
    "case $1 in",
    "  is-active) echo active ;;",
    "  show) echo success ;;",
    "esac",
    "",
  ].join("\n");
  writeFileSync(join(dir, "bin", "systemctl"), fake, { mode: 0o755 });
  chmodSync(join(dir, "bin", "systemctl"), 0o755);
  const log = join(dir, "log");
  return {
    dir,
    run(args: string[]) {
      writeFileSync(log, "");
      const proc = Bun.spawnSync(["sh", script, ...args], {
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          FAKE_LOG: log,
          SYSTEMD_MIGRATION_ROLLOUT_DIR: join(dir, "rollout"),
          SYSTEMD_MIGRATION_STATE_DIR: join(dir, "state"),
        },
      });
      return {
        out: proc.stdout.toString(),
        err: proc.stderr.toString(),
        code: proc.exitCode ?? -1,
        log: readFileSync(log, "utf8").split("\n").filter(Boolean),
      };
    },
  };
}

/** The commands a verb would run, without the monitor's transient service. */
function commands(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("+ "))
    .map((l) => l.slice(2));
}

function withTree(files: Record<string, string>, body: (t: ReturnType<typeof tree>) => void): void {
  const t = tree(files);
  try {
    body(t);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

const webSpec = spec(scaled, "swarm-wrk-1", "web");
const dataSpec = spec(result, "swarm-wrk-1", "data");
/** The web stack with a socket per instance, as the networkd component records them in expected.json. */
const webWithSockets = webSpec.replace("Sockets=", "Sockets=web_app-1-8080.socket web_app-2-8081.socket");

describe("stackctl", () => {
  test("the controller is POSIX sh and parses under sh, dash, and bash", () => {
    for (const shell of ["sh", "dash", "bash"]) {
      const proc = Bun.spawnSync([shell, "-n", script]);
      if (proc.exitCode === 127) continue; // the shell is not installed here
      expect(proc.stderr.toString(), shell).toBe("");
      expect(proc.exitCode, shell).toBe(0);
    }
    expect(readFileSync(script, "utf8").startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("deploy walks a stop-first service by stopping and starting each batch", () => {
    withTree({ "data.conf": dataSpec }, (t) => {
      const r = t.run(["deploy", "data", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(commands(r.out).filter((c) => c.startsWith("systemctl"))).toEqual([
        "systemctl stop data_exporter.service",
        "systemctl start data_exporter.service",
        "systemctl stop data_postgres.service",
        "systemctl start data_postgres.service",
      ]);
      // Each batch is watched for its own monitor window, bounded by systemd.
      const monitors = commands(r.out).filter((c) => c.startsWith("systemd-run"));
      expect(monitors).toHaveLength(2);
      expect(monitors[0]).toContain("-p RuntimeMaxSec=30s");
      expect(monitors[0]).toContain("monitor-batch 30 - data_exporter.service");
      expect(monitors[1]).toContain("-p RuntimeMaxSec=5s");
      expect(monitors[1]).toContain("monitor-batch 5 data_postgres-health.service data_postgres.service");
      // A dry run changes nothing, so the fake is only asked read-only questions.
      expect(r.log.every((l) => l.startsWith("is-active") || l.startsWith("show"))).toBe(true);
    });
  });

  test("deploy walks a start-first service one batch at a time, confirming the rest is up first", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const r = t.run(["deploy", "web", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(commands(r.out)).toEqual([
        "systemctl restart web_app-1.service",
        `systemd-run --quiet --wait --collect -p RuntimeMaxSec=30s --description=stackctl-monitor ${script} monitor-batch 30 web_app-1-health.service web_app-2-health.service web_app-1.service`,
        "sleep 10",
        "systemctl restart web_app-2.service",
        `systemd-run --quiet --wait --collect -p RuntimeMaxSec=30s --description=stackctl-monitor ${script} monitor-batch 30 web_app-1-health.service web_app-2-health.service web_app-2.service`,
      ]);
      // The instance outside each batch is the one checked before the restart.
      expect(r.log).toContain("is-active web_app-2.service");
      expect(r.log).toContain("is-active web_app-1.service");
    });
  });

  test("a start-first service with one instance on the host stops and starts instead, and says so", () => {
    withTree({ "web.conf": spec(result, "swarm-wrk-1", "web") }, (t) => {
      const r = t.run(["deploy", "web", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.err).toContain("start-first cannot hold capacity with 1 instance(s)");
      expect(commands(r.out).filter((c) => c.startsWith("systemctl"))).toEqual(["systemctl stop web_app.service", "systemctl start web_app.service"]);
    });
  });

  test("deploy --image versions the image under a systemd.v directory and swaps the symlink", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const r = t.run(["deploy", "web", "--image", "acme-app_2026.09=registry.example.com/acme/app:2026.10", "--dry-run"]);
      expect(r.code).toBe(0);
      const c = commands(r.out);
      expect(c).toContain("mkdir -p /var/lib/machines/acme-app_2026.09.mstack.v");
      expect(c).toContain("ln -s /var/lib/machines/acme-app_2026.09.mstack.v/acme-app_2026.09_2026.10.mstack /var/lib/machines/acme-app_2026.09.mstack.stackctl.tmp");
      expect(c).toContain("mv /var/lib/machines/acme-app_2026.09.mstack.stackctl.tmp /var/lib/machines/acme-app_2026.09.mstack");
      expect(c.some((l) => l.includes("pull-images.sh"))).toBe(true);
    });
  });

  test("deploy --image refuses a name no service on this host uses", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const r = t.run(["deploy", "web", "--image", "nothing_here=r/x:1", "--dry-run"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("has an image named nothing_here");
    });
  });

  test("rollback restarts the service and says when no deploy recorded a previous image", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const r = t.run(["rollback", "web", "web_app", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.err).toContain("no deploy recorded a previous image");
      expect(commands(r.out).filter((c) => c.startsWith("systemctl"))).toEqual(["systemctl restart web_app-1.service", "systemctl restart web_app-2.service"]);
    });
  });

  test("rollback restores the recorded image target", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      writeFileSync(join(t.dir, "state", "web.acme-app_2026.09.previous"), "/var/lib/machines/acme-app_2026.09.mstack.v/acme-app_2026.09_2026.09.mstack\n");
      const r = t.run(["rollback", "web", "web_app", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(commands(r.out)).toContain("ln -s /var/lib/machines/acme-app_2026.09.mstack.v/acme-app_2026.09_2026.09.mstack /var/lib/machines/acme-app_2026.09.mstack.stackctl.tmp");
      expect(commands(r.out)).toContain("mv /var/lib/machines/acme-app_2026.09.mstack.stackctl.tmp /var/lib/machines/acme-app_2026.09.mstack");
    });
  });

  test("rollback refuses a service the stack does not run here", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const r = t.run(["rollback", "web", "data_postgres", "--dry-run"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("does not run data_postgres on this host");
    });
  });

  test("drain stops the sockets before the instances, stacks and services in reverse", () => {
    withTree({ "web.conf": webWithSockets, "data.conf": dataSpec }, (t) => {
      const r = t.run(["drain", "swarm-wrk-1", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(commands(r.out)).toEqual([
        "systemctl stop web_app-1-8080.socket web_app-2-8081.socket",
        "systemctl stop web_app-2.service web_app-1.service",
        "systemctl stop data_postgres.service",
        "systemctl stop data_exporter.service",
      ]);
    });
  });

  test("activate is the mirror of drain", () => {
    withTree({ "web.conf": webWithSockets, "data.conf": dataSpec }, (t) => {
      const r = t.run(["activate", "swarm-wrk-1", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(commands(r.out)).toEqual([
        "systemctl start data_exporter.service",
        "systemctl start data_postgres.service",
        "systemctl start web_app-1.service web_app-2.service",
        "systemctl start web_app-1-8080.socket web_app-2-8081.socket",
      ]);
    });
  });

  test("drain refuses a host this controller was not rendered for", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const r = t.run(["drain", "swarm-mgr-1", "--dry-run"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("rendered for swarm-wrk-1, not swarm-mgr-1");
    });
  });

  test("scale stays inside the rendered instances and names the decision beyond them", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const down = t.run(["scale", "web_app", "1", "--dry-run"]);
      expect(down.code).toBe(0);
      expect(commands(down.out)).toEqual(["systemctl stop web_app-2.service", "systemctl start web_app-1.service"]);

      const up = t.run(["scale", "web_app", "2", "--dry-run"]);
      expect(commands(up.out)).toEqual(["systemctl start web_app-1.service web_app-2.service"]);

      const beyond = t.run(["scale", "web_app", "3", "--dry-run"]);
      expect(beyond.code).toBe(2);
      expect(beyond.err).toContain("3 is a re-render, not a scale");
      expect(beyond.err).toContain("placement.hosts.web_app");

      const unknown = t.run(["scale", "not_a_service", "1", "--dry-run"]);
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain("runs not_a_service on this host");
    });
  });

  test("rotate credential re-runs the import script and restarts only the consumers", () => {
    withTree({ "web.conf": webSpec, "data.conf": dataSpec }, (t) => {
      const r = t.run(["rotate", "credential", "web_app_signing_key", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(commands(r.out).filter((c) => !c.startsWith("systemd-run"))).toEqual([
        "/usr/local/lib/systemd-migration/import-credentials.sh",
        "systemctl restart web_app-1.service",
        "sleep 10",
        "systemctl restart web_app-2.service",
      ]);

      const shared = t.run(["rotate", "credential", "data_postgres_password", "--dry-run"]);
      expect(commands(shared.out).filter((c) => c.startsWith("systemctl"))).toEqual([
        "systemctl stop data_exporter.service",
        "systemctl start data_exporter.service",
        "systemctl stop data_postgres.service",
        "systemctl start data_postgres.service",
      ]);

      const unknown = t.run(["rotate", "credential", "nothing", "--dry-run"]);
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain("lists nothing under Credentials");
    });
  });

  test("rotate config refreshes a confext and otherwise names the file to replace", () => {
    const withConfig = dataSpec.replace("[Service data_postgres]\nUnits=", "[Service data_postgres]\nConfigs=data_pg_conf\nUnits=");
    withTree({ "data.conf": withConfig }, (t) => {
      const files = t.run(["rotate", "config", "data_pg_conf", "--dry-run"]);
      expect(files.code).toBe(0);
      expect(files.err).toContain("/etc/data/configs/");
      expect(commands(files.out).filter((c) => c.startsWith("systemctl"))).toEqual(["systemctl stop data_postgres.service", "systemctl start data_postgres.service"]);
    });
    withTree({ "data.conf": withConfig.replace("ConfigForm=files", "ConfigForm=confext") }, (t) => {
      const confext = t.run(["rotate", "config", "data_pg_conf", "--dry-run"]);
      expect(confext.code).toBe(0);
      expect(commands(confext.out)[0]).toBe("systemd-confext refresh");
    });
  });

  test("status reports each instance and its health result without changing anything", () => {
    withTree({ "web.conf": webSpec }, (t) => {
      const r = t.run(["status", "web"]);
      expect(r.code).toBe(0);
      expect(commands(r.out)).toEqual([]);
      expect(r.out).toContain("stack web on swarm-wrk-1");
      expect(r.out).toContain("web_app (service, order start-first, failure rollback, parallelism 1)");
      expect(r.out).toContain("image /var/lib/machines/acme-app_2026.09.mstack");
      expect(r.out).toContain("web_app-1.service active, health success");
      expect(r.out).toContain("web_app-2.service active, health success");
      expect(r.log).toEqual([
        "is-active web_app-1.service",
        "show -p Result --value web_app-1-health.service",
        "is-active web_app-2.service",
        "show -p Result --value web_app-2-health.service",
      ]);
    });
  });

  test("a service without a healthcheck is reported as such", () => {
    withTree({ "data.conf": dataSpec }, (t) => {
      const r = t.run(["status", "data"]);
      expect(r.out).toContain("data_exporter.service active, no healthcheck");
      expect(r.out).toContain("data_postgres.service active, health success");
    });
  });

  test("a malformed specification is refused with the file, the line, and exit code 3", () => {
    const cases: [string, string][] = [
      ["[Rollout]\nStack=web\nHost=h\n\n[Service a]\nUnits=\n", "has no Units="],
      ["[Rollout]\nStack=web\nHost=h\n[Service a]\nUnits=a.service\nOrder=sideways\n", "Order=sideways is neither start-first nor stop-first"],
      ["[Rollout]\nStack=web\nHost=h\n[Service a]\nUnits=a.service\nFailureAction=explode\n", "FailureAction=explode is none of"],
      ["[Rollout]\nStack=web\nHost=h\n[Service a]\nUnits=a.service\nParallelism=0\n", "Parallelism=0 is not a positive whole number"],
      ["[Rollout]\nStack=web\nHost=h\n[Service a]\nUnits=a.service\nDelay=soon\n", "Delay=soon is not a time span"],
      ["[Rollout]\nStack=web\nHost=h\n[Service a]\nUnits=a.service\nMonitor=30 fortnights\n", "is not a time span"],
      ["Units=a.service\n", "assignment before any section"],
      ["[Rollout]\nStack=web\nHost=h\n[Bogus]\nk=v\n", "unknown section [Bogus]"],
      ["[Rollout]\nStack=web\nHost=h\n[Service a]\nUnits a.service\n", "not a key=value line"],
      ["[Rollout]\nStack=web\nHost=h\n", "no [Service NAME] section"],
      ["[Rollout]\nHost=h\n[Service a]\nUnits=a.service\n", "has no Stack="],
      ["[Rollout]\nStack=web\n[Service a]\nUnits=a.service\n", "has no Host="],
    ];
    for (const [text, message] of cases) {
      withTree({ "web.conf": text }, (t) => {
        const r = t.run(["status", "web"]);
        expect(r.code, message).toBe(3);
        expect(r.err, message).toContain(message);
      });
    }
  });

  test("a missing specification, an unknown verb, and a missing argument are told apart", () => {
    withTree({}, (t) => {
      expect(t.run(["status", "web"]).code).toBe(3);
      expect(t.run(["status", "web"]).err).toContain("no rollout specification at");
    });
    withTree({ "web.conf": webSpec }, (t) => {
      expect(t.run(["frobnicate", "web"]).code).toBe(2);
      expect(t.run(["frobnicate", "web"]).err).toContain("unknown verb frobnicate");
      expect(t.run(["deploy"]).code).toBe(2);
      expect(t.run(["deploy", "web", "--image", "no-equals-sign", "--dry-run"]).code).toBe(2);
      expect(t.run(["--help"]).code).toBe(0);
      expect(t.run(["--help"]).out).toContain("usage: stackctl VERB");
    });
  });

  test("comments, blank lines, and repeated list assignments are read the way systemd reads them", () => {
    const text = [
      "# a comment",
      "; another",
      "[Rollout]",
      "  Stack = web ",
      "Host=swarm-wrk-1",
      "",
      "[Service web_app]",
      "Units=a.service",
      "Units=b.service",
      "Parallelism=2",
      "Delay=0s",
      "Order=stop-first",
      "FailureAction=pause",
      "Monitor=0s",
      "",
    ].join("\n");
    withTree({ "web.conf": text }, (t) => {
      const r = t.run(["deploy", "web", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(commands(r.out)).toEqual(["systemctl stop a.service b.service", "systemctl start a.service b.service"]);
    });
  });
});
