// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The machined component: images and machines. It decides per host whether
// images are mounted as mount stacks (RootMStack=) or packed into
// discoverable disk images (RootImage=), records the image every instance
// needs so images.json and pull-images.sh know what to fetch, and renders
// the machine form (a .nspawn file plus a drop-in for
// systemd-nspawn@.service) or the vm form (a drop-in for
// systemd-vmspawn@.service over a bootable DDI) when the plan chose it for
// a service.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import type { Service } from "../../../contract/types.ts";
import { bytes, cpuQuota, imageName, octal, quote } from "../../../contract/unit.ts";
import { credentialNameFor, storeId } from "../../systemd-creds/scripts/component.ts";
import { STATE_DIR } from "../../systemd-storage/scripts/component.ts";

export const IMAGE_DIR = "machined.image_dir.estate";
export function rootFormId(host: string): string {
  return `machined.root_form.${host}`;
}

/** The networkd component's zone decision for a service; this component only reads it. */
function zoneDecisionId(service: string): string {
  return `networkd.zone.${service}`;
}

/** Where systemd-nspawn places the credentials it was passed, as the payload sees them. */
export const NSPAWN_CREDENTIALS_DIR = "/run/host/credentials";

/** A credential the machine loads: its name, the store the plan chose, and the unit directive that loads it. */
export interface MachineCredential {
  name: string;
  store: "credstore" | "credstore.encrypted";
}

/** What this component records per machine for the other components (the networkd component attaches ports to it). */
export interface MachineShape {
  base: string;
  unit: string;
  nspawn: string;
  dropin: string;
  stack: string;
  credentials: MachineCredential[];
  volumes: string[];
}

export function machineKey(base: string): string {
  return `machined:machine:${base}`;
}

function capName(name: string): string {
  const n = name.toUpperCase();
  if (n === "ALL") return "all";
  return n.startsWith("CAP_") ? n : `CAP_${n}`;
}

/** The uid part of a Docker `user` value (`1000`, `1000:1000`, `app`, `app:app`); null for root. */
function machineUser(user: string | null): string | null {
  if (!user) return null;
  const [u] = user.split(":");
  if (!u || u === "root" || u === "0") return null;
  return u;
}

export const machinedComponent: Component = {
  id: "machined",
  title: "Machines and images (systemd-nspawn, systemd-vmspawn, importctl, systemd.mstack, systemd.nspawn, machinectl)",
  covers: ["systemd-nspawn", "systemd.nspawn", "systemd-vmspawn", "importctl", "machinectl", "systemd-machined.service", "systemd-importd.service", "systemd-import-generator", "systemd.mstack", "systemd-mstack", "systemd.v", "vpick", "systemd-vpick", "systemd-dissect", "systemd-repart", "repart.d", "systemd-mountfsd.service", "systemd-nsresourced.service", "systemd-machine-tag@.service", "systemd.image-policy", "systemd.image-filter"],

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
    const tmpfiles = new Map<string, string[]>();
    const configs = new Map<string, { data: string | null; uid: string; gid: string; mode: number; stack: string }>();
    for (const inst of ctx.instances) {
      const svc = inst.service;
      const name = imageName(svc.image);
      const root = form === "ddi" ? `${imageDir}/${name}.raw` : `${imageDir}/${name}.mstack`;
      const entry = ctx.image(name, svc.image, svc.image_digest, svc.name);
      if (entry.ref !== svc.image) ctx.note(`image name ${name}: ${svc.image} and ${entry.ref} both map to it; pull one under another name and edit its root directive`, "decision");
      ctx.set(`machined:root:${svc.image}`, { root, kind: form === "ddi" ? "RootImage" : "RootMStack" });
      ctx.expect("images", root);
      if (form === "ddi") ctx.note(`${svc.name}: ${ctx.host} mounts images as disk images; build ${name}.raw with make-ddi.sh after pulling the mount stack`);
      if (inst.form === "machine") renderMachine(ctx, inst.base, inst.unit, inst.stack, svc, root, form === "ddi", tmpfiles, configs);
      // The bootable image gets its own name: <name>.raw is the application DDI make-ddi.sh builds for RootImage= hosts.
      if (inst.form === "vm") renderVm(ctx, inst.base, inst.unit, inst.stack, svc, `${imageDir}/${name}-vm.raw`, name, `${imageDir}/${name}.mstack`);
    }
    for (const [stack, lines] of [...tmpfiles].sort()) {
      ctx.file(`etc/tmpfiles.d/${stack}-machines.conf`, [`# Rendered by ${ctx.rendererName}: local volumes bound into the machines of stack ${stack}`, `# Type Path Mode User Group Age`, ...lines].join("\n") + "\n");
      ctx.install("pre", `systemd-tmpfiles --create '/etc/tmpfiles.d/${stack}-machines.conf' || true`);
    }
    for (const [cfg, c] of [...configs].sort()) {
      if (c.data !== null) ctx.file(`etc/${c.stack}/configs/${cfg}`, Buffer.from(c.data, "base64").toString("utf8"));
      ctx.install("pre", `chown '${c.uid}:${c.gid}' '/etc/${c.stack}/configs/${cfg}' && chmod '${octal(c.mode)}' '/etc/${c.stack}/configs/${cfg}'`);
    }
  },
};

