#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Render an inventory into native systemd services: one .service per
// service instance with the image mounted as its root (RootMStack=, or
// RootImage= with --root-image), a target and a slice per stack, a health
// timer per healthcheck, encrypted credentials for secrets, mounts for
// network volumes, tmpfiles for local volumes, and an install script per
// host. Every translation the renderer cannot make faithfully is written to
// MIGRATION-NOTES.md.
//
//   bun render.ts inventory.json -o DIR [--host-map FILE] [--scale-out] [--root-image]
//                                       [--image-dir /var/lib/machines] [--state-dir /var/lib]
//
// Importable: render(inventory, options) returns files, per-host plans, and notes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImageConfig, Inventory, Service, Volume } from "../../../contract/types.ts";
import { durationToSeconds } from "../../../contract/types.ts";
import { placeService } from "../../../contract/placement.ts";
import { UnitFile, bytes, cpuQuota, escapeUnitPath, healthCommand, imageName, isPlainName, isPlainPath, octal, quote, shellQuote, unitBaseName } from "../../../contract/unit.ts";

export interface RenderOptions {
  hostMap?: Record<string, string[]>;
  scaleOut?: boolean;
  /** Write RootImage=IMAGE_DIR/NAME.raw instead of RootMStack=IMAGE_DIR/NAME.mstack, for hosts without mount stacks. */
  rootImage?: boolean;
  /** Where the images live on the hosts. */
  imageDir?: string;
  /** Where local volumes live on the hosts, under <stateDir>/<stack>/<volume>. */
  stateDir?: string;
}

export interface HostPlan {
  hostname: string;
  units: string[];
  targets: string[];
  slices: string[];
  timers: string[];
  mounts: string[];
  ports: { port: number; protocol: string }[];
  credentials: string[];
  images: string[];
  volumes: string[];
}

export interface ImageEntry {
  ref: string;
  digest: string | null;
  hosts: string[];
  services: string[];
}

export interface RenderResult {
  files: Record<string, string>;
  hosts: Record<string, HostPlan>;
  images: Record<string, ImageEntry>;
  notes: string[];
}

const RENDERER = "docker-image-to-service";

/** Docker's default capability set, for services that neither add nor drop anything. */
const DOCKER_DEFAULT_CAPS = [
  "CAP_AUDIT_WRITE",
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FOWNER",
  "CAP_FSETID",
  "CAP_KILL",
  "CAP_MKNOD",
  "CAP_NET_BIND_SERVICE",
  "CAP_NET_RAW",
  "CAP_SETFCAP",
  "CAP_SETGID",
  "CAP_SETPCAP",
  "CAP_SETUID",
  "CAP_SYS_CHROOT",
];

function cap(name: string): string {
  const n = name.toUpperCase();
  return n.startsWith("CAP_") ? n : `CAP_${n}`;
}

/** The bounding set a service gets from its cap_add and cap_drop lists. */
export function capabilitySet(svc: Service): { bounding: string[]; ambient: string[] } {
  const drop = svc.cap_drop.map(cap);
  const add = svc.cap_add.map(cap);
  let bounding = drop.includes("CAP_ALL") ? [] : DOCKER_DEFAULT_CAPS.filter((c) => !drop.includes(c));
  for (const a of add) if (a !== "CAP_ALL" && !bounding.includes(a)) bounding.push(a);
  if (add.includes("CAP_ALL")) bounding = ["~"];
  return { bounding, ambient: add.filter((a) => a !== "CAP_ALL") };
}

/** The command line a service runs: Swarm's override, else the image's entrypoint and cmd. */
export function commandLine(svc: Service, image: ImageConfig | undefined, notes: string[]): string[] {
  if (svc.command.length) return [...svc.command, ...svc.args];
  if (image) {
    if (image.entrypoint.length) return [...image.entrypoint, ...(svc.args.length ? svc.args : image.cmd)];
    if (svc.args.length) return svc.args;
    if (image.cmd.length) return image.cmd;
  }
  if (svc.args.length) {
    notes.push(`${svc.name}: the image's entrypoint is unknown (image not inventoried); ExecStart= runs the service args alone, prepend the entrypoint by hand`);
    return svc.args;
  }
  notes.push(`${svc.name}: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder that must be replaced before install`);
  return ["/bin/false"];
}

/** Systemd sees an absolute path first; an image command like "caddy" needs the image's PATH, which ExecSearchPath= supplies. */
function execLine(argv: string[], image: ImageConfig | undefined): { exec: string; searchPath: string | null } {
  const exec = argv.map(quote).join(" ");
  if (argv[0]!.startsWith("/")) return { exec, searchPath: null };
  const path = image?.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return { exec, searchPath: path };
}

function userGroup(user: string | null): { user: string | null; group: string | null; dynamic: boolean } {
  if (!user) return { user: null, group: null, dynamic: true };
  const [u, g] = user.split(":");
  return { user: u || null, group: g || null, dynamic: false };
}

