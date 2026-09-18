// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The machined component's machine and vm forms: the .nspawn file carries
// the service's binds, credentials, capabilities, and limits in documented
// directives only; the drop-ins on systemd-nspawn@.service and
// systemd-vmspawn@.service load the credentials and set the resource
// limits; and the committed rendered/machine tree is a fresh render of the
// committed plan-machine.yaml (plugins/scripts/render-fixtures.sh
// regenerates it).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkUnitText } from "../../contract/catalog.ts";
import { composeRender, formId } from "../../contract/compose.ts";
import { type Plan, loadPlan, resolveDecision } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { storeId } from "../../skills/systemd-creds/scripts/component.ts";
import { type MachineShape, NSPAWN_CREDENTIALS_DIR, machineKey } from "../../skills/systemd-machined/scripts/component.ts";
import type { RenderContext } from "../../contract/component.ts";

const fixture = resolve(import.meta.dir, "../../../../test/test-container-migration");
const inv = JSON.parse(readFileSync(join(fixture, "inventory.json"), "utf8")) as Inventory;
const HOST = "hosts/swarm-wrk-1";
const NSPAWN = `${HOST}/etc/systemd/nspawn/web_app.nspawn`;
const DROPIN = `${HOST}/etc/systemd/system/systemd-nspawn@web_app.service.d/10-migration.conf`;
/** The networkd component's decision this component reads for the machine's [Network] section. */
const ZONE_ID = "networkd.zone.web_app";

function machinePlan(): Plan {
  return loadPlan(join(fixture, "plan-machine.yaml"));
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

/** The lines of one section of a unit-style text. */
function section(text: string, name: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(`[${name}]`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("[")) break;
    if (l) out.push(l);
  }
  return out;
}

