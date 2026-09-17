// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The composition layer: plan.yaml round-trips, decisions are raised by the
// components with evidence and validated on resolution, rendering refuses to
// run on an unresolved or unapproved plan, and the components compose into
// one unit through the shared render context.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PLACEMENT_SCALE_OUT, composePlan, composeRender, formId, orderComponents, placementId } from "../../contract/compose.ts";
import { checkUnitText } from "../../contract/catalog.ts";
import type { Component } from "../../contract/component.ts";
import { type HostCapabilities, checkFormat, mergePlans, parsePlan, requirementsMet, resolveDecision, serializePlan, unresolvedDecisions } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { namespaceId } from "../../skills/systemd-journald/scripts/component.ts";
import { publishId, transportId } from "../../skills/systemd-networkd/scripts/component.ts";
import { DISCOVERY } from "../../skills/systemd-resolved/scripts/component.ts";
import { healthDecisionId, healthcheckNeedsApproval } from "../../skills/systemd-service/scripts/component.ts";
import { planFor, render } from "../../skills/systemd-service/scripts/render.ts";
import { configsId } from "../../skills/systemd-sysext/scripts/component.ts";
import { rootFormId } from "../../skills/systemd-machined/scripts/component.ts";
import { storeId } from "../../skills/systemd-creds/scripts/component.ts";

const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const inv: Inventory = normalize(capture);

const oldHost: HostCapabilities = {
  hostname: "swarm-wrk-1",
  systemd: { version: 255 },
  kernel: { release: "6.8.0", major: 6, minor: 8 },
  arch: "x86_64",
  cgroup_v2: true,
  overlayfs_fsconfig: false,
  daemons: { networkd: true, resolved: false },
  tools: { "systemd-nspawn": true, "systemd-creds": true },
};

