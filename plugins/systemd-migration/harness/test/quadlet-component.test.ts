// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The Quadlet adapter as a component: when the plan gives a service the
// "quadlet" form, the component writes the .container (and the .network
// and .volume files it needs) through the compose engine, the service
// component leaves it alone, the stack target wants the generated unit,
// and the secrets go through import-secrets.sh rather than the creds
// component. The .container text is what the standalone renderer writes.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkUnitText } from "../../contract/catalog.ts";
import { composePlan, composeRender, formId } from "../../contract/compose.ts";
import { resolveDecision } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { AUTO_UPDATE, CONFIG_DIR, SECRETS, SELINUX, UNIT_DIR, quadletComponent } from "../../skills/podman-quadlet/scripts/component.ts";
import { render as renderStandalone } from "../../skills/podman-quadlet/scripts/render.ts";
import { planFor } from "../../skills/systemd-service/scripts/render.ts";

const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const inv: Inventory = normalize(capture);

describe("quadlet decisions", () => {
  const { plan } = composePlan(inv, COMPONENTS);
  const byId = (id: string) => plan.decisions.find((d) => d.id === id);

  test("the component is registered as an adapter with no page claim and runs after service", () => {
    expect(COMPONENTS.some((c) => c === quadletComponent)).toBe(true);
    expect(quadletComponent.covers).toEqual([]);
    expect(quadletComponent.after).toEqual(["service"]);
  });

  test("the form decision offers quadlet", () => {
    const form = byId(formId("web_app"))!;
    expect(form.options!.map((o) => o.value)).toContain("quadlet");
    expect(form.default).toBe("service");
  });

  test("secrets, auto-update, selinux, unit dir, and config dir are raised with evidence from the inventory", () => {
    const secrets = byId(SECRETS)!;
    expect(secrets.options!.map((o) => o.value)).toEqual(["podman-secret"]);
    expect(secrets.default).toBe("podman-secret");
    expect(secrets.evidence).toContain("secrets[web_app_signing_key] used by web_app");
    expect(secrets.evidence!.some((e) => e.includes("APP_SECRET_KEY was redacted"))).toBe(true);
    expect(secrets.evidence!.some((e) => e.includes("credential path is not offered"))).toBe(true);
    const auto = byId(AUTO_UPDATE)!;
    expect(auto.options!.map((o) => o.value)).toEqual(["no", "yes"]);
    expect(auto.default).toBe("no");
    expect(auto.evidence).toContain("services[web_proxy].image_digest=null");
    expect(byId(SELINUX)!.default).toBe("no");
    expect(byId(UNIT_DIR)).toMatchObject({ kind: "value", format: "path", default: "/etc/containers/systemd" });
    expect(byId(CONFIG_DIR)).toMatchObject({ kind: "value", format: "path", default: "/etc/containers/swarm-configs" });
  });
});