function restartFor(svc: Service): string {
  switch (svc.restart_policy.condition) {
    case "any":
      return "always";
    case "on-failure":
      return "on-failure";
    default:
      return "no";
  }
}

function nfsWhat(v: Volume): { what: string; type: string; options: string } | null {
  const type = (v.options.type ?? "").toLowerCase();
  if (!type || type === "local") return null;
  const device = v.options.device ?? "";
  const o = (v.options.o ?? "").split(",").filter(Boolean);
  const addr = o.find((x) => x.startsWith("addr="))?.slice(5);
  const rest = o.filter((x) => !x.startsWith("addr="));
  let what = device;
  if ((type === "nfs" || type === "nfs4") && addr && device.startsWith(":")) what = `${addr}${device}`;
  else if (type === "cifs" && addr && !device.startsWith("//")) what = `//${addr}${device.startsWith("/") ? "" : "/"}${device}`;
  return { what, type, options: rest.join(",") };
}

export function render(inv: Inventory, opts: RenderOptions = {}): RenderResult {
  const imageDir = (opts.imageDir ?? "/var/lib/machines").replace(/\/+$/, "");
  const stateDir = (opts.stateDir ?? "/var/lib").replace(/\/+$/, "");
  // Paths, host names, and service names end up in unit names and in install.sh, which runs as root.
  for (const [flag, dir] of [["--image-dir", imageDir], ["--state-dir", stateDir]] as const) {
    if (!isPlainPath(dir)) throw new Error(`${flag} must be an absolute path of plain characters, got ${JSON.stringify(dir)}`);
  }
  for (const s of inv.services) if (!isPlainName(s.name)) throw new Error(`service name ${JSON.stringify(s.name)} cannot be used in unit and script names`);
  for (const n of inv.nodes) if (!isPlainName(n.hostname)) throw new Error(`hostname ${JSON.stringify(n.hostname)} cannot be used in script paths`);
  for (const v of inv.volumes) if (!isPlainName(v.name)) throw new Error(`volume name ${JSON.stringify(v.name)} cannot be used in paths`);
  for (const c of inv.configs) if (!isPlainName(c.name)) throw new Error(`config name ${JSON.stringify(c.name)} cannot be used in paths`);
  for (const s of inv.secrets) if (!isPlainName(s.name)) throw new Error(`secret name ${JSON.stringify(s.name)} cannot be used as a credential name`);
  const files: Record<string, string> = {};
  const hosts: Record<string, HostPlan> = {};
  const images: Record<string, ImageEntry> = {};
  const notes: string[] = [];
  const imageByRef = new Map((inv.images ?? []).map((i) => [i.ref, i]));
  const volByName = new Map(inv.volumes.map((v) => [v.name, v]));
  const cfgByName = new Map(inv.configs.map((c) => [c.name, c]));
  const stackOf = (svc: Service) => svc.stack ?? "nostack";

  const host = (name: string): HostPlan => {
    hosts[name] ??= { hostname: name, units: [], targets: [], slices: [], timers: [], mounts: [], ports: [], credentials: [], images: [], volumes: [] };
    return hosts[name]!;
  };
  const put = (hostname: string, rel: string, content: string) => {
    files[join("hosts", hostname, rel)] = content;
  };
  const pushUnique = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  // host -> stack -> units the target wants
  const stackUnits = new Map<string, Map<string, string[]>>();
  // host -> stack -> tmpfiles lines
  const tmpfiles = new Map<string, Map<string, string[]>>();
  // host -> stack -> sysctl lines
  const sysctls = new Map<string, Map<string, string[]>>();
  // host -> credential names the units load
  const credentials = new Map<string, Set<string>>();
  const credential = (hostname: string, name: string) => {
    const set = credentials.get(hostname) ?? new Set<string>();
    credentials.set(hostname, set);
    set.add(name);
  };
  // host -> config name -> {payload, uid, gid, mode}
  const configFiles = new Map<string, Map<string, { data: string | null; uid: string; gid: string; mode: number; stack: string }>>();
  const nested = <T,>(m: Map<string, Map<string, T[]>>, a: string, b: string): T[] => {
    const inner = m.get(a) ?? new Map<string, T[]>();
    m.set(a, inner);
    const list = inner.get(b) ?? [];
    inner.set(b, list);
    return list;
  };

  // Image names must be unique; two references with the same name are an error the operator has to resolve.
  for (const svc of inv.services) {
    const name = imageName(svc.image);
    const entry = (images[name] ??= { ref: svc.image, digest: svc.image_digest, hosts: [], services: [] });
    if (entry.ref !== svc.image) notes.push(`image name ${name}: ${svc.image} and ${entry.ref} both map to it; pull one under another name and edit its RootMStack=`);
    pushUnique(entry.services, svc.name);
    if (!entry.digest && svc.image_digest) entry.digest = svc.image_digest;
  }

  for (const svc of [...inv.services].sort((a, b) => a.name.localeCompare(b.name))) {
    const placement = placeService(svc, inv.nodes, opts, notes);
    const stack = stackOf(svc);
    const image = imageByRef.get(svc.image);
    const iname = imageName(svc.image);
    const root = opts.rootImage ? `${imageDir}/${iname}.raw` : `${imageDir}/${iname}.mstack`;
    const isJob = svc.mode.endsWith("job");
    if (svc.ports.some((p) => p.mode === "ingress")) notes.push(`${svc.name}: ingress-mode ports are published in host mode on every host that runs it; front them with a load balancer, DNS round robin, or a VIP (see the translation map)`);
    if (svc.update_config) notes.push(`${svc.name}: update_config (${svc.update_config.order}, parallelism ${svc.update_config.parallelism}, on failure ${svc.update_config.failure_action}) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback`);
    if (svc.rollback_config) notes.push(`${svc.name}: rollback_config is a runbook step; the previous image version stays pullable under its own name`);
    if (svc.privileged) notes.push(`${svc.name}: privileged is not rendered; the unit has Docker's default capability set, add what the workload needs to CapabilityBoundingSet= and AmbientCapabilities=`);
    if (svc.logging.driver && !["json-file", "journald", "local"].includes(svc.logging.driver)) notes.push(`${svc.name}: log driver ${svc.logging.driver} rendered as the journal`);
    if (svc.endpoint_mode === "vip" && svc.networks.length) notes.push(`${svc.name}: the Swarm VIP becomes one address per host; other services reach it by the host's address or a name the plan provides`);
    const crossHost = svc.networks.map((n) => inv.networks.find((x) => x.name === n.name || x.id === n.name)).filter((n) => n && n.driver === "overlay" && !n.ingress);
    if (crossHost.length) notes.push(`${svc.name}: attached to overlay ${crossHost.map((n) => n!.name).join(", ")}; native services share the host network namespace, so container-network addressing and aliases do not apply until docker-network-to-networkd renders the bridges`);
    const droppedLabels = Object.keys(svc.labels).filter((k) => !k.startsWith("com.docker."));
    if (droppedLabels.length) notes.push(`${svc.name}: service labels not rendered: ${droppedLabels.join(", ")}`);
    if (svc.hostname) notes.push(`${svc.name}: hostname ${svc.hostname} is not applied; a native service keeps the host's name (an nspawn machine can set it)`);
    if (svc.dns.nameservers.length || svc.dns.search.length) notes.push(`${svc.name}: per-service DNS settings are not applied to a native service; configure them on the host's resolver`);

    for (const [hostname, count] of placement) {
      const plan = host(hostname);
      const imgEntry = images[iname]!;
      pushUnique(imgEntry.hosts, hostname);
      pushUnique(plan.images, `${root}`);
      for (let i = 1; i <= count; i++) {
        const base = unitBaseName(svc.name, i, count);
        const unitName = `${base}.service`;
        const u = new UnitFile([
          `Rendered by ${RENDERER} from swarm service ${svc.name} (stack ${svc.stack ?? "none"}, mode ${svc.mode})`,
          `The image is the service's root; see the [X-Migration] section for its origin.`,
        ]);
        u.add("Unit", "Description", `${svc.name} (migrated from Docker Swarm stack ${stack})`);
        u.add("Unit", "PartOf", `${stack}.target`);
        u.add("Unit", "After", "network-online.target");
        u.add("Unit", "Wants", "network-online.target");
        u.add("Unit", "ConditionHost", hostname);
        if (svc.restart_policy.max_attempts) u.add("Unit", "StartLimitBurst", svc.restart_policy.max_attempts);
        const window = durationToSeconds(svc.restart_policy.window);
        if (window) u.add("Unit", "StartLimitIntervalSec", Math.round(window));
        if (opts.rootImage) u.add("Unit", "RequiresMountsFor", imageDir);

        u.add("Service", "Type", isJob ? "oneshot" : "exec");
        u.add("Service", "Slice", `stack-${stack}.slice`);
        u.add("Service", opts.rootImage ? "RootImage" : "RootMStack", root);
        u.add("Service", "MountAPIVFS", "yes");
        u.add("Service", "PrivateTmp", svc.mounts.some((m) => m.type === "tmpfs" && m.target === "/tmp") ? null : "yes");
        u.add("Service", "PrivateDevices", svc.mounts.some((m) => m.type === "bind" && (m.source ?? "").startsWith("/dev/")) ? null : "yes");
        u.add("Service", "ProtectSystem", svc.read_only ? "strict" : null);
        u.add("Service", "ProtectProc", "invisible");
        u.add("Service", "ProtectKernelTunables", Object.keys(svc.sysctls).length ? null : "yes");
        u.add("Service", "PrivateUsers", "self");

        const argv = commandLine(svc, image, notes);
        const { exec, searchPath } = execLine(argv, image);
        u.add("Service", "ExecSearchPath", searchPath);
        u.add("Service", "ExecStart", exec);
        u.add("Service", "WorkingDirectory", svc.workdir ?? image?.workdir ?? null);
        const ug = userGroup(svc.user ?? image?.user ?? null);
        if (ug.dynamic) u.add("Service", "DynamicUser", "yes");
        if (ug.dynamic) notes.push(`${svc.name}: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes`);
        else {
          u.add("Service", "User", ug.user);
          u.add("Service", "Group", ug.group);
        }

        // Environment: the image's own variables first (PATH is handled by ExecSearchPath=), then the service's.
        const envLines: string[] = [];
        const redactedImage = image?.redacted_env ?? [];
        for (const [k, v] of Object.entries(image?.env ?? {}).sort()) {
          if (k === "PATH" || k in svc.env) continue;
          if (redactedImage.includes(k)) {
            notes.push(`${svc.name}: image environment ${k} was redacted at capture; it is not rendered`);
            continue;
          }
          envLines.push(`${k}=${v}`);
        }
        for (const [k, v] of Object.entries(svc.env).sort()) {
          if (svc.redacted_env.includes(k)) {
            const credName = `${svc.name}-${k.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            u.add("Service", "LoadCredentialEncrypted", `${credName}:/etc/credstore.encrypted/${credName}`);
            credential(hostname, credName);
            pushUnique(plan.credentials, credName);
            notes.push(`${svc.name}: environment ${k} was redacted at capture; the value is loaded as credential ${credName} at %d/${credName}, and the process must read it from there or from ${k}_FILE`);
            envLines.push(`${k}_FILE=%d/${credName}`);
          } else {
            envLines.push(`${k}=${v}`);
          }
        }
        if (envLines.length > 6) {
          put(hostname, `etc/${stack}/${base}.env`, envLines.join("\n") + "\n");
          u.add("Service", "EnvironmentFile", `/etc/${stack}/${base}.env`);
          notes.push(`${svc.name}: environment written to /etc/${stack}/${base}.env; install.sh sets mode 0600`);
        } else {
          for (const line of envLines) u.add("Service", "Environment", quote(line));
        }

        // Secrets become credentials; the file also appears where Docker put it.
        for (const s of svc.secrets) {
          u.add("Service", "LoadCredentialEncrypted", `${s.name}:/etc/credstore.encrypted/${s.name}`);
          const target = s.target.startsWith("/") ? s.target : `/run/secrets/${s.target}`;
          u.add("Service", "BindReadOnlyPaths", `%d/${s.name}:${target}`);
          credential(hostname, s.name);
          pushUnique(plan.credentials, s.name);
          if (s.uid !== "0" || s.gid !== "0") notes.push(`${svc.name}: secret ${s.name} was owned by ${s.uid}:${s.gid} in the container; credentials are readable by the service user only, which is what the mode asked for`);
        }
        // Configs are files under /etc/<stack>/configs/.
        for (const c of svc.configs) {
          const def = cfgByName.get(c.name);
          const target = c.target.startsWith("/") ? c.target : `/${c.target}`;
          u.add("Service", "BindReadOnlyPaths", `/etc/${stack}/configs/${c.name}:${target}`);
          const map = configFiles.get(hostname) ?? new Map();
          configFiles.set(hostname, map);
          map.set(c.name, { data: def?.data_base64 ?? null, uid: c.uid, gid: c.gid, mode: c.mode, stack });
          if (!def?.data_base64) notes.push(`${svc.name}: config ${c.name} has no payload in the inventory; place it at /etc/${stack}/configs/${c.name} by hand`);
        }

        // Mounts.
        for (const m of svc.mounts) {
          if (m.type === "volume" && m.source) {
            const vol = volByName.get(m.source);
            const remote = vol ? nfsWhat(vol) : null;
            const where = `${stateDir}/${stack}/${m.source}`;
            if (remote) {
              const unit = `${escapeUnitPath(where)}.mount`;
              const mu = new UnitFile([`Rendered by ${RENDERER} from swarm volume ${m.source} (driver ${vol!.driver}, type ${remote.type})`]);
              mu.add("Unit", "Description", `${m.source} (swarm volume, ${remote.type})`);
              mu.add("Unit", "After", "network-online.target");
              mu.add("Unit", "Wants", "network-online.target");
              mu.add("Mount", "What", remote.what);
              mu.add("Mount", "Where", where);
              mu.add("Mount", "Type", remote.type);
              mu.add("Mount", "Options", remote.options || null);
              mu.add("Install", "WantedBy", `${stack}.target`);
              put(hostname, `etc/systemd/system/${unit}`, mu.render());
              pushUnique(plan.mounts, unit);
              u.add("Unit", "RequiresMountsFor", where);
            } else {
              const owner = ug.dynamic ? "-" : (ug.user ?? "-");
              const group = ug.dynamic ? "-" : (ug.group ?? owner);
              const line = `d ${where} 0750 ${owner} ${group} -`;
              const lines = nested(tmpfiles, hostname, stack);
              if (!lines.includes(line)) lines.push(line);
              if (ug.dynamic) notes.push(`${svc.name}: volume ${m.source} at ${where} is created for a DynamicUser= service; StateDirectory= would be the native shape if the path can move under /var/lib/${base}`);
              if (!vol) notes.push(`${svc.name}: volume ${m.source} was not inventoried on the capturing node; ${where} is created empty, copy the data before cutover`);
            }
            pushUnique(plan.volumes, where);
            u.add("Service", m.readonly ? "BindReadOnlyPaths" : "BindPaths", `${where}:${m.target}`);
          } else if (m.type === "bind" && m.source) {
            if (m.source.startsWith("/dev/")) {
              u.add("Service", "DeviceAllow", `${m.source} rw`);
              u.add("Service", "BindPaths", `${m.source}:${m.target}`);
            } else {
              u.add("Service", m.readonly ? "BindReadOnlyPaths" : "BindPaths", `${m.source}:${m.target}`);
              if (m.bind_propagation && m.bind_propagation !== "rprivate") notes.push(`${svc.name}: bind propagation ${m.bind_propagation} on ${m.target} is not rendered`);
            }
          } else if (m.type === "tmpfs") {
            const tmpOpts: string[] = [];
            if (m.tmpfs_size_bytes) tmpOpts.push(`size=${m.tmpfs_size_bytes}`);
            if (m.tmpfs_mode) tmpOpts.push(`mode=${octal(m.tmpfs_mode)}`);
            u.add("Service", "TemporaryFileSystem", `${m.target}${tmpOpts.length ? ":" + tmpOpts.join(",") : ""}`);
          } else if (m.type === "npipe") {
            notes.push(`${svc.name}: npipe mount ${m.target} has no Linux equivalent`);
          }
        }
        if (u.has("Service") && svc.mounts.some((m) => m.type === "bind" && (m.source ?? "").startsWith("/dev/"))) u.add("Service", "DevicePolicy", "closed");

        // Ports: the service binds them itself; the unit restricts what it may bind.
        for (const p of svc.ports) {
          const published = p.published ?? p.target;
          const port = count > 1 ? published + (i - 1) : published;
          if (port !== p.target) notes.push(`${svc.name}: published port ${port} differs from the container port ${p.target}; a native service listens on the port the process opens, so configure the process to listen on ${port} or front it`);
          u.add("Service", "SocketBindAllow", `${p.protocol}:${port}`);
          plan.ports.push({ port, protocol: p.protocol });
          if (count > 1) notes.push(`${svc.name}: instance ${i} publishes ${port} instead of ${published} because several instances share ${hostname}`);
        }
        if (svc.ports.length) u.add("Service", "SocketBindDeny", "any");
        for (const eh of svc.extra_hosts) notes.push(`${svc.name}: extra host "${eh}" must be added to the host's /etc/hosts or the resolver`);

        // Resources.
        u.add("Service", "CPUQuota", cpuQuota(svc.resources.limits.nano_cpus));
        u.add("Service", "MemoryMax", bytes(svc.resources.limits.memory_bytes));
        u.add("Service", "MemoryLow", bytes(svc.resources.reservations.memory_bytes));
        u.add("Service", "TasksMax", svc.resources.limits.pids ?? null);
        if (svc.resources.reservations.nano_cpus) u.add("Service", "CPUWeight", Math.min(10000, Math.max(1, Math.round(svc.resources.reservations.nano_cpus / 10_000_000))));

        // Security.
        const caps = capabilitySet(svc);
        if (caps.bounding.length) u.add("Service", "CapabilityBoundingSet", caps.bounding.join(" "));
        else u.addEmpty("Service", "CapabilityBoundingSet");
        if (caps.ambient.length) u.add("Service", "AmbientCapabilities", caps.ambient.join(" "));
        // Ambient capabilities are raised before exec and coexist with NoNewPrivileges=, so it is always set.
        u.add("Service", "NoNewPrivileges", "yes");
        u.add("Service", "RestrictSUIDSGID", "yes");
        u.add("Service", "LockPersonality", "yes");

        for (const ul of svc.ulimits) {
          const key = `Limit${ul.name.toUpperCase().replace(/^RLIMIT_/, "")}`;
          u.add("Service", key, ul.soft === ul.hard ? String(ul.hard) : `${ul.soft}:${ul.hard}`);
        }
        if (Object.keys(svc.sysctls).length) {
          const lines = nested(sysctls, hostname, stack);
          for (const [k, v] of Object.entries(svc.sysctls).sort()) {
            const line = `${k} = ${v}`;
            if (!lines.includes(line)) lines.push(line);
          }
          notes.push(`${svc.name}: sysctls ${Object.keys(svc.sysctls).join(", ")} apply to the whole host from /etc/sysctl.d/90-${stack}.conf, not to the service alone`);
        }

        // Lifecycle.
        u.add("Service", "Restart", isJob ? null : restartFor(svc));
        const delay = durationToSeconds(svc.restart_policy.delay);
        if (delay) u.add("Service", "RestartSec", Math.round(delay));
        const grace = durationToSeconds(svc.stop_grace_period);
        if (grace) u.add("Service", "TimeoutStopSec", Math.round(grace));
        u.add("Service", "KillSignal", svc.stop_signal);
        u.add("Service", "KillMode", "mixed");
        u.add("Service", "SyslogIdentifier", base);
        u.add("Service", "LogExtraFields", `SWARM_STACK=${stack} SWARM_SERVICE=${svc.name}`);

        // Healthcheck: a timer runs the command in the same root; failure restarts the service.
        const health = svc.healthcheck ? healthCommand(svc.healthcheck.test) : null;
        if (health) {
          const hs = new UnitFile([`Rendered by ${RENDERER}: healthcheck of swarm service ${svc.name}, run by ${base}-health.timer`]);
          hs.add("Unit", "Description", `healthcheck for ${base}`);
          hs.add("Unit", "After", unitName);
          hs.add("Unit", "BindsTo", unitName);
          hs.add("Unit", "OnFailure", `${base}-restart.service`);
          hs.add("Service", "Type", "oneshot");
          hs.add("Service", "Slice", `stack-${stack}.slice`);
          hs.add("Service", opts.rootImage ? "RootImage" : "RootMStack", root);
          hs.add("Service", "MountAPIVFS", "yes");
          hs.add("Service", "PrivateUsers", "self");
          hs.add("Service", "ExecSearchPath", searchPath);
          const retries = svc.healthcheck!.retries ?? 3;
          const timeout = Math.round(durationToSeconds(svc.healthcheck!.timeout) ?? 30);
          hs.add("Service", "ExecStart", `/bin/sh -c ${quote(`for i in $(seq ${retries}); do if ( ${health} ); then exit 0; fi; sleep 1; done; exit 1`)}`);
          hs.add("Service", "TimeoutStartSec", (timeout + 1) * retries);
          hs.add("Service", "SyslogIdentifier", `${base}-health`);
          put(hostname, `etc/systemd/system/${base}-health.service`, hs.render());
          const ht = new UnitFile([`Rendered by ${RENDERER}: healthcheck schedule of swarm service ${svc.name}`]);
          ht.add("Unit", "Description", `healthcheck timer for ${base}`);
          ht.add("Unit", "PartOf", unitName);
          ht.add("Unit", "After", unitName);
          const start = Math.round(durationToSeconds(svc.healthcheck!.start_period) ?? 0);
          const interval = Math.round(durationToSeconds(svc.healthcheck!.interval) ?? 30);
          ht.add("Timer", "OnActiveSec", Math.max(start, 1));
          ht.add("Timer", "OnUnitActiveSec", interval);
          ht.add("Timer", "Unit", `${base}-health.service`);
          ht.add("Timer", "AccuracySec", "1s");
          put(hostname, `etc/systemd/system/${base}-health.timer`, ht.render());
          const hr = new UnitFile([`Rendered by ${RENDERER}: restarts swarm service ${svc.name} after ${retries} failed healthchecks`]);
          hr.add("Unit", "Description", `restart ${base} after a failed healthcheck`);
          hr.add("Service", "Type", "oneshot");
          hr.add("Service", "ExecStart", `systemctl restart ${unitName}`);
          put(hostname, `etc/systemd/system/${base}-restart.service`, hr.render());
          u.add("Unit", "Wants", `${base}-health.timer`);
          pushUnique(plan.timers, `${base}-health.timer`);
          pushUnique(plan.units, `${base}-health.service`);
          pushUnique(plan.units, `${base}-restart.service`);
          notes.push(`${svc.name}: the healthcheck runs from ${base}-health.timer every ${interval}s and restarts the service after ${retries} consecutive failures; Swarm's start_period becomes the timer's first delay`);
        }

        u.add("X-Migration", "Source", "docker-swarm");
        u.add("X-Migration", "Stack", svc.stack ?? "");
        u.add("X-Migration", "Service", svc.name);
        u.add("X-Migration", "Image", svc.image);
        u.add("X-Migration", "ImageDigest", svc.image_digest ?? "");
        u.add("X-Migration", "ImageName", iname);
        u.add("X-Migration", "Renderer", RENDERER);

        put(hostname, `etc/systemd/system/${unitName}`, u.render());
        pushUnique(plan.units, unitName);
        nested(stackUnits, hostname, stack).push(unitName);
      }
    }
  }

  // Per host: stack targets and slices, tmpfiles, sysctl, configs, credentials, expected.json, install.sh.
  for (const plan of Object.values(hosts)) {
    const stacks = stackUnits.get(plan.hostname) ?? new Map();
    for (const [stack, units] of [...stacks].sort()) {
      const t = new UnitFile([`Rendered by ${RENDERER}: groups the units of swarm stack ${stack} on ${plan.hostname}`]);
      t.add("Unit", "Description", `swarm stack ${stack}`);
      t.addAll("Unit", "Wants", units.sort());
      t.addAll("Unit", "Wants", (plan.mounts ?? []).filter((m) => m.startsWith(escapeUnitPath(`${stateDir}/${stack}`))));
      t.add("Install", "WantedBy", "multi-user.target");
      put(plan.hostname, `etc/systemd/system/${stack}.target`, t.render());
      pushUnique(plan.targets, `${stack}.target`);
      const s = new UnitFile([`Rendered by ${RENDERER}: resource group of swarm stack ${stack} on ${plan.hostname}`]);
      s.add("Unit", "Description", `swarm stack ${stack} slice`);
      s.add("Slice", "MemoryAccounting", "yes");
      s.add("Slice", "TasksAccounting", "yes");
      put(plan.hostname, `etc/systemd/system/stack-${stack}.slice`, s.render());
      pushUnique(plan.slices, `stack-${stack}.slice`);
    }
    for (const [stack, lines] of [...(tmpfiles.get(plan.hostname) ?? new Map())].sort()) {
      put(plan.hostname, `etc/tmpfiles.d/${stack}.conf`, [`# Rendered by ${RENDERER}: local volumes of swarm stack ${stack}`, `# Type Path Mode User Group Age`, ...lines].join("\n") + "\n");
    }
    for (const [stack, lines] of [...(sysctls.get(plan.hostname) ?? new Map())].sort()) {
      put(plan.hostname, `etc/sysctl.d/90-${stack}.conf`, [`# Rendered by ${RENDERER}: sysctls the services of swarm stack ${stack} set; they apply to the whole host`, ...lines].join("\n") + "\n");
    }
    const cfgs = configFiles.get(plan.hostname) ?? new Map();
    const cfgManifest: string[] = [];
    for (const [name, c] of [...cfgs].sort()) {
      if (c.data !== null) put(plan.hostname, `etc/${c.stack}/configs/${name}`, Buffer.from(c.data, "base64").toString("utf8"));
      cfgManifest.push(`${c.stack}/configs/${name} ${c.uid} ${c.gid} ${octal(c.mode)}`);
    }
    put(plan.hostname, "secrets/import-credentials.sh", importScript([...(credentials.get(plan.hostname) ?? [])].sort()));
    put(plan.hostname, "install.sh", installScript(plan, cfgManifest, [...stacks.keys()].sort()));
    put(plan.hostname, "expected.json", JSON.stringify({ ...plan, root_kind: opts.rootImage ? "RootImage" : "RootMStack" }, null, 2) + "\n");
  }
  files["images.json"] = JSON.stringify(Object.fromEntries(Object.entries(images).sort()), null, 2) + "\n";
  files["expected.json"] = JSON.stringify(hosts, null, 2) + "\n";
  files["MIGRATION-NOTES.md"] = notesDocument(inv, hosts, images, notes, opts);
  return { files, hosts, images, notes };
}

function importScript(names: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "# SPDX-License-Identifier: LGPL-2.1-or-later",
    `# Rendered by ${RENDERER}. Encrypts each secret value into a systemd credential`,
    "# that the units load with LoadCredentialEncrypted=. Values are read from one",
    "# file per credential under /etc/swarm-migration/secrets/ (root-only, mode",
    "# 0600), which the operator fills from the old cluster; nothing here prints one.",
    "set -euo pipefail",
    'src="${1:-/etc/swarm-migration/secrets}"',
    'dst="/etc/credstore.encrypted"',
    '[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }',
    'install -d -m 0700 "$dst"',
    "missing=0",
    `for name in ${names.map(shellQuote).join(" ")}; do`,
    '    if [ ! -f "$src/$name" ]; then echo "missing $src/$name" >&2; missing=$((missing + 1)); continue; fi',
    '    systemd-creds encrypt --name="$name" "$src/$name" "$dst/$name"',
    '    chmod 0600 "$dst/$name"',
    '    echo "encrypted $name"',
    "done",
    '[ "$missing" -eq 0 ] || { echo "$missing credential(s) missing" >&2; exit 1; }',
    "",
  ].join("\n");
}

function installScript(plan: HostPlan, cfgManifest: string[], stacks: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "# SPDX-License-Identifier: LGPL-2.1-or-later",
    `# Rendered by ${RENDERER} for ${plan.hostname}. Copies the rendered tree into place,`,
    "# fixes ownership and modes, reloads the manager, verifies the units, and",
    "# optionally starts the stack targets. Pull the images first (pull-images.sh)",
    "# and import the credentials (secrets/import-credentials.sh).",
    "set -euo pipefail",
    'here="$(cd "$(dirname "$0")" && pwd)"',
    '[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }',
    `[ "$(hostname)" = ${shellQuote(plan.hostname)} ] || echo "warning: this tree was rendered for ${plan.hostname}, not $(hostname)" >&2`,
    "for image in " + plan.images.map(shellQuote).join(" ") + "; do",
    '    [ -e "$image" ] || echo "warning: $image is not present; run pull-images.sh" >&2',
    "done",
    'cp -a "$here/etc/." /etc/',
    ...(cfgManifest.length
      ? ["while read -r path uid gid mode; do", '    chown "$uid:$gid" "/etc/$path"', '    chmod "$mode" "/etc/$path"', `done <<'MANIFEST'`, ...cfgManifest, "MANIFEST"]
      : []),
    ...stacks.map((s) => `find ${shellQuote(`/etc/${s}`)} -maxdepth 1 -name '*.env' -exec chmod 0600 {} + 2>/dev/null || true`),
    "systemd-tmpfiles --create " + stacks.map((s) => shellQuote(`/etc/tmpfiles.d/${s}.conf`)).join(" ") + " || true",
    "sysctl --system >/dev/null || true",
    "systemctl daemon-reload",
    `systemd-analyze verify ${[...plan.units, ...plan.timers, ...plan.mounts, ...plan.targets].map((u) => shellQuote(`/etc/systemd/system/${u}`)).join(" ")}`,
    'if [ "${1:-}" = "--start" ]; then',
    `    systemctl enable --now ${plan.targets.map(shellQuote).join(" ")}`,
    "else",
    `    echo "installed; start with: systemctl enable --now ${plan.targets.join(" ")}"`,
    "fi",
    "",
  ].join("\n");
}