/** The credentials a service carries (secrets and redacted environment) with the store the plan chose for each. */
function machineCredentials(ctx: RenderContext, svc: Service): { loaded: MachineCredential[]; envFile: { variable: string; name: string }[]; secrets: { name: string; target: string }[] } {
  const loaded: MachineCredential[] = [];
  const envFile: { variable: string; name: string }[] = [];
  const secrets: { name: string; target: string }[] = [];
  const load = (name: string): boolean => {
    const store = ctx.value(storeId(name));
    if (store === "external") {
      ctx.note(`${svc.name}: credential ${name} is fetched externally by decision; add the fetch step to systemd-nspawn@${svc.name}.service (ExecStartPre= or a credential provider) and pass it with --load-credential=`, "decision");
      return false;
    }
    if (!loaded.some((c) => c.name === name)) loaded.push({ name, store: store === "credstore" ? "credstore" : "credstore.encrypted" });
    return true;
  };
  for (const [k] of Object.entries(svc.env).sort()) {
    if (!svc.redacted_env.includes(k)) continue;
    const name = credentialNameFor(svc.name, k);
    if (load(name)) envFile.push({ variable: k, name });
  }
  for (const s of svc.secrets) {
    if (!load(s.name)) continue;
    secrets.push({ name: s.name, target: s.target.startsWith("/") ? s.target : `/run/secrets/${s.target}` });
  }
  return { loaded, envFile, secrets };
}

