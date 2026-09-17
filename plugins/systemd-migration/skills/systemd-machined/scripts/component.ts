// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The machined component: images and machines. It decides per host whether
// images are mounted as mount stacks (RootMStack=) or packed into
// discoverable disk images (RootImage=), records the image every instance
// needs so images.json and pull-images.sh know what to fetch, and renders
// the machine form (a .nspawn file plus a drop-in for
// systemd-nspawn@.service) when the plan chose it for a service.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import { imageName, quote } from "../../../contract/unit.ts";

export const IMAGE_DIR = "machined.image_dir.estate";
export function rootFormId(host: string): string {
  return `machined.root_form.${host}`;
}

export const machinedComponent: Component = {
  id: "machined",
  title: "Machines and images (systemd-nspawn, systemd-vmspawn, importctl, systemd.mstack, systemd.nspawn, machinectl)",
  covers: ["systemd-nspawn", "systemd.nspawn", "systemd-vmspawn", "importctl", "machinectl", "systemd-machined.service", "systemd-importd.service", "systemd.mstack", "systemd-mstack", "systemd.v", "systemd-dissect", "systemd-repart", "repart.d", "systemd-nspawn@.service"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    out.push({
      id: IMAGE_DIR,
      kind: "value",
      format: "path",
      subject: { kind: "estate", name: "estate" },
      question: "Where do the pulled images live on the hosts?",
      default: "/var/lib/machines",
      evidence: ["importctl pull-oci --class=machine writes NAME.mstack under /var/lib/machines"],
    });
    for (const host of ctx.hostNames) {
      const caps = ctx.hosts[host] ?? null;
      const canStack = caps === null ? null : caps.systemd.version >= 260 && caps.overlayfs_fsconfig !== false;
      out.push({
        id: rootFormId(host),
        kind: "choice",
        subject: { kind: "host", name: host },
        hosts: [host],
        question: `How are images mounted on ${host}?`,
        options: [
          { value: "mstack", label: "mount stack (RootMStack=)", consequence: "the image's layers are mounted as pulled, with a writable layer; needs systemd 260 and overlayfs FSCONFIG_SET_FD (kernel 6.13)", requires: { systemd: 260, kernel: "6.13" } },
          { value: "ddi", label: "disk image (RootImage=)", consequence: "the mount stack is packed into an erofs DDI by make-ddi.sh; read-only root, works on older hosts" },
        ],
        default: canStack === false ? "ddi" : "mstack",
        evidence: caps ? [`hosts[${host}].systemd.version=${caps.systemd.version}`, `hosts[${host}].kernel.release=${caps.kernel.release}`, `hosts[${host}].overlayfs_fsconfig=${caps.overlayfs_fsconfig}`] : [`hosts[${host}] not probed; run discover-systemd-hosts`],
      });
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const imageDir = ctx.value(IMAGE_DIR).replace(/\/+$/, "");
    const form = ctx.value(rootFormId(ctx.host));
    ctx.expected.root_kind = form === "ddi" ? "RootImage" : "RootMStack";
    if (!ctx.capabilities) ctx.note(`${ctx.host}: host capabilities unknown (no probe file); images are assumed to mount as ${form === "ddi" ? "disk images" : "mount stacks"}`);
    for (const inst of ctx.instances) {
      const svc = inst.service;
      const name = imageName(svc.image);
      const root = form === "ddi" ? `${imageDir}/${name}.raw` : `${imageDir}/${name}.mstack`;
      const entry = ctx.image(name, svc.image, svc.image_digest, svc.name);
      if (entry.ref !== svc.image) ctx.note(`image name ${name}: ${svc.image} and ${entry.ref} both map to it; pull one under another name and edit its root directive`, "decision");
      ctx.set(`machined:root:${svc.image}`, { root, kind: form === "ddi" ? "RootImage" : "RootMStack" });
      ctx.expect("images", root);
      if (form === "ddi") ctx.note(`${svc.name}: ${ctx.host} mounts images as disk images; build ${name}.raw with make-ddi.sh after pulling the mount stack`);
      if (inst.form === "machine") renderMachine(ctx, inst.base, inst.unit, inst.stack, svc.name, root, form === "ddi");
      if (inst.form === "vm") {
        ctx.note(`${svc.name}: the plan runs it as a virtual machine; systemd-vmspawn needs a bootable DDI with a kernel, which make-ddi.sh does not build from an application image (see the systemd-machined skill)`, "decision");
        ctx.expect("machines", inst.base);
      }
    }
  },
};

function renderMachine(ctx: RenderContext, base: string, unitName: string, stack: string, service: string, root: string, ddi: boolean): void {
  const svc = ctx.inventory.services.find((s) => s.name === service)!;
  const image = (ctx.inventory.images ?? []).find((i) => i.ref === svc.image);
  const n = ctx.unitAt(`etc/systemd/nspawn/${base}.nspawn`, [`Rendered by ${ctx.rendererName} from service ${service} (stack ${stack}) as a machine`]);
  const argv = svc.command.length ? [...svc.command, ...svc.args] : [...(image?.entrypoint ?? []), ...(svc.args.length ? svc.args : (image?.cmd ?? []))];
  if (argv.length) n.add("Exec", "Parameters", argv.map(quote).join(" "));
  n.add("Exec", "ProcessTwo", svc.init ? "yes" : null);
  n.add("Exec", "PrivateUsers", "pick");
  n.add("Exec", "Hostname", svc.hostname);
  n.add("Exec", "WorkingDirectory", svc.workdir ?? image?.workdir ?? null);
  n.add("Exec", "User", svc.user ?? image?.user ?? null);
  for (const [k, v] of Object.entries({ ...image?.env, ...svc.env }).sort()) {
    if (svc.redacted_env.includes(k) || image?.redacted_env.includes(k)) continue;
    n.add("Exec", "Environment", quote(`${k}=${v}`));
  }
  n.add("Exec", "LinkJournal", "try-guest");
  n.add("Network", "Zone", ctx.valueOr(`networkd.zone.${service}`, "") || null);
  const d = ctx.unitAt(`etc/systemd/system/${unitName}.d/10-migration.conf`, [`Rendered by ${ctx.rendererName}: runs ${base} from ${root}`]);
  d.add("Unit", "PartOf", `${stack}.target`);
  d.add("Unit", "ConditionHost", ctx.host);
  d.addEmpty("Service", "ExecStart");
  d.add("Service", "ExecStart", `systemd-nspawn --quiet --keep-unit --boot=no ${ddi ? "--image=" : "--mstack="}${root} --machine=%i --settings=override`);
  d.add("Service", "Slice", `stack-${stack}.slice`);
  ctx.expect("units", unitName);
  ctx.expect("machines", base);
  ctx.wantedByStack(stack, unitName);
  ctx.set(`machined:machine:${base}`, { nspawn: `etc/systemd/nspawn/${base}.nspawn`, unit: unitName });
  ctx.note(`${service}: rendered as machine ${base} (systemd-nspawn); review /etc/systemd/nspawn/${base}.nspawn and attach it to a zone with the networkd component`);
}