describe("the machine form", () => {
  const r = composeRender(inv, machinePlan(), COMPONENTS);
  const nspawn = r.files[NSPAWN] as string;
  const dropin = r.files[DROPIN] as string;

  test("replaces the plain service with a .nspawn file and a drop-in the stack target wants", () => {
    expect(r.files[`${HOST}/etc/systemd/system/web_app.service`]).toBeUndefined();
    expect(nspawn).toBeDefined();
    expect(dropin).toBeDefined();
    expect(r.files[`${HOST}/etc/systemd/system/web.target`]).toContain("Wants=systemd-nspawn@web_app.service");
    expect(r.hosts["swarm-wrk-1"]!.machines).toEqual(["web_app"]);
    expect(r.hosts["swarm-wrk-1"]!.units).toContain("systemd-nspawn@web_app.service");
    expect(r.hosts["swarm-wrk-1"]!.units).not.toContain("web_app.service");
    // The other service on the host is untouched by the choice.
    expect(r.files[`${HOST}/etc/systemd/system/data_postgres.service`]).toContain("RootMStack=");
  });

  test("[Exec] carries the command, the user, the environment, the capabilities, and the ulimits", () => {
    const exec = section(nspawn, "Exec");
    expect(exec).toContain("Parameters=/usr/bin/app serve --port 8080");
    expect(exec).toContain("PrivateUsers=pick");
    expect(exec).toContain("WorkingDirectory=/srv/app");
    expect(exec).toContain("User=1000");
    expect(exec).toContain("Environment=DATABASE_URL=postgres://app@data_postgres:5432/app");
    expect(exec).toContain("Environment=APP_HOME=/srv/app");
    expect(exec).not.toContain("Environment=APP_SECRET_KEY=<redacted>");
    expect(exec).toContain("DropCapability=all");
    expect(exec.some((l) => l.startsWith("Capability="))).toBe(false);
    expect(exec).toContain("LimitNOFILE=65536");
    expect(exec).toContain("LinkJournal=try-guest");
  });

  test("credentials load on the nspawn unit and are passed with --load-credential=, which forces PID 1 and NoNewPrivileges for a non-root user", () => {
    expect(section(dropin, "Service")).toContain("LoadCredentialEncrypted=web_app_signing_key:/etc/credstore.encrypted/web_app_signing_key");
    expect(section(dropin, "Service")).toContain("LoadCredentialEncrypted=web_app-app-secret-key:/etc/credstore.encrypted/web_app-app-secret-key");
    const exec = section(dropin, "Service").filter((l) => l.startsWith("ExecStart="));
    expect(exec[0]).toBe("ExecStart=");
    expect(exec[1]).toContain("--load-credential=web_app_signing_key:%d/web_app_signing_key");
    expect(exec[1]).toContain("--load-credential=web_app-app-secret-key:%d/web_app-app-secret-key");
    expect(exec[1]).toContain("--mstack=/var/lib/machines/acme-app_2026.09.mstack --machine=%i --settings=override");
    expect(exec[1]).not.toContain("--boot");
    // systemd-nspawn(1), --uid=: credentials for a non-root payload need --no-new-privileges=yes and neither --boot nor --as-pid2.
    expect(section(nspawn, "Exec")).toContain("NoNewPrivileges=yes");
    expect(section(nspawn, "Exec")).not.toContain("ProcessTwo=yes");
    expect(section(nspawn, "Exec")).toContain(`Environment=APP_SECRET_KEY_FILE=${NSPAWN_CREDENTIALS_DIR}/web_app-app-secret-key`);
    expect(r.hosts["swarm-wrk-1"]!.credentials).toEqual(["data_postgres_password", "web_app-app-secret-key", "web_app_signing_key"]);
    expect(r.decisions.some((n) => n.includes("web_app_signing_key") && n.includes(NSPAWN_CREDENTIALS_DIR))).toBe(true);
    // The creds component's import script covers what the machine loads, not only what the plain services load.
    const importer = r.files["hosts/swarm-wrk-1/secrets/import-credentials.sh"] as string;
    for (const name of ["data_postgres_password", "web_app-app-secret-key", "web_app_signing_key"]) expect(importer).toContain(name);
  });

  test("[Files] binds the volume at the storage state dir with idmap, mounts the tmpfs, and keeps the root read-only", () => {
    const files = section(nspawn, "Files");
    expect(files).toContain("ReadOnly=yes");
    expect(files).toContain("Bind=/var/lib/web/web_cache:/cache:idmap");
    expect(files).toContain("TemporaryFileSystem=/tmp:size=67108864");
    expect(r.hosts["swarm-wrk-1"]!.volumes).toContain("/var/lib/web/web_cache");
    const tmpfiles = r.files[`${HOST}/etc/tmpfiles.d/web-machines.conf`] as string;
    expect(tmpfiles).toContain("d /var/lib/web/web_cache 0750 1000 1000 -");
    expect(r.files[`${HOST}/install.sh`]).toContain("systemd-tmpfiles --create '/etc/tmpfiles.d/web-machines.conf'");
  });

  test("[Network] carries the zone the networkd component decided, Private=no for the host's namespace, and nothing without a decision", () => {
    // The committed plan takes the networkd component's default zone for web_app.
    expect(section(nspawn, "Network")).toContain("Zone=web_frontend");
    expect(section(nspawn, "Network").some((l) => l.startsWith("Private="))).toBe(false);
    const onHost = machinePlan();
    resolveDecision(onHost, ZONE_ID, "host");
    const hosted = composeRender(inv, onHost, COMPONENTS).files[NSPAWN] as string;
    expect(section(hosted, "Network")).toContain("Private=no");
    expect(section(hosted, "Network").some((l) => l.startsWith("Zone="))).toBe(false);
    expect(checkUnitText(hosted, "nspawn").unknown).toEqual([]);
    const undecided = machinePlan();
    undecided.decisions = undecided.decisions.filter((d) => d.id !== ZONE_ID);
    const plain = composeRender(inv, undecided, COMPONENTS).files[NSPAWN] as string;
    expect(section(plain, "Network").some((l) => l.startsWith("Zone=") || l.startsWith("Private="))).toBe(false);
    expect(composeRender(inv, undecided, COMPONENTS).notes.some((n) => n.includes("attach it to a zone with the networkd component"))).toBe(true);
  });

  test("the drop-in groups the unit into the stack and applies the limits through systemd.resource-control", () => {
    expect(section(dropin, "Unit")).toEqual(["PartOf=web.target", "ConditionHost=swarm-wrk-1"]);
    const service = section(dropin, "Service");
    expect(service).toContain("Slice=stack-web.slice");
    expect(service).toContain("CPUQuota=150%");
    expect(service).toContain("MemoryMax=512M");
    expect(service).toContain("MemoryLow=128M");
    expect(service).toContain("TasksMax=512");
  });

  test("the healthcheck is not rendered for a machine and is said so", () => {
    expect(r.files[`${HOST}/etc/systemd/system/web_app-health.service`]).toBeUndefined();
    expect(r.hosts["swarm-wrk-1"]!.timers).not.toContain("web_app-health.timer");
    expect(r.notes.some((n) => n.includes("web_app") && n.includes("healthcheck") && n.includes("not rendered for a machine"))).toBe(true);
  });

  test("every .nspawn passes the catalogue as nspawn and every drop-in as service", () => {
    let nspawns = 0;
    let dropins = 0;
    for (const [path, content] of Object.entries(r.files)) {
      if (path.endsWith(".nspawn")) {
        nspawns++;
        expect(checkUnitText(content as string, "nspawn").unknown, path).toEqual([]);
      }
      if (/\.service\.d\/[^/]+\.conf$/.test(path)) {
        dropins++;
        expect(checkUnitText(content as string, "service").unknown, path).toEqual([]);
      }
    }
    expect(nspawns).toBe(1);
    expect(dropins).toBe(1);
  });

  test("a plain credential store, cap_add, a config, a bind mount, and a device bind render as documented directives", () => {
    const plan = machinePlan();
    resolveDecision(plan, storeId("web_app_signing_key"), "credstore");
    const custom = JSON.parse(JSON.stringify(inv)) as Inventory;
    const app = custom.services.find((s) => s.name === "web_app")!;
    app.cap_add = ["NET_ADMIN", "CAP_SYS_PTRACE"];
    app.cap_drop = ["MKNOD"];
    app.configs = [{ name: "web_caddyfile", id: "cfg1", target: "/etc/app/config", uid: "0", gid: "0", mode: 0o644 }];
    app.mounts.push({ type: "bind", source: "/srv/shared", target: "/shared", readonly: true }, { type: "bind", source: "/dev/ttyUSB0", target: "/dev/ttyUSB0", readonly: false });
    const out = composeRender(custom, plan, COMPONENTS);
    const n = out.files[NSPAWN] as string;
    const d = out.files[DROPIN] as string;
    expect(section(n, "Exec")).toContain("Capability=CAP_NET_ADMIN CAP_SYS_PTRACE");
    expect(section(n, "Exec")).toContain("DropCapability=CAP_MKNOD");
    expect(section(n, "Files")).toContain("BindReadOnly=/etc/web/configs/web_caddyfile:/etc/app/config");
    expect(section(n, "Files")).toContain("BindReadOnly=/srv/shared:/shared");
    expect(section(n, "Files")).toContain("Bind=/dev/ttyUSB0:/dev/ttyUSB0");
    expect(section(d, "Service")).toContain("DeviceAllow=/dev/ttyUSB0 rw");
    expect(section(d, "Service")).toContain("LoadCredential=web_app_signing_key:/etc/credstore/web_app_signing_key");
    expect(section(d, "Service")).toContain("LoadCredentialEncrypted=web_app-app-secret-key:/etc/credstore.encrypted/web_app-app-secret-key");
    expect(out.files[`${HOST}/etc/web/configs/web_caddyfile`]).toBeDefined();
    expect(out.files[`${HOST}/install.sh`]).toContain("chown '0:0' '/etc/web/configs/web_caddyfile' && chmod '0644'");
    expect(checkUnitText(n, "nspawn").unknown).toEqual([]);
    expect(checkUnitText(d, "service").unknown).toEqual([]);
  });

  test("a root payload keeps ProcessTwo=yes with its credentials, and an external credential is a decision", () => {
    const plan = machinePlan();
    resolveDecision(plan, storeId("web_app_signing_key"), "external");
    const custom = JSON.parse(JSON.stringify(inv)) as Inventory;
    const app = custom.services.find((s) => s.name === "web_app")!;
    app.user = "root";
    const out = composeRender(custom, plan, COMPONENTS);
    const n = out.files[NSPAWN] as string;
    const d = out.files[DROPIN] as string;
    expect(section(n, "Exec")).toContain("ProcessTwo=yes");
    expect(section(n, "Exec")).not.toContain("NoNewPrivileges=yes");
    expect(section(n, "Exec").some((l) => l.startsWith("User="))).toBe(false);
    expect(d).not.toContain("web_app_signing_key");
    expect(d).toContain("--load-credential=web_app-app-secret-key:%d/web_app-app-secret-key");
    expect(out.decisions.some((x) => x.includes("web_app_signing_key is fetched externally"))).toBe(true);
    expect(out.files[`${HOST}/etc/tmpfiles.d/web-machines.conf`]).toContain("d /var/lib/web/web_cache 0750 - - -");
  });

  test("publishes the machine's shape for the other components", () => {
    const plan = machinePlan();
    // The shape is recorded under the instance's key; a probe component that runs after machined reads it back.
    let shape: MachineShape | undefined;
    const probe = { id: "probe", title: "", covers: [], after: ["machined"], decide: () => [], render: (c: RenderContext) => { shape = c.get<MachineShape>(machineKey("web_app")); } };
    composeRender(inv, plan, [...COMPONENTS, probe]);
    expect(shape).toMatchObject({ base: "web_app", unit: "systemd-nspawn@web_app.service", nspawn: "etc/systemd/nspawn/web_app.nspawn", stack: "web", volumes: ["/var/lib/web/web_cache"] });
    expect(shape!.credentials.map((c) => c.name).sort()).toEqual(["web_app-app-secret-key", "web_app_signing_key"]);
  });

  test("a ddi host runs the machine from the packed image", () => {
    const plan = machinePlan();
    resolveDecision(plan, "machined.root_form.swarm-wrk-1", "ddi");
    const out = composeRender(inv, plan, COMPONENTS);
    expect(out.files[DROPIN]).toContain("--image=/var/lib/machines/acme-app_2026.09.raw --machine=%i");
  });
});