function renderMachine(
  ctx: RenderContext,
  base: string,
  unitName: string,
  stack: string,
  svc: Service,
  root: string,
  ddi: boolean,
  tmpfiles: Map<string, string[]>,
  configs: Map<string, { data: string | null; uid: string; gid: string; mode: number; stack: string }>,
): void {
  const service = svc.name;
  const inv = ctx.inventory;
  const image = (inv.images ?? []).find((i) => i.ref === svc.image);
  const stateDir = ctx.value(STATE_DIR).replace(/\/+$/, "");
  const volByName = new Map(inv.volumes.map((v) => [v.name, v]));
  const cfgByName = new Map(inv.configs.map((c) => [c.name, c]));
  const nspawnPath = `etc/systemd/nspawn/${base}.nspawn`;
  const dropinPath = `etc/systemd/system/${unitName}.d/10-migration.conf`;
  const n = ctx.unitAt(nspawnPath, [`Rendered by ${ctx.rendererName} from service ${service} (stack ${stack}) as a machine`]);
  const d = ctx.unitAt(dropinPath, [`Rendered by ${ctx.rendererName}: runs ${base} from ${root}`]);
  const creds = machineCredentials(ctx, svc);
  const user = machineUser(svc.user ?? image?.user ?? null);
  if ((svc.user ?? image?.user ?? "").includes(":")) ctx.note(`${service}: the group of user ${svc.user ?? image?.user} is not set on the machine; systemd-nspawn takes the group from the container's user database`);
  // Credentials are readable by a non-root payload only when nspawn runs it as PID 1 with no-new-privileges (systemd-nspawn(1), --uid=).
  const credsNeedPid1 = creds.loaded.length > 0 && user !== null;

  // [Exec]
  const argv = svc.command.length ? [...svc.command, ...svc.args] : [...(image?.entrypoint ?? []), ...(svc.args.length ? svc.args : (image?.cmd ?? []))];
  if (argv.length) n.add("Exec", "Parameters", argv.map(quote).join(" "));
  else ctx.note(`${service}: neither the service nor the inventoried image says what to run; set Parameters= in /etc/systemd/nspawn/${base}.nspawn by hand`, "decision");
  if (svc.init && credsNeedPid1) ctx.note(`${service}: ran under an init shim (ProcessTwo=yes) but loads credentials as user ${user}; systemd-nspawn can only make them readable when the payload is PID 1, so ProcessTwo= is left off and NoNewPrivileges=yes is set (systemd-nspawn(1), --uid=)`);
  n.add("Exec", "ProcessTwo", svc.init && !credsNeedPid1 ? "yes" : null);
  n.add("Exec", "PrivateUsers", "pick");
  n.add("Exec", "Hostname", svc.hostname);
  n.add("Exec", "WorkingDirectory", svc.workdir ?? image?.workdir ?? null);
  n.add("Exec", "User", user);
  for (const [k, v] of Object.entries({ ...image?.env, ...svc.env }).sort()) {
    if (svc.redacted_env.includes(k) || image?.redacted_env.includes(k)) continue;
    n.add("Exec", "Environment", quote(`${k}=${v}`));
  }
  for (const e of creds.envFile) {
    n.add("Exec", "Environment", quote(`${e.variable}_FILE=${NSPAWN_CREDENTIALS_DIR}/${e.name}`));
    ctx.note(`${service}: environment ${e.variable} was redacted at capture; the value is passed as credential ${e.name}, which the payload reads from ${NSPAWN_CREDENTIALS_DIR}/${e.name} or ${e.variable}_FILE`);
  }
  for (const s of creds.secrets) ctx.note(`${service}: secret ${s.name} was mounted at ${s.target} in the container; a machine receives it as a credential at ${NSPAWN_CREDENTIALS_DIR}/${s.name} ($CREDENTIALS_DIRECTORY), so the payload must read it from there`, "decision");
  const added = svc.cap_add.map(capName);
  const dropped = svc.cap_drop.map(capName);
  if (added.length) n.add("Exec", "Capability", added.join(" "));
  if (dropped.length) n.add("Exec", "DropCapability", dropped.join(" "));
  if (svc.privileged) ctx.note(`${service}: privileged is not rendered; the machine has systemd-nspawn's default capability set, add what the workload needs to Capability= in /etc/systemd/nspawn/${base}.nspawn`, "decision");
  n.add("Exec", "NoNewPrivileges", credsNeedPid1 ? "yes" : null);
  for (const ul of svc.ulimits) {
    const key = `Limit${ul.name.toUpperCase().replace(/^RLIMIT_/, "")}`;
    n.add("Exec", key, ul.soft === ul.hard ? String(ul.hard) : `${ul.soft}:${ul.hard}`);
  }
  n.add("Exec", "LinkJournal", "try-guest");

  // [Files]
  n.add("Files", "ReadOnly", svc.read_only ? "yes" : null);
  const volumes: string[] = [];
  let devices = false;
  for (const m of svc.mounts) {
    if (m.type === "volume" && m.source) {
      const vol = volByName.get(m.source);
      const remote = vol && ["nfs", "nfs4", "cifs"].includes((vol.options.type ?? "").toLowerCase());
      const where = `${stateDir}/${stack}/${m.source}`;
      n.add("Files", m.readonly ? "BindReadOnly" : "Bind", `${where}:${m.target}:idmap`);
      volumes.push(where);
      ctx.expect("volumes", where);
      if (remote) {
        ctx.note(`${service}: volume ${m.source} is remote (${vol!.options.type}); mount it at ${where} on ${ctx.host} before the machine starts (RequiresMountsFor= is set on the unit)`, "decision");
        d.add("Unit", "RequiresMountsFor", where);
      } else {
        const lines = tmpfiles.get(stack) ?? [];
        tmpfiles.set(stack, lines);
        const owner = user && /^[0-9]+$/.test(user) ? user : "-";
        const line = `d ${where} 0750 ${owner} ${owner} -`;
        if (!lines.includes(line)) lines.push(line);
        if (!vol) ctx.note(`${service}: volume ${m.source} was not inventoried on the capturing node; ${where} is created empty, copy the data before cutover`, "decision");
        else {
          const move = ctx.valueOr(`storage.move.${m.source}`, "");
          if (move) ctx.note(`${service}: volume ${m.source} moves by "${move}" (decision storage.move.${m.source}); the runbook step lands at ${where}`);
          else ctx.note(`${service}: how the data of volume ${m.source} reaches ${where} is undecided (storage.move.${m.source})`, "decision");
        }
      }
    } else if (m.type === "bind" && m.source) {
      if (m.source.startsWith("/dev/")) {
        devices = true;
        d.add("Service", "DeviceAllow", `${m.source} rw`);
        n.add("Files", "Bind", `${m.source}:${m.target}`);
      } else {
        n.add("Files", m.readonly ? "BindReadOnly" : "Bind", `${m.source}:${m.target}`);
        if (m.bind_propagation && m.bind_propagation !== "rprivate") ctx.note(`${service}: bind propagation ${m.bind_propagation} on ${m.target} is not rendered`);
      }
    } else if (m.type === "tmpfs") {
      const opts: string[] = [];
      if (m.tmpfs_size_bytes) opts.push(`size=${m.tmpfs_size_bytes}`);
      if (m.tmpfs_mode) opts.push(`mode=${octal(m.tmpfs_mode)}`);
      n.add("Files", "TemporaryFileSystem", `${m.target}${opts.length ? ":" + opts.join(",") : ""}`);
    } else if (m.type === "npipe") {
      ctx.note(`${service}: npipe mount ${m.target} has no Linux equivalent`);
    }
  }
  if (volumes.length) ctx.note(`${service}: volumes are bound with the idmap option so the machine's users own them as they did in the container; the source file system must support ID-mapped mounts (systemd-nspawn(1), --bind=)`);
  if (devices) ctx.note(`${service}: binds a device node; the drop-in allows it on systemd-nspawn@${base}.service, whose template runs with DevicePolicy=closed`);
  if (ctx.valueOr(`sysext.configs.${stack}`, "files") === "files") {
    for (const c of svc.configs) {
      const def = cfgByName.get(c.name);
      const target = c.target.startsWith("/") ? c.target : `/${c.target}`;
      n.add("Files", "BindReadOnly", `/etc/${stack}/configs/${c.name}:${target}`);
      configs.set(c.name, { data: def?.data_base64 ?? null, uid: c.uid, gid: c.gid, mode: c.mode, stack });
      if (!def?.data_base64) ctx.note(`${service}: config ${c.name} has no payload in the inventory; place it at /etc/${stack}/configs/${c.name} by hand`, "decision");
    }
  }
  if (svc.read_only && svc.mounts.length) ctx.note(`${service}: the root is read-only (ReadOnly=yes); every mount target (${svc.mounts.map((m) => m.target).join(", ")}) must already exist in the image, as systemd-nspawn cannot create it`);

  // [Network]: the zone the networkd component decided, or the host's namespace.
  const zone = ctx.valueOr(zoneDecisionId(service), "");
  if (zone === "host") n.add("Network", "Private", "no");
  else if (zone) n.add("Network", "Zone", zone);

  // The drop-in: the unit systemd-nspawn@.service instantiates, with the stack's grouping, the credentials, and the limits.
  d.add("Unit", "PartOf", `${stack}.target`);
  d.add("Unit", "ConditionHost", ctx.host);
  // No --boot: the payload runs as PID 1 (or PID 2 behind the stub init when ProcessTwo=yes), which is what a container command is.
  const exec = ["systemd-nspawn", "--quiet", "--keep-unit", `${ddi ? "--image=" : "--mstack="}${root}`, "--machine=%i", "--settings=override"];
  for (const c of creds.loaded) {
    d.add("Service", c.store === "credstore" ? "LoadCredential" : "LoadCredentialEncrypted", `${c.name}:/etc/${c.store}/${c.name}`);
    exec.push(`--load-credential=${c.name}:%d/${c.name}`);
    ctx.expect("credentials", c.name);
  }
  d.addEmpty("Service", "ExecStart");
  d.add("Service", "ExecStart", exec.join(" "));
  d.add("Service", "Slice", `stack-${stack}.slice`);
  d.add("Service", "CPUQuota", cpuQuota(svc.resources.limits.nano_cpus));
  d.add("Service", "MemoryMax", bytes(svc.resources.limits.memory_bytes));
  d.add("Service", "MemoryLow", bytes(svc.resources.reservations.memory_bytes));
  d.add("Service", "TasksMax", svc.resources.limits.pids ?? null);
  if (svc.healthcheck && svc.healthcheck.test.length && svc.healthcheck.test[0] !== "NONE") ctx.note(`${service}: the healthcheck (${svc.healthcheck.test.slice(1).join(" ")}) is not rendered for a machine; run it inside with machinectl shell ${base} from a timer, or let the payload use sd_notify`);

  ctx.expect("units", unitName);
  ctx.expect("machines", base);
  ctx.wantedByStack(stack, unitName);
  const shape: MachineShape = { base, unit: unitName, nspawn: nspawnPath, dropin: dropinPath, stack, credentials: creds.loaded, volumes };
  ctx.set(machineKey(base), shape);
  ctx.note(`${service}: rendered as machine ${base} (systemd-nspawn); review /etc/systemd/nspawn/${base}.nspawn${zone ? "" : " and attach it to a zone with the networkd component"}`);
}

