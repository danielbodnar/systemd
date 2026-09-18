// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The Quadlet component: the Podman adapter target. When the plan gives a
// service the "quadlet" form, this component writes the .container file
// (and the .network and .volume files it needs) under the Quadlet unit
// directory, records the .service unit Podman's generator will produce, and
// renders the per-host import-secrets.sh that creates the Podman secrets
// the unit references. It reuses the standalone renderer's per-object
// functions (render.ts), so a .container rendered through the engine is
// byte-for-byte what the standalone renderer writes. Quadlet is Podman's
// interface rather than a systemd man page, so the component claims no
// page of the systemd surface and is listed under "adapters" in
// contract/coverage.json.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import type { Network, Volume } from "../../../contract/types.ts";
import { isPlainPath, octal, shellQuote } from "../../../contract/unit.ts";
import { type ContainerOptions, DEFAULT_CONFIG_DIR, DEFAULT_UNIT_DIR, VIP_NOTE, importScript, networkUnit, renderContainer, serviceNotes, synthesizedVolumeUnit, unitDirRel, volumeUnit } from "./render.ts";

export const SECRETS = "quadlet.secrets.estate";
export const AUTO_UPDATE = "quadlet.auto_update.estate";
export const SELINUX = "quadlet.selinux.estate";
export const UNIT_DIR = "quadlet.unit_dir.estate";
export const CONFIG_DIR = "quadlet.config_dir.estate";

const YES_NO = (yes: { label: string; consequence: string }, no: { label: string; consequence: string }) => [
  { value: "no", label: no.label, consequence: no.consequence },
  { value: "yes", label: yes.label, consequence: yes.consequence },
];