describe("the vm form", () => {
  const plan = machinePlan();
  resolveDecision(plan, formId("web_app"), "vm");
  const r = composeRender(inv, plan, COMPONENTS);
  const dropin = r.files[`${HOST}/etc/systemd/system/systemd-vmspawn@web_app.service.d/10-migration.conf`] as string;

  test("renders a drop-in on systemd-vmspawn@.service over a bootable DDI with the documented memory and CPU options", () => {
    expect(r.files[NSPAWN]).toBeUndefined();
    expect(r.files[`${HOST}/etc/systemd/system/web_app.service`]).toBeUndefined();
    expect(section(dropin, "Unit")).toEqual(["PartOf=web.target", "ConditionHost=swarm-wrk-1", "RequiresMountsFor=/var/lib/machines"]);
    const exec = section(dropin, "Service").filter((l) => l.startsWith("ExecStart="));
    expect(exec[0]).toBe("ExecStart=");
    expect(exec[1]).toBe("ExecStart=systemd-vmspawn --quiet --register=yes --keep-unit --network-tap --image=/var/lib/machines/acme-app_2026.09-vm.raw --machine=%i --cpus=2 --ram=512M");
    expect(section(dropin, "Service")).toContain("Slice=stack-web.slice");
    expect(checkUnitText(dropin, "service").unknown).toEqual([]);
    expect(r.hosts["swarm-wrk-1"]!.machines).toEqual(["web_app"]);
    expect(r.hosts["swarm-wrk-1"]!.units).toContain("systemd-vmspawn@web_app.service");
    expect(r.files[`${HOST}/etc/systemd/system/web.target`]).toContain("Wants=systemd-vmspawn@web_app.service");
  });

  test("the decision note points at make-vm-ddi.sh and the mount stack the image is built from", () => {
    const note = r.decisions.find((n) => n.startsWith("web_app: the plan runs it as a virtual machine"))!;
    expect(note).toContain("make-vm-ddi.sh");
    expect(note).toContain("/var/lib/machines/acme-app_2026.09.mstack");
    expect(note).toContain("/var/lib/machines/acme-app_2026.09-vm.raw");
    expect(r.decisions.some((n) => n.includes("web_app") && n.includes("--load-credential="))).toBe(true);
  });

  test("a service without limits gets vmspawn's defaults", () => {
    const custom = JSON.parse(JSON.stringify(inv)) as Inventory;
    const app = custom.services.find((s) => s.name === "web_app")!;
    app.resources.limits = { nano_cpus: null, memory_bytes: null, pids: null };
    const out = composeRender(custom, plan, COMPONENTS);
    const exec = section(out.files[`${HOST}/etc/systemd/system/systemd-vmspawn@web_app.service.d/10-migration.conf`] as string, "Service").filter((l) => l.startsWith("ExecStart="));
    expect(exec[1]).not.toContain("--cpus=");
    expect(exec[1]).not.toContain("--ram=");
  });
});

