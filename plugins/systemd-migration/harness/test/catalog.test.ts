// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The directive catalogue is the evidence that rendered output only uses
// what this systemd tree documents. These tests pin its shape, check it
// against the tree's own shipped units and network files, and exercise the
// unit checker the renderers use.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkUnitText, directive, fileTypeOf, loadCatalog, toolOption } from "../../contract/catalog.ts";
import { buildCatalog, parsePage } from "../../skills/migration-planner/scripts/build-catalog.ts";

const tree = resolve(import.meta.dir, "../../../..");
const catalog = loadCatalog();

describe("directive catalogue", () => {
  test("covers every unit type and the file formats the map targets", () => {
    for (const page of [
      "systemd.unit", "systemd.service", "systemd.socket", "systemd.timer", "systemd.path", "systemd.mount", "systemd.automount",
      "systemd.swap", "systemd.slice", "systemd.scope", "systemd.exec", "systemd.kill", "systemd.resource-control",
      "systemd.network", "systemd.netdev", "systemd.link", "systemd.nspawn", "systemd.dnssd", "repart.d", "tmpfiles.d", "sysusers.d",
      "os-release", "systemd-nspawn", "systemd-vmspawn", "systemd-mstack", "systemd-sysext", "importctl", "portablectl", "machinectl",
    ]) expect(Object.keys(catalog.pages[page]?.sections ?? {}).length, page).toBeGreaterThan(0);
  });

  test("records the version a directive was added in", () => {
    expect(directive("service", "Service", "RootMStack=")?.since).toBe(260);
    expect(directive("service", "Service", "ExecStart=")?.since).toBeNull();
    expect(directive("service", "Service", "LoadCredentialEncrypted=")?.page).toBe("systemd.exec");
    expect(directive("service", "Service", "MemoryMax=")?.page).toBe("systemd.resource-control");
    expect(directive("service", "Unit", "ConditionHost=")).not.toBeNull();
    expect(directive("service", "Unit", "ExecStart=")).toBeNull();
    expect(directive("nspawn", "Exec", "MountStack=") ?? directive("nspawn", "Files", "MountStack=")).toBeDefined();
    expect(directive("network", "Match", "Virtualization=")?.page).toBe("systemd.network");
    expect(directive("network", "DHCPServerStaticLease", "MACAddress=")).not.toBeNull();
    expect(directive("netdev", "WireGuardPeer", "AllowedIPs=")).not.toBeNull();
    expect(directive("netdev", "Tap", "MultiQueue=")).not.toBeNull();
    expect(directive("repart", "Partition", "CopyFiles=")).not.toBeNull();
    expect(toolOption("systemd-nspawn", "--mstack=")?.since).toBe(260);
    expect(toolOption("importctl", "pull-oci")?.since).toBe(260);
    expect(toolOption("systemd-nspawn", "--not-an-option=")).toBeNull();
  });

  test("maps file names to the checker's file types", () => {
    expect(fileTypeOf("web.target")).toBe("target");
    expect(fileTypeOf("web_app.container")).toBe("quadlet");
    expect(fileTypeOf("etc/repart.d/10-var.conf")).toBe("repart");
    expect(fileTypeOf("README.md")).toBeNull();
  });

  test("checks a unit and reports the minimum version and unknown directives", () => {
    const r = checkUnitText(
      [
        "[Unit]",
        "Description=x",
        "X-Migration-Stack=web",
        "[Service]",
        "RootMStack=/var/lib/machines/app.mstack",
        "ExecStart=/usr/bin/app \\",
        "  serve",
        "NotADirective=1",
        "[X-Migration]",
        "Stack=web",
      ].join("\n"),
      "service",
    );
    expect(r.minimum_version).toBe(260);
    expect(r.unknown).toEqual([{ line: 8, section: "Service", name: "NotADirective=" }]);
    expect(r.skipped_sections).toEqual(["X-Migration"]);
    expect(r.resolved.map((d) => d.name)).toEqual(["Description=", "RootMStack=", "ExecStart="]);
  });

  test("leaves Podman's quadlet sections to Podman", () => {
    const r = checkUnitText("[Container]\nImage=x\n[Service]\nRestart=always\n[Install]\nWantedBy=web.target\n", "quadlet");
    expect(r.unknown).toEqual([]);
    expect(r.skipped_sections).toEqual(["Container"]);
  });

  test("parses the shared exec page with grouped sections and version includes", () => {
    const page = parsePage(readFileSync(join(tree, "man", "systemd.exec.xml"), "utf8"), { layout: "grouped", kind: "directive", applies_to: ["Service"] }, join(tree, "man"));
    expect(page.sections["Credentials"]?.["LoadCredentialEncrypted="]).toBe(247);
    expect(page.sections["Paths"]?.["RootMStack="]).toBe(260);
  });

  test("the committed catalogue matches a fresh build from man/", () => {
    const fresh = buildCatalog(join(tree, "man"), catalog.systemd_version);
    expect(fresh.pages).toEqual(catalog.pages);
  });
});

describe("the tree's own files pass the checker", () => {
  const dirs = ["units", "network"].map((d) => join(tree, d)).filter(existsSync);
  const files: string[] = [];
  for (const d of dirs) {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) continue;
      const name = e.endsWith(".in") ? e.slice(0, -3) : e;
      if (fileTypeOf(name)) files.push(f);
    }
  }

  test("finds files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test("every directive in units/ and network/ is documented", () => {
    const unknown: string[] = [];
    for (const f of files) {
      const name = f.endsWith(".in") ? f.slice(0, -3) : f;
      const r = checkUnitText(readFileSync(f, "utf8"), fileTypeOf(name)!);
      for (const u of r.unknown) unknown.push(`${f}:${u.line} [${u.section}] ${u.name}`);
    }
    expect(unknown).toEqual([]);
  });
});