export const quadletComponent: Component = {
  id: "quadlet",
  title: "Podman Quadlet (adapter target)",
  covers: [],
  after: ["service"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const inv = ctx.inventory;
    const out: DecisionSpec[] = [];
    const secretEvidence: string[] = [];
    for (const s of inv.secrets) secretEvidence.push(`secrets[${s.name}] used by ${s.used_by.join(", ") || "nothing"}`);
    for (const svc of inv.services) for (const k of svc.redacted_env) secretEvidence.push(`services[${svc.name}].env.${k} was redacted at capture`);
    out.push({
      id: SECRETS,
      kind: "choice",
      subject: { kind: "estate", name: "estate" },
      question: "How do secrets and redacted environment values reach a service rendered as a Quadlet container?",
      options: [
        {
          value: "podman-secret",
          label: "Podman secrets",
          consequence: "the .container references each with Secret=<name>,type=mount or type=env and secrets/import-secrets.sh creates them with podman secret create --replace from /etc/swarm-migration/secrets; the creds component leaves Quadlet services alone",
          requires: { tools: ["podman"] },
        },
      ],
      default: "podman-secret",
      evidence: [
        ...(secretEvidence.length ? secretEvidence : ["the inventory has no secrets and no redacted environment values"]),
        "podman-systemd.unit(5) documents Secret= as the only secret source of a .container; a systemd credential path is not offered because Quadlet does not document one (see references/field-map.md)",
      ],
    });
    const unpinned = inv.services.filter((s) => !s.image_digest).map((s) => s.name);
    out.push({
      id: AUTO_UPDATE,
      kind: "choice",
      subject: { kind: "estate", name: "estate" },
      question: "Add AutoUpdate=registry to Quadlet containers whose image is a tag rather than a digest, so podman-auto-update.timer can roll them?",
      options: YES_NO(
        { label: "AutoUpdate=registry on tag-based images", consequence: "podman-auto-update.timer pulls a newer tag and restarts the unit; images pinned to a digest are left alone" },
        { label: "no automatic updates", consequence: "an image changes only when the operator pulls it and restarts the unit" },
      ),
      default: "no",
      evidence: unpinned.length ? unpinned.map((n) => `services[${n}].image_digest=null`) : ["every service image is pinned to a digest, so the setting would have no effect"],
    });
    const selinuxHosts = Object.entries(ctx.hosts)
      .filter(([, caps]) => caps?.os?.id && /^(fedora|rhel|centos|rocky|almalinux|ol)$/.test(caps.os.id))
      .map(([h, caps]) => `hosts[${h}].os.id=${caps!.os!.id} (SELinux is enforcing by default)`);
    out.push({
      id: SELINUX,
      kind: "choice",
      subject: { kind: "estate", name: "estate" },
      question: "Append SELinux relabel suffixes (:z shared, :Z private) to bind mounts and config mounts in the Quadlet containers?",
      options: YES_NO(
        { label: "relabel bind mounts", consequence: "bind mounts get ,Z (read-write) or ,z (read-only) and config mounts ,z so the container can read them under an enforcing policy" },
        { label: "no relabeling", consequence: "mounts keep their labels; needed on hosts without SELinux, and where the paths are already labeled container_file_t" },
      ),
      default: "no",
      evidence: selinuxHosts.length ? selinuxHosts : ["no probed host reports an SELinux distribution; choose yes on Fedora, RHEL, or a derivative in enforcing mode"],
    });
    out.push({
      id: UNIT_DIR,
      kind: "value",
      format: "path",
      subject: { kind: "estate", name: "estate" },
      question: "Where do the Quadlet files (.container, .network, .volume) go on the hosts?",
      default: DEFAULT_UNIT_DIR,
      evidence: ["podman-systemd.unit(5) reads /etc/containers/systemd for rootful units and ~/.config/containers/systemd for rootless ones"],
    });
    if (inv.configs.length || inv.services.some((s) => s.configs.length)) {
      out.push({
        id: CONFIG_DIR,
        kind: "value",
        format: "path",
        subject: { kind: "estate", name: "estate" },
        question: "Where do config payloads go on the hosts, to be mounted read-only into the Quadlet containers?",
        default: DEFAULT_CONFIG_DIR,
        evidence: inv.configs.map((c) => `configs[${c.name}] used by ${c.used_by.join(", ") || "nothing"}`),
      });
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const instances = ctx.instances.filter((i) => i.form === "quadlet");
    if (instances.length === 0) return;
    const inv = ctx.inventory;
    const unitDir = ctx.value(UNIT_DIR).replace(/\/+$/, "");
    const configDir = ctx.valueOr(CONFIG_DIR, DEFAULT_CONFIG_DIR).replace(/\/+$/, "");
    for (const [id, dir] of [[UNIT_DIR, unitDir], [CONFIG_DIR, configDir]] as const) {
      if (!isPlainPath(dir)) throw new Error(`${id} must be an absolute path of plain characters, got ${JSON.stringify(dir)}`);
    }
    // The only store today; the value is read so an unresolved decision is reported like any other.
    ctx.value(SECRETS);
    const opts: ContainerOptions = { autoUpdate: ctx.value(AUTO_UPDATE) === "yes", selinux: ctx.value(SELINUX) === "yes", unitDir, configDir };
    const netByName = new Map<string, Network>(inv.networks.map((n) => [n.name, n]));
    const volByName = new Map<string, Volume>(inv.volumes.map((v) => [v.name, v]));
    const secrets: string[] = [];
    const networks: string[] = [];
    const volumes: string[] = [];
    const synthesized = new Map<string, { driver: string; options: Record<string, string> }>();
    const manifest: string[] = [];
    const noted = new Set<string>();

    for (const inst of instances) {
      const svc = inst.service;
      if (!noted.has(svc.name)) {
        noted.add(svc.name);
        for (const n of serviceNotes(svc, opts)) ctx.note(n);
      }
      const r = renderContainer(inv, svc, ctx.host, inst.index, inst.count, opts);
      for (const c of r.configs) {
        if (!c.data) continue;
        ctx.file(`${unitDirRel(configDir)}/${c.name}`, c.data);
        const line = `${configDir}/${c.name} ${c.uid} ${c.gid} ${octal(c.mode)}`;
        if (!manifest.includes(line)) manifest.push(line);
      }
      ctx.file(`${unitDirRel(unitDir)}/${r.unitName}.container`, r.text);
      const unit = `${r.unitName}.service`;
      ctx.expect("units", unit);
      ctx.expect("containers", r.unitName);
      ctx.wantedByStack(inst.stack, unit);
      for (const p of r.ports) ctx.expectPort(p.port, p.protocol);
      for (const s of r.secrets) {
        if (!secrets.includes(s.name)) secrets.push(s.name);
        ctx.expect("secrets", s.name);
      }
      for (const n of r.networks) if (!networks.includes(n)) networks.push(n);
      for (const v of r.volumes) if (!volumes.includes(v)) volumes.push(v);
      for (const s of r.synthesized) synthesized.set(s.name, { driver: s.driver, options: s.options });
      for (const n of r.notes) ctx.note(n, /has no payload in the inventory/.test(n) ? "decision" : "review");
      ctx.install("post", `systemctl cat -- ${shellQuote(unit)} >/dev/null 2>&1 || echo ${shellQuote(`warning: Podman's generator did not produce ${unit} from ${unitDir}/${r.unitName}.container; run it with --dryrun to see why`)} >&2`);
    }

    for (const name of networks) {
      const net = netByName.get(name)!;
      const r = networkUnit(net);
      ctx.file(`${unitDirRel(unitDir)}/${net.name}.network`, r.text);
      ctx.expect("networks", net.name);
      for (const n of r.notes) ctx.note(n);
    }
    for (const name of volumes) {
      const vol = volByName.get(name)!;
      const r = volumeUnit(vol, ctx.host);
      ctx.file(`${unitDirRel(unitDir)}/${vol.name}.volume`, r.text);
      ctx.expect("volumes", vol.name);
      for (const n of r.notes) ctx.note(n);
    }
    for (const [name, v] of synthesized) {
      ctx.file(`${unitDirRel(unitDir)}/${name}.volume`, synthesizedVolumeUnit(name, v.driver, v.options));
      ctx.expect("volumes", name);
    }

    // install.sh copies the tree's etc/ into /etc; a directory the decisions put elsewhere is copied explicitly.
    for (const dir of new Set([unitDir, ...(manifest.length ? [configDir] : [])])) {
      if (dir.startsWith("/etc/")) continue;
      ctx.install("pre", `install -d -m 0755 ${shellQuote(dir)} && cp -a "$here/${unitDirRel(dir)}/." ${shellQuote(dir)}/`);
    }
    if (manifest.length) {
      ctx.install("pre", ["while read -r path uid gid mode; do", '    chown "$uid:$gid" "$path"', '    chmod "$mode" "$path"', "done <<'MANIFEST'", ...manifest, "MANIFEST"].join("\n"));
    }
    if (secrets.length) ctx.file("secrets/import-secrets.sh", importScript(secrets));
    if (instances.some((i) => i.service.endpoint_mode === "vip" && i.service.networks.length > 0)) ctx.note(VIP_NOTE);
    ctx.note(`${ctx.host}: Quadlet files under ${unitDir} become units only through Podman's generator at daemon-reload; the rendered install.sh checks each expected .service exists after the reload`);
  },
};