function notesDocument(inv: Inventory, hosts: Record<string, HostPlan>, images: Record<string, ImageEntry>, notes: string[], opts: RenderOptions): string {
  const lines: string[] = [];
  lines.push("# Migration notes (native services)");
  lines.push("");
  lines.push(`Rendered by ${RENDERER} from an inventory captured ${inv.captured_at} (${inv.services.length} services, ${inv.nodes.length} nodes). Each service runs as a systemd service whose root is its image, mounted with ${opts.rootImage ? "RootImage=" : "RootMStack="}; there is no container runtime on the hosts.`);
  lines.push("");
  lines.push("## Host plan");
  lines.push("");
  lines.push("| Host | Units | Timers | Mounts | Ports | Credentials | Images |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const h of Object.values(hosts).sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    lines.push(`| ${h.hostname} | ${h.units.filter((u) => !u.endsWith("-health.service") && !u.endsWith("-restart.service")).join(", ")} | ${h.timers.length} | ${h.mounts.length} | ${h.ports.map((p) => `${p.port}/${p.protocol}`).join(", ") || "none"} | ${h.credentials.length} | ${h.images.length} |`);
  }
  lines.push("");
  lines.push("## Images to pull");
  lines.push("");
  lines.push("| Local name | Reference | Digest recorded by the swarm | Hosts |");
  lines.push("|---|---|---|---|");
  for (const [name, e] of Object.entries(images).sort()) lines.push(`| ${name} | ${e.ref} | ${e.digest ?? "none (tag not pinned)"} | ${e.hosts.join(", ")} |`);
  lines.push("");
  lines.push("`images.json` next to this file drives `pull-images.sh` from the oci-image-to-mstack skill.");
  lines.push("");
  lines.push("## Needs a human decision");
  lines.push("");
  const decisions = notes.filter((n) => /ingress|privileged|placeholder|entrypoint|VIP|overlay|both map to it|no payload|not inventoried|differs from the container port/.test(n));
  const rest = notes.filter((n) => !decisions.includes(n));
  if (decisions.length === 0) lines.push("None.");
  for (const n of new Set(decisions)) lines.push(`- ${n}`);
  lines.push("");
  lines.push("## Translations to review");
  lines.push("");
  if (rest.length === 0) lines.push("None.");
  for (const n of new Set(rest)) lines.push(`- ${n}`);
  lines.push("");
  lines.push("## Carried over from the capture");
  lines.push("");
  if (inv.warnings.length === 0) lines.push("None.");
  for (const w of inv.warnings) lines.push(`- ${w}`);
  lines.push("");
  return lines.join("\n");
}