describe("rendering the quadlet form", () => {
  const plan = planFor(inv);
  resolveDecision(plan, formId("web_app"), "quadlet");
  const r = composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
  const host = "hosts/swarm-wrk-1";
  const container = r.files[`${host}/etc/containers/systemd/web_app.container`] as string;

  test("writes the .container under the unit directory with image, secrets, and healthcheck", () => {
    expect(container).toBeDefined();
    expect(container).toContain("Image=registry.example.com/acme/app:2026.09@sha256:");
    expect(container).toContain("ContainerName=web_app");
    expect(container).toContain("Secret=web_app_signing_key,type=mount,target=signing_key,uid=1000,gid=1000,mode=0400");
    expect(container).toContain("Secret=web_app-app-secret-key,type=env,target=APP_SECRET_KEY");
    expect(container).toContain("HealthCmd=curl -fsS http://localhost:8080/healthz || exit 1");
    expect(container).toContain("Notify=healthy");
    expect(container).not.toContain("fixture-placeholder-not-a-secret");
  });

  test("the service component rendered no unit for it, the stack target wants the generated one, and the others are untouched", () => {
    expect(r.files[`${host}/etc/systemd/system/web_app.service`]).toBeUndefined();
    expect(r.files[`${host}/etc/systemd/system/web_app-health.timer`]).toBeUndefined();
    expect(r.files[`${host}/etc/systemd/system/web.target`]).toContain("Wants=web_app.service");
    expect(r.hosts["swarm-wrk-1"]!.units).toContain("web_app.service");
    expect(r.hosts["swarm-wrk-1"]!.ports).toContainEqual({ port: 8080, protocol: "tcp" });
    // data_postgres kept the service form on the same host.
    expect(r.files[`${host}/etc/systemd/system/data_postgres.service`]).toContain("ExecStart=");
    expect(r.files[`${host}/etc/containers/systemd/data_postgres.container`]).toBeUndefined();
  });

  test("the networks and volumes the container needs get Quadlet files and expectations", () => {
    expect(r.files[`${host}/etc/containers/systemd/web_frontend.network`]).toContain("NetworkName=web_frontend");
    expect(r.files[`${host}/etc/containers/systemd/web_cache.volume`]).toContain("VolumeName=web_cache");
    expect(r.hosts["swarm-wrk-1"]!.networks).toContain("web_frontend");
    expect(r.hosts["swarm-wrk-1"]!.volumes).toContain("web_cache");
  });

  test("secrets go through import-secrets.sh, not the creds component", () => {
    const script = r.files[`${host}/secrets/import-secrets.sh`] as string;
    expect(script).toContain("podman secret create --replace");
    expect(script).toContain("'web_app_signing_key'");
    expect(script).toContain("'web_app-app-secret-key'");
    expect(script).not.toContain("fixture-placeholder-not-a-secret");
    const creds = r.files[`${host}/secrets/import-credentials.sh`] as string | undefined;
    if (creds) expect(creds).not.toContain("web_app_signing_key");
  });

  test("the systemd sections of the .container carry no unknown directive", () => {
    const check = checkUnitText(container, "quadlet");
    expect(check.unknown).toEqual([]);
    expect(check.skipped_sections).toContain("Container");
  });

  test("the .container is what the standalone renderer writes for the same service", () => {
    const standalone = renderStandalone(inv, { outDir: "unused" });
    expect(container).toBe(standalone.files["hosts/swarm-wrk-1/etc/containers/systemd/web_app.container"] as string);
    expect(r.files[`${host}/etc/containers/systemd/web_frontend.network`]).toBe(standalone.files["hosts/swarm-wrk-1/etc/containers/systemd/web_frontend.network"] as string);
  });

  test("notes carry the renderer's translations and the generator requirement", () => {
    expect(r.notes.some((n) => n.includes("web_app: environment APP_SECRET_KEY was redacted at capture; supply it as Podman secret"))).toBe(true);
    expect(r.notes.some((n) => n.includes("ingress-mode ports become per-host published ports"))).toBe(true);
    expect(r.notes.some((n) => n.includes("Podman's generator"))).toBe(true);
    const install = r.files[`${host}/install.sh`] as string;
    expect(install).toContain("systemctl cat -- 'web_app.service'");
  });

  test("the unit directory, auto-update, and selinux decisions change the output", () => {
    const p = planFor(inv);
    resolveDecision(p, formId("web_proxy"), "quadlet");
    resolveDecision(p, UNIT_DIR, "/srv/quadlet");
    resolveDecision(p, AUTO_UPDATE, "yes");
    resolveDecision(p, SELINUX, "yes");
    const out = composeRender(inv, p, COMPONENTS, { acceptDefaults: true });
    const proxy = out.files["hosts/swarm-mgr-1/srv/quadlet/web_proxy.container"] as string;
    expect(proxy).toContain("AutoUpdate=registry");
    expect(proxy).toContain("Volume=/etc/containers/swarm-configs/web_caddyfile:/etc/caddy/Caddyfile:ro,z");
    expect(out.files["hosts/swarm-mgr-1/etc/containers/swarm-configs/web_caddyfile"]).toBeDefined();
    const install = out.files["hosts/swarm-mgr-1/install.sh"] as string;
    expect(install).toContain("cp -a \"$here/srv/quadlet/.\" '/srv/quadlet'/");
    expect(install).toContain("chown \"$uid:$gid\" \"$path\"");
    expect(install).toContain("/etc/containers/swarm-configs/web_caddyfile 0 0 0444");
  });
});