describe("plan drafting", () => {
  const { plan } = composePlan(inv, COMPONENTS);

  test("every component raises decisions under its own id prefix, with evidence", () => {
    for (const d of plan.decisions) {
      expect(d.id.startsWith(`${d.component}.`)).toBe(true);
      expect(d.question.length).toBeGreaterThan(10);
    }
    const ids = plan.decisions.map((d) => d.id);
    expect(ids).toContain(placementId("web_app"));
    expect(ids).toContain(formId("web_app"));
    expect(ids).toContain(storeId("web_app_signing_key"));
    expect(ids).toContain(publishId("web_app", 8080, "tcp"));
    expect(ids).toContain(transportId("web_frontend"));
    expect(ids).toContain(namespaceId("web"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("questions that must not be guessed have no default", () => {
    const unresolved = unresolvedDecisions(plan).map((d) => d.id);
    expect(unresolved).toContain(publishId("web_app", 8080, "tcp")); // ingress mode: the mesh is gone
    expect(unresolved).toContain(DISCOVERY);
    expect(unresolved).toContain("storage.move.data_pgdata");
    // A host-mode port and an encrypted overlay have defensible defaults.
    expect(unresolved).not.toContain(publishId("web_proxy", 80, "tcp"));
    expect(unresolved).not.toContain(transportId("web_frontend"));
  });

  test("the placement decision carries the source's own scheduling as its default", () => {
    const d = plan.decisions.find((x) => x.id === placementId("web_proxy"))!;
    expect(d.default).toBe("swarm-mgr-1");
    expect(d.evidence!.some((e) => e.includes("tasks[node=swarm-mgr-1]"))).toBe(true);
  });

  test("host capabilities steer the defaults and annotate options a host cannot satisfy", () => {
    const { plan: p } = composePlan(inv, COMPONENTS, { hosts: { "swarm-wrk-1": oldHost, "swarm-mgr-1": null } });
    const root = p.decisions.find((d) => d.id === rootFormId("swarm-wrk-1"))!;
    expect(root.default).toBe("ddi");
    expect(root.options!.find((o) => o.value === "mstack")!.consequence).toContain("not available on swarm-wrk-1");
    expect(p.decisions.find((d) => d.id === rootFormId("swarm-mgr-1"))!.default).toBe("mstack");
    const transport = p.decisions.find((d) => d.id === transportId("web_frontend"))!;
    expect(transport.hosts!.sort()).toEqual(["swarm-mgr-1", "swarm-wrk-1"]);
  });

  test("the plan round-trips through YAML with its choices and reasons", () => {
    resolveDecision(plan, DISCOVERY, "dnssd", "the site has no DNS for this");
    const text = serializePlan(plan);
    const back = parsePlan(text);
    expect(back.decisions.find((d) => d.id === DISCOVERY)).toMatchObject({ chosen: "dnssd", reason: "the site has no DNS for this" });
    expect(back.summary!.unresolved).toBe(unresolvedDecisions(plan).length);
    expect(text).toContain("# systemd-migration plan");
  });

  test("resolving validates against the options and the format", () => {
    expect(() => resolveDecision(plan, DISCOVERY, "carrier-pigeon")).toThrow(/not one of/);
    expect(() => resolveDecision(plan, "networkd.subnet.web_frontend", "10.10.1.0")).toThrow(/address\/prefix/);
    expect(resolveDecision(plan, "networkd.subnet.web_frontend", "10.20.0.0/22").chosen).toBe("10.20.0.0/22");
    expect(() => resolveDecision(plan, placementId("web_app"), "not a host!")).toThrow(/host name/);
  });

  test("a fresh plan keeps earlier choices where they still apply and reports the rest", () => {
    const { plan: fresh, dropped } = composePlan(inv, COMPONENTS, { existing: plan });
    expect(fresh.decisions.find((d) => d.id === DISCOVERY)!.chosen).toBe("dnssd");
    expect(dropped).toEqual([]);
    const stale = { ...plan, decisions: [...plan.decisions, { ...plan.decisions[0]!, id: "placement.hosts.gone", chosen: "x" }] };
    expect(mergePlans(composePlan(inv, COMPONENTS).plan, stale).dropped.some((d) => d.startsWith("placement.hosts.gone"))).toBe(true);
  });
});

describe("value formats and requirements", () => {
  test("checkFormat accepts and rejects the right shapes", () => {
    expect(checkFormat("cidr", "10.0.0.0/8")).toBeNull();
    expect(checkFormat("cidr", "fd00::/64")).toBeNull();
    expect(checkFormat("cidr", "10.0.0.0/33")).not.toBeNull();
    expect(checkFormat("hosts", "a,b-1, c.example")).toBeNull();
    expect(checkFormat("hosts", "")).not.toBeNull();
    expect(checkFormat("path", "/var/lib/x")).toBeNull();
    expect(checkFormat("path", "/var/../x")).not.toBeNull();
    expect(checkFormat("port", "65536")).not.toBeNull();
  });
  test("requirementsMet compares against probed capabilities and passes unknown hosts with a flag", () => {
    expect(requirementsMet({ systemd: 260 }, oldHost)).toMatchObject({ ok: false, missing: ["systemd 260 (host has 255)"] });
    expect(requirementsMet({ kernel: "6.13" }, oldHost).ok).toBe(false);
    expect(requirementsMet({ daemons: ["networkd"], tools: ["systemd-nspawn"] }, oldHost).ok).toBe(true);
    expect(requirementsMet({ daemons: ["resolved"] }, oldHost).missing).toEqual(["daemon resolved"]);
    expect(requirementsMet({ systemd: 999 }, null)).toMatchObject({ ok: true, unknown: true });
  });
});

describe("rendering from a plan", () => {
  test("refuses an unresolved plan, then an unapproved one, then renders", () => {
    const { plan } = composePlan(inv, COMPONENTS);
    expect(() => composeRender(inv, plan, COMPONENTS)).toThrow(/unresolved decision/);
    for (const d of unresolvedDecisions(plan)) resolveDecision(plan, d.id, d.options![0]!.value);
    expect(() => composeRender(inv, plan, COMPONENTS)).toThrow(/rely on their default/);
    const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
    expect(Object.keys(r.hosts).sort()).toEqual(["swarm-mgr-1", "swarm-wrk-1"]);
    for (const d of plan.decisions) if (d.chosen == null) d.chosen = d.default;
    expect(() => composeRender(inv, plan, COMPONENTS)).not.toThrow();
  });

  test("components compose into one unit: service, creds, resource-control, storage, networkd, journald each add their lines", () => {
    const r = render(inv);
    const app = r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app.service"] as string;
    expect(app).toContain("ExecStart=/usr/bin/app serve --port 8080"); // service
    expect(app).toContain("LoadCredentialEncrypted=web_app_signing_key:/etc/credstore.encrypted/web_app_signing_key"); // creds
    expect(app).toContain("Slice=stack-web.slice"); // resource-control
    expect(app).toContain("BindPaths=/var/lib/web/web_cache:/cache"); // storage
    expect(app).toContain("SocketBindAllow=tcp:8080"); // networkd
    expect(app).toContain("LogExtraFields=SWARM_STACK=web SWARM_SERVICE=web_app"); // journald
    expect(app).toContain("Form=service");
    expect(checkUnitText(app, "service").unknown).toEqual([]);
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/system/data.target"]).toContain("Wants=var-lib-data-data_backups.mount");
  });

  test("decisions change what is rendered: socket activation, DNS-SD, a journal namespace, a confext, a plain credential", () => {
    const plan = planFor(inv);
    resolveDecision(plan, publishId("web_app", 8080, "tcp"), "socket");
    resolveDecision(plan, DISCOVERY, "dnssd");
    resolveDecision(plan, namespaceId("web"), "namespace");
    resolveDecision(plan, configsId("web"), "confext");
    resolveDecision(plan, storeId("web_app_signing_key"), "credstore");
    const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
    const app = r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app.service"] as string;
    expect(app).not.toContain("SocketBindAllow=tcp:8080");
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app-8080.socket"]).toContain("ListenStream=8080");
    expect(r.hosts["swarm-wrk-1"]!.sockets).toEqual(["web_app-8080.socket"]);
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/dnssd/web_app-8080.dnssd"]).toContain("Port=8080");
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/resolved.conf.d/10-migration.conf"]).toContain("MulticastDNS=yes");
    expect(app).toContain("LogNamespace=web");
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/journald@web.conf"]).toContain("[Journal]");
    expect(r.files["hosts/swarm-mgr-1/var/lib/confexts/web/etc/extension-release.d/extension-release.web"]).toContain("CONFEXT_LEVEL=1");
    expect(r.files["hosts/swarm-mgr-1/etc/web/configs/web_caddyfile"]).toBeUndefined();
    expect(app).toContain("LoadCredential=web_app_signing_key:/etc/credstore/web_app_signing_key");
    expect(r.files["hosts/swarm-wrk-1/secrets/import-credentials.sh"]).toContain("install -m 0600");
    for (const [path, content] of Object.entries(r.files)) {
      if (path.endsWith(".socket")) expect(checkUnitText(content as string, "socket").unknown).toEqual([]);
      if (path.endsWith(".dnssd")) expect(checkUnitText(content as string, "dnssd").unknown).toEqual([]);
    }
  });

  test("the machine form renders a .nspawn file and a drop-in instead of a plain service", () => {
    const plan = planFor(inv);
    resolveDecision(plan, formId("web_app"), "machine");
    const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app.service"]).toBeUndefined();
    const nspawn = r.files["hosts/swarm-wrk-1/etc/systemd/nspawn/web_app.nspawn"] as string;
    expect(nspawn).toContain("Parameters=/usr/bin/app serve --port 8080");
    expect(nspawn).toContain("PrivateUsers=pick");
    expect(checkUnitText(nspawn, "nspawn").unknown).toEqual([]);
    const dropin = r.files["hosts/swarm-wrk-1/etc/systemd/system/systemd-nspawn@web_app.service.d/10-migration.conf"] as string;
    expect(dropin).toContain("--mstack=/var/lib/machines/acme-app_2026.09.mstack --machine=%i");
    expect(r.hosts["swarm-wrk-1"]!.machines).toEqual(["web_app"]);
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/system/web.target"]).toContain("Wants=systemd-nspawn@web_app.service");
  });

  test("a healthcheck with shell control syntax is a decision with no default; argv checks run without a shell", () => {
    expect(healthcheckNeedsApproval("curl -fsS http://localhost/healthz || exit 1")).toBe(false);
    expect(healthcheckNeedsApproval("test $(cat /tmp/x) = ok")).toBe(true);
    expect(healthcheckNeedsApproval("nc -z localhost 80 > /dev/null")).toBe(true);
    const hostile = JSON.parse(JSON.stringify(inv)) as Inventory;
    const app = hostile.services.find((s) => s.name === "web_app")!;
    app.healthcheck = { ...app.healthcheck!, test: ["CMD-SHELL", "curl -s localhost; $(rm -rf /)"] };
    const pg = hostile.services.find((s) => s.name === "data_postgres")!;
    pg.healthcheck = { ...pg.healthcheck!, test: ["CMD", "pg_isready", "-U", "app; rm -rf /"] };
    const { plan } = composePlan(hostile, COMPONENTS);
    const d = plan.decisions.find((x) => x.id === healthDecisionId("web_app"))!;
    expect(d.default).toBeNull();
    expect(d.evidence!.some((e) => e.includes("control syntax"))).toBe(true);
    resolveDecision(plan, healthDecisionId("web_app"), "drop");
    for (const x of unresolvedDecisions(plan)) resolveDecision(plan, x.id, x.options![0]!.value);
    const r = composeRender(hostile, plan, COMPONENTS, { acceptDefaults: true });
    expect(r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app-health.service"]).toBeUndefined();
    const pgHealth = r.files["hosts/swarm-wrk-1/etc/systemd/system/data_postgres-health.service"] as string;
    expect(pgHealth).toContain('ExecStart=pg_isready -U "app; rm -rf /"');
    expect(pgHealth).not.toContain("/bin/sh");
  });

  test("health units run with the service's identity and no capabilities", () => {
    const r = render(inv);
    const health = r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app-health.service"] as string;
    const app = r.files["hosts/swarm-wrk-1/etc/systemd/system/web_app.service"] as string;
    for (const line of ["NoNewPrivileges=yes", "CapabilityBoundingSet=", "RestrictSUIDSGID=yes", "LockPersonality=yes", "PrivateUsers=self"]) expect(health).toContain(line);
    const identity = /^(DynamicUser=yes|User=.*)$/m;
    expect(health.match(identity)?.[0]).toBe(app.match(identity)?.[0]);
    expect(checkUnitText(health, "service").unknown).toEqual([]);
  });

  test("a config owner that is not a numeric id never reaches the install manifest", () => {
    for (const [field, value] of [["uid", "0; rm -rf /"], ["gid", "$(id -u)"], ["uid", "root"]] as const) {
      const hostile = JSON.parse(JSON.stringify(inv)) as Inventory;
      const proxy = hostile.services.find((s) => s.name === "web_proxy")!;
      (proxy.configs[0] as unknown as Record<string, unknown>)[field] = value;
      expect(() => render(hostile)).toThrow(/not a numeric id/);
      const plan = planFor(hostile);
      resolveDecision(plan, configsId("web"), "confext");
      expect(() => composeRender(hostile, plan, COMPONENTS, { acceptDefaults: true })).toThrow(/not a numeric id/);
    }
    const badMode = JSON.parse(JSON.stringify(inv)) as Inventory;
    badMode.services.find((s) => s.name === "web_proxy")!.configs[0]!.mode = 0o10000;
    expect(() => render(badMode)).toThrow(/not a file mode/);
  });

  test("the scale-out and host-map options of the one-call renderer become placement decisions", () => {
    const plan = planFor(inv, { scaleOut: true, hostMap: { data_postgres: ["swarm-mgr-1"] } });
    expect(plan.decisions.find((d) => d.id === PLACEMENT_SCALE_OUT)!.chosen).toBe("yes");
    expect(plan.decisions.find((d) => d.id === placementId("data_postgres"))!.chosen).toBe("swarm-mgr-1");
    const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
    expect(r.hosts["swarm-mgr-1"]!.units).toContain("data_postgres.service");
  });

  test("components render in dependency order and a cycle is refused", () => {
    expect(orderComponents(COMPONENTS).map((c) => c.id).indexOf("machined")).toBeLessThan(orderComponents(COMPONENTS).map((c) => c.id).indexOf("service"));
    const a: Component = { id: "a", title: "", covers: [], after: ["b"], decide: () => [], render: () => {} };
    const b: Component = { id: "b", title: "", covers: [], after: ["a"], decide: () => [], render: () => {} };
    expect(() => orderComponents([a, b])).toThrow(/cycle/);
  });
});