export function writeResult(result: RenderResult, outDir: string): void {
  for (const [rel, content] of Object.entries(result.files)) {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, { mode: rel.endsWith(".sh") ? 0o755 : rel.includes("/secrets/") || rel.endsWith(".env") ? 0o600 : 0o644 });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let inventoryPath: string | null = null;
  let outDir = "rendered-native";
  const opts: RenderOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "--output") outDir = args[++i]!;
    else if (a === "--host-map") opts.hostMap = JSON.parse(readFileSync(args[++i]!, "utf8"));
    else if (a === "--scale-out") opts.scaleOut = true;
    else if (a === "--root-image") opts.rootImage = true;
    else if (a === "--image-dir") opts.imageDir = args[++i];
    else if (a === "--state-dir") opts.stateDir = args[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: render.ts inventory.json -o DIR [--host-map FILE] [--scale-out] [--root-image] [--image-dir DIR] [--state-dir DIR]");
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    } else inventoryPath = a;
  }
  if (!inventoryPath) {
    console.error("inventory.json is required");
    process.exit(2);
  }
  const inv = JSON.parse(readFileSync(inventoryPath, "utf8")) as Inventory;
  const result = render(inv, opts);
  writeResult(result, outDir);
  const units = Object.values(result.hosts).reduce((n, h) => n + h.units.length, 0);
  console.log(`rendered ${units} units across ${Object.keys(result.hosts).length} hosts into ${outDir}`);
  console.log(`read ${join(outDir, "MIGRATION-NOTES.md")} before installing anything`);
}