describe("make-vm-ddi.sh", () => {
  const script = resolve(import.meta.dir, "../../skills/systemd-machined/scripts/make-vm-ddi.sh");
  test("parses, and refuses to run without a UKI or kernel", () => {
    expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
    const p = Bun.spawnSync(["bash", script, "/nonexistent.mstack", "/tmp/out.raw"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("--uki FILE or --kernel FILE");
  });
  test("ships an ESP and a root definition that the catalogue documents", () => {
    const dir = resolve(import.meta.dir, "../../skills/systemd-machined/references/repart.d-vm");
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["00-esp.conf", "10-root.conf"]);
    for (const n of names) {
      const text = readFileSync(join(dir, n), "utf8");
      expect(checkUnitText(text, "repart").unknown, n).toEqual([]);
    }
    expect(readFileSync(join(dir, "00-esp.conf"), "utf8")).toContain("Type=esp");
    expect(readFileSync(join(dir, "10-root.conf"), "utf8")).toContain("Type=root");
  });
});

describe("committed machine fixture", () => {
  test("plan-machine.yaml is fully resolved and approved, with a fixed timestamp", () => {
    const plan = machinePlan();
    expect(plan.generated_at).toBe("2026-09-01T12:00:00Z");
    expect(plan.decisions.every((d) => d.chosen != null)).toBe(true);
    expect(plan.decisions.find((d) => d.id === formId("web_app"))!.chosen).toBe("machine");
  });

  test("rendered/machine is a fresh render of the inventory and plan-machine.yaml", () => {
    const fresh = composeRender(inv, machinePlan(), COMPONENTS);
    const dir = join(fixture, "rendered", "machine");
    expect(existsSync(dir)).toBe(true);
    expect(walk(dir)).toEqual(Object.keys(fresh.files).sort());
    for (const [rel, content] of Object.entries(fresh.files)) {
      expect(readFileSync(join(dir, rel), "utf8"), rel).toBe(content as string);
    }
  });
});