function renderVm(ctx: RenderContext, base: string, unitName: string, stack: string, svc: Service, ddi: string, name: string, stackDir: string): void {
  const service = svc.name;
  const d = ctx.unitAt(`etc/systemd/system/${unitName}.d/10-migration.conf`, [`Rendered by ${ctx.rendererName}: runs ${base} as a virtual machine from ${ddi}`]);
  d.add("Unit", "PartOf", `${stack}.target`);
  d.add("Unit", "ConditionHost", ctx.host);
  d.add("Unit", "RequiresMountsFor", ddi.slice(0, ddi.lastIndexOf("/")));
  const exec = ["systemd-vmspawn", "--quiet", "--register=yes", "--keep-unit", "--network-tap", `--image=${ddi}`, "--machine=%i"];
  const cpus = svc.resources.limits.nano_cpus ? Math.max(1, Math.ceil(svc.resources.limits.nano_cpus / 1_000_000_000)) : null;
  if (cpus) exec.push(`--cpus=${cpus}`);
  const ram = bytes(svc.resources.limits.memory_bytes);
  if (ram) exec.push(`--ram=${ram}`);
  d.addEmpty("Service", "ExecStart");
  d.add("Service", "ExecStart", exec.join(" "));
  d.add("Service", "Slice", `stack-${stack}.slice`);
  ctx.expect("units", unitName);
  ctx.expect("machines", base);
  ctx.wantedByStack(stack, unitName);
  ctx.set(machineKey(base), { base, unit: unitName, nspawn: null, dropin: `etc/systemd/system/${unitName}.d/10-migration.conf`, stack, credentials: [], volumes: [] });
  ctx.note(`${service}: the plan runs it as a virtual machine; build the bootable DDI ${ddi} with make-vm-ddi.sh from ${stackDir} and the kernel and UKI you supply (see the systemd-machined skill), and give the guest a service that starts ${name}'s payload`, "decision");
  if (svc.secrets.length || svc.redacted_env.length) ctx.note(`${service}: credentials for a virtual machine are passed with --load-credential= on systemd-vmspawn once the guest's service reads them; add them to the drop-in like the machine form does`, "decision");
  if (svc.mounts.length) ctx.note(`${service}: mounts of a virtual machine are not rendered; systemd-vmspawn shares host directories with --bind= (virtiofs), add them to the drop-in`, "decision");
}
