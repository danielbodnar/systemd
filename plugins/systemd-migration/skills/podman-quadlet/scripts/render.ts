#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// render.ts: turn a swarm inventory into per-host Podman Quadlet units.
//
// Usage:
//   bun render.ts <inventory.json> -o <outdir> [--host-map map.json] [--scale-out]
//                 [--auto-update] [--unit-dir DIR] [--config-dir DIR] [--selinux]
//
// The renderer is deterministic and side-effect free apart from writing the
// output tree. It never emits secret values: secrets become Podman `Secret=`
// references plus an import script the operator feeds from a secure source.
//
// The per-object renderers (renderContainer, networkUnit, volumeUnit,
// synthesizedVolumeUnit, importScript) are exported so the quadlet
// component (component.ts) can render one service on one host through the
// compose engine; render() composes the same functions into the standalone
// tree.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Inventory, Network, Service, Volume } from "../../../contract/types.ts";
import { durationToSeconds } from "../../../contract/types.ts";
import { nodeMatchesPlatform, nodeSatisfies, parseConstraint, placeService } from "../../../contract/placement.ts";
import { UnitFile, cpuQuota, healthCommand, isPlainName, isPlainPath, octal, quote, shellQuote } from "../../../contract/unit.ts";

export { nodeMatchesPlatform, nodeSatisfies, parseConstraint, placeService };

/** The options that change how one .container file is rendered. */
export interface ContainerOptions {
  autoUpdate?: boolean;
  unitDir?: string;
  configDir?: string;
  selinux?: boolean;
}

export interface RenderOptions extends ContainerOptions {
  outDir: string;
  hostMap?: Record<string, string[]>;
  scaleOut?: boolean;
}

export interface HostPlan {
  hostname: string;
  units: string[];
  containers: string[];
  ports: { port: number; protocol: string }[];
  networks: string[];
  volumes: string[];
  secrets: string[];
  targets: string[];
}

export interface RenderResult {
  files: Record<string, string | Uint8Array>;
  hosts: Record<string, HostPlan>;
  notes: string[];
}

/** One rendered .container file and what the host must provide for it. */
export interface ContainerRender {
  /** `web_app` or `web_app-2`; Podman's generator turns the file into `<unitName>.service`. */
  unitName: string;
  /** The .container text. */
  text: string;
  /** Podman secrets the unit references, in order of appearance; `env` ones stand in for redacted variables. */
  secrets: { name: string; kind: "env" | "mount" }[];
  ports: { port: number; protocol: string }[];
  /** Inventoried networks the unit attaches to, by name; each needs a .network file on the host. */
  networks: string[];
  /** Inventoried volumes the unit mounts, by name; each needs a .volume file on the host. */
  volumes: string[];
  /** Volumes a mount names that the inventory lacks, with the driver options a .volume can be synthesized from. */
  synthesized: { name: string; driver: string; options: Record<string, string> }[];
  /** Configs the unit mounts read-only from the config directory, with the payload when the inventory has it. */
  configs: { name: string; uid: string; gid: string; mode: number; data: Uint8Array | null }[];
  notes: string[];
}

export const DEFAULT_UNIT_DIR = "/etc/containers/systemd";
export const DEFAULT_CONFIG_DIR = "/etc/containers/swarm-configs";

// ---------- unit rendering helpers (placement and the unit builder come from the contract) ----------

const q = quote;
const Unit = UnitFile;

/** Docker stores extra hosts as "IP hostname"; Podman's AddHost= wants "hostname:IP". */
export function addHost(entry: string): string {
  if (entry.includes(":") && !/\s/.test(entry)) return entry;
  const parts = entry.trim().split(/\s+/);
  if (parts.length >= 2 && /^[0-9a-fA-F.:]+$/.test(parts[0])) return `${parts.slice(1).join(",")}:${parts[0]}`;
  return entry.replace(/\s+/, ":");
}

function unitNameFor(svc: Service, instance: number, total: number): string {
  return total > 1 ? `${svc.name}-${instance}` : svc.name;
}

/** A unit directory as a path relative to the rendered host root. */
export function unitDirRel(unitDir: string): string {
  return unitDir.replace(/^\//, "");
}

const healthCmd = healthCommand;

// ---------- per-object renderers ----------

/** Notes a service raises once, whichever hosts it lands on. */
export function serviceNotes(svc: Service, opts: ContainerOptions): string[] {
  const notes: string[] = [];
  if (svc.ports.some((p) => p.mode === "ingress")) {
    notes.push(`${svc.name}: ingress-mode ports become per-host published ports; front them with an external load balancer or DNS round robin`);
  }
  if (svc.update_config) notes.push(`${svc.name}: update_config (${svc.update_config.order}, parallelism ${svc.update_config.parallelism}, on failure ${svc.update_config.failure_action}) has no systemd equivalent; roll hosts one at a time${opts.autoUpdate ? ", AutoUpdate=registry is enabled" : ""}`);
  if (svc.rollback_config) notes.push(`${svc.name}: rollback_config (${svc.rollback_config.order}, parallelism ${svc.rollback_config.parallelism}, on failure ${svc.rollback_config.failure_action}) has no systemd equivalent; the runbook's rollback step must reproduce it`);
  const droppedLabels = Object.keys(svc.labels).filter((k) => !k.startsWith("com.docker."));
  if (droppedLabels.length) notes.push(`${svc.name}: service labels not rendered (add them as Label= lines if a host-side tool reads them): ${droppedLabels.join(", ")}`);
  if (svc.privileged) notes.push(`${svc.name}: privileged; review AddCapability lines before installing`);
  if (svc.logging.driver && svc.logging.driver !== "journald") notes.push(`${svc.name}: log driver ${svc.logging.driver} rendered as journald`);
  return notes;
}

/** Render instance `index` of `count` of a service for one host as a .container file. */
export function renderContainer(inv: Inventory, svc: Service, hostname: string, index: number, count: number, opts: ContainerOptions = {}): ContainerRender {
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const netByRef = new Map<string, Network>();
  for (const n of inv.networks) {
    netByRef.set(n.id, n);
    netByRef.set(n.name, n);
  }
  const volByName = new Map(inv.volumes.map((v) => [v.name, v]));
  const cfgByName = new Map(inv.configs.map((c) => [c.name, c]));
  const out: ContainerRender = { unitName: unitNameFor(svc, index, count), text: "", secrets: [], ports: [], networks: [], volumes: [], synthesized: [], configs: [], notes: [] };
  const i = index;
  const isJob = svc.mode.endsWith("job");
  const unitName = out.unitName;
  const containerName = unitName;
  const u = new Unit([
    `Rendered by podman-quadlet from swarm service ${svc.name} (stack ${svc.stack ?? "none"}, mode ${svc.mode})`,
    `Source inventory captured ${inv.captured_at}`,
  ]);
  u.add("Unit", "Description", `${svc.name} (migrated from Docker Swarm)`);
  u.add("Unit", "Wants", "network-online.target");
  u.add("Unit", "After", "network-online.target");
  if (svc.restart_policy.max_attempts) u.add("Unit", "StartLimitBurst", svc.restart_policy.max_attempts);
  const window = durationToSeconds(svc.restart_policy.window);
  if (window) u.add("Unit", "StartLimitIntervalSec", Math.round(window));

  const imageRef = svc.image_digest ? `${svc.image}@${svc.image_digest}` : svc.image;
  u.add("Container", "Image", imageRef);
  u.add("Container", "ContainerName", containerName);
  if (opts.autoUpdate && !svc.image_digest) u.add("Container", "AutoUpdate", "registry");
  if (svc.command.length) u.add("Container", "Entrypoint", JSON.stringify(svc.command));
  if (svc.args.length) u.add("Container", "Exec", svc.args.map(q).join(" "));
  u.add("Container", "HostName", svc.hostname);
  u.add("Container", "User", svc.user);
  u.add("Container", "WorkingDir", svc.workdir);
  for (const [k, v] of Object.entries(svc.env).sort()) {
    if (svc.redacted_env.includes(k)) {
      const secretName = `${svc.name}-${k.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      u.add("Container", "Secret", `${secretName},type=env,target=${k}`);
      out.secrets.push({ name: secretName, kind: "env" });
      out.notes.push(`${svc.name}: environment ${k} was redacted at capture; supply it as Podman secret ${secretName}`);
    } else {
      u.add("Container", "Environment", q(`${k}=${v}`));
    }
  }
  for (const [k, v] of Object.entries(svc.container_labels).sort()) u.add("Container", "Label", q(`${k}=${v}`));
  u.add("Container", "Label", `io.systemd-dev-plugins.service=${svc.name}`);
  if (svc.stack) u.add("Container", "Label", `io.systemd-dev-plugins.stack=${svc.stack}`);

  const aliases = new Set<string>([svc.short_name]);
  for (const net of svc.networks) {
    const def = netByRef.get(net.name);
    if (!def || def.ingress) continue;
    u.add("Container", "Network", `${def.name}.network`);
    for (const a of net.aliases) aliases.add(a);
    if (!out.networks.includes(def.name)) out.networks.push(def.name);
  }
  // Quadlet applies NetworkAlias= to every attached network, so one line per alias.
  for (const a of aliases) u.add("Container", "NetworkAlias", a);
  for (const p of svc.ports) {
    const proto = p.protocol === "tcp" ? "" : `/${p.protocol}`;
    const published = p.published ?? p.target;
    const hostPort = count > 1 ? published + (i - 1) : published;
    u.add("Container", "PublishPort", `${hostPort}:${p.target}${proto}`);
    out.ports.push({ port: hostPort, protocol: p.protocol });
    if (count > 1) out.notes.push(`${svc.name}: instance ${i} publishes ${hostPort} instead of ${published} because several instances share ${hostname}`);
  }
  for (const m of svc.mounts) {
    const ro = m.readonly ? ":ro" : "";
    const label = opts.selinux ? (m.readonly ? ",z" : ",Z") : "";
    if (m.type === "volume" && m.source) {
      const vol = volByName.get(m.source);
      if (vol) {
        u.add("Container", "Volume", `${vol.name}.volume:${m.target}${ro}`);
        if (!out.volumes.includes(vol.name)) out.volumes.push(vol.name);
      } else if (m.volume_driver || (m.volume_options && Object.keys(m.volume_options).length)) {
        out.synthesized.push({ name: m.source, driver: m.volume_driver ?? "local", options: m.volume_options ?? {} });
        u.add("Container", "Volume", `${m.source}.volume:${m.target}${ro}`);
        out.notes.push(`${svc.name}: volume ${m.source} was not in the inventory; a .volume unit was synthesized from the mount's driver options (${m.volume_driver ?? "local"}); verify them on ${hostname}`);
      } else {
        u.add("Container", "Volume", `${m.source}:${m.target}${ro}`);
        out.notes.push(`${svc.name}: volume ${m.source} was not in the inventory; Podman will create an empty named volume on ${hostname}, so copy its data there first`);
      }
    } else if (m.type === "bind" && m.source) {
      const prop = m.bind_propagation ? `,${m.bind_propagation}` : "";
      u.add("Container", "Volume", `${m.source}:${m.target}${ro}${label}${prop}`.replace(":ro,", ":ro,"));
      out.notes.push(`${svc.name}: bind mount ${m.source} must exist on ${hostname} with the right ownership before the unit starts`);
    } else if (m.type === "tmpfs") {
      const optsList: string[] = [];
      if (m.tmpfs_size_bytes) optsList.push(`size=${m.tmpfs_size_bytes}`);
      if (m.tmpfs_mode) optsList.push(`mode=${octal(m.tmpfs_mode)}`);
      u.add("Container", "Tmpfs", optsList.length ? `${m.target}:${optsList.join(",")}` : m.target);
    } else {
      out.notes.push(`${svc.name}: mount type ${m.type} at ${m.target} is not supported by the renderer`);
    }
  }
  for (const s of svc.secrets) {
    const base = s.target.startsWith("/run/secrets/") ? s.target.slice("/run/secrets/".length) : s.target;
    u.add("Container", "Secret", `${s.name},type=mount,target=${base},uid=${s.uid},gid=${s.gid},mode=${octal(s.mode)}`);
    out.secrets.push({ name: s.name, kind: "mount" });
  }
  for (const c of svc.configs) {
    const path = `${configDir}/${c.name}`;
    u.add("Container", "Volume", `${path}:${c.target}:ro${opts.selinux ? ",z" : ""}`);
    const def = cfgByName.get(c.name);
    if (def?.data_base64) {
      out.configs.push({ name: c.name, uid: c.uid, gid: c.gid, mode: c.mode, data: new Uint8Array(Buffer.from(def.data_base64, "base64")) });
    } else {
      out.configs.push({ name: c.name, uid: c.uid, gid: c.gid, mode: c.mode, data: null });
      out.notes.push(`${svc.name}: config ${c.name} has no payload in the inventory; place it at ${path} on ${hostname}`);
    }
  }
  if (svc.healthcheck) {
    const cmd = healthCmd(svc.healthcheck.test);
    if (cmd) {
      u.add("Container", "HealthCmd", cmd);
      u.add("Container", "HealthInterval", svc.healthcheck.interval);
      u.add("Container", "HealthTimeout", svc.healthcheck.timeout);
      u.add("Container", "HealthRetries", svc.healthcheck.retries);
      u.add("Container", "HealthStartPeriod", svc.healthcheck.start_period);
      u.add("Container", "HealthOnFailure", "kill");
      u.add("Container", "Notify", "healthy");
    }
  }
  for (const d of svc.dns.nameservers) u.add("Container", "DNS", d);
  for (const d of svc.dns.search) u.add("Container", "DNSSearch", d);
  for (const d of svc.dns.options) u.add("Container", "DNSOption", d);
  for (const h of svc.extra_hosts) u.add("Container", "AddHost", addHost(h));
  for (const c of svc.cap_add) u.add("Container", "AddCapability", c);
  for (const c of svc.cap_drop) u.add("Container", "DropCapability", c.toLowerCase() === "all" ? "all" : c);
  for (const [k, v] of Object.entries(svc.sysctls).sort()) u.add("Container", "Sysctl", `${k}=${v}`);
  for (const ul of svc.ulimits) u.add("Container", "Ulimit", `${ul.name}=${ul.soft}:${ul.hard}`);
  if (svc.read_only) u.add("Container", "ReadOnly", "true");
  if (svc.init) u.add("Container", "RunInit", "true");
  u.add("Container", "StopSignal", svc.stop_signal);
  const grace = durationToSeconds(svc.stop_grace_period);
  u.add("Container", "StopTimeout", grace === null ? 10 : Math.round(grace));
  u.add("Container", "LogDriver", "journald");
  if (svc.resources.limits.pids) u.add("Container", "PidsLimit", svc.resources.limits.pids);

  u.add("Service", "Restart", isJob ? "no" : ({ any: "always", "on-failure": "on-failure", none: "no" } as const)[svc.restart_policy.condition]);
  const delay = durationToSeconds(svc.restart_policy.delay);
  u.add("Service", "RestartSec", delay === null ? 5 : Math.round(delay));
  u.add("Service", "TimeoutStartSec", "900");
  u.add("Service", "CPUQuota", cpuQuota(svc.resources.limits.nano_cpus));
  if (svc.resources.limits.memory_bytes) u.add("Service", "MemoryMax", svc.resources.limits.memory_bytes);
  if (svc.resources.reservations.memory_bytes) u.add("Service", "MemoryLow", svc.resources.reservations.memory_bytes);
  if (svc.resources.reservations.nano_cpus) u.add("Service", "CPUWeight", Math.max(1, Math.min(10000, Math.round(svc.resources.reservations.nano_cpus / 10_000_000))));
  if (svc.resources.limits.pids) u.add("Service", "TasksMax", svc.resources.limits.pids);
  if (!isJob) u.add("Install", "WantedBy", svc.stack ? `multi-user.target ${svc.stack}.target` : "multi-user.target");

  out.text = u.render(["Unit", "Container", "Service", "Install"]);
  return out;
}

/** The .network file for an inventoried network, plus the notes it raises. */
export function networkUnit(net: Network): { text: string; notes: string[] } {
  const u = new Unit([`Rendered from swarm ${net.driver} network ${net.name}${net.encrypted ? " (was encrypted overlay)" : ""}`]);
  u.add("Unit", "Description", `${net.name} (migrated from Docker Swarm)`);
  u.add("Network", "NetworkName", net.name);
  u.add("Network", "Driver", "bridge");
  for (const c of net.ipam.config) {
    u.add("Network", "Subnet", c.subnet);
    u.add("Network", "Gateway", c.gateway);
    u.add("Network", "IPRange", c.ip_range);
  }
  if (net.internal) u.add("Network", "Internal", "true");
  if (net.ipv6) u.add("Network", "IPv6", "true");
  for (const [k, v] of Object.entries(net.labels).sort()) u.add("Network", "Label", q(`${k}=${v}`));
  const notes: string[] = [];
  if (net.driver === "overlay" && net.used_by.length > 1) {
    notes.push(`network ${net.name}: overlay spanned hosts; on systemd each host gets a local bridge with the same subnet, so cross-host members need routed or WireGuard connectivity (see migration-planner/references/networking.md)`);
  }
  return { text: u.render(["Unit", "Network"]), notes };
}

/** The .volume file for an inventoried volume on a host, plus the notes it raises. */
export function volumeUnit(vol: Volume, hostname: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const u = new Unit([`Rendered from swarm volume ${vol.name} (driver ${vol.driver})`]);
  u.add("Unit", "Description", `${vol.name} (migrated from Docker Swarm)`);
  u.add("Volume", "VolumeName", vol.name);
  if (vol.driver !== "local") {
    u.add("Volume", "Driver", vol.driver);
    notes.push(`volume ${vol.name}: driver ${vol.driver} must be available to Podman on ${hostname}`);
  }
  if (vol.options.type) u.add("Volume", "Type", vol.options.type);
  if (vol.options.device) u.add("Volume", "Device", vol.options.device);
  if (vol.options.o) u.add("Volume", "Options", vol.options.o);
  for (const [k, v] of Object.entries(vol.labels).sort()) u.add("Volume", "Label", q(`${k}=${v}`));
  return { text: u.render(["Unit", "Volume"]), notes };
}

/** The .volume file for a volume a mount named but the inventory lacked. */
export function synthesizedVolumeUnit(name: string, driver: string, options: Record<string, string>): string {
  const u = new Unit([`Synthesized from a service mount's volume options; the volume was not inventoried on the capturing node`]);
  u.add("Unit", "Description", `${name} (migrated from Docker Swarm)`);
  u.add("Volume", "VolumeName", name);
  if (driver !== "local") u.add("Volume", "Driver", driver);
  if (options.type) u.add("Volume", "Type", options.type);
  if (options.device) u.add("Volume", "Device", options.device);
  if (options.o) u.add("Volume", "Options", options.o);
  return u.render(["Unit", "Volume"]);
}

// ---------- main renderer ----------

export function render(inv: Inventory, opts: RenderOptions): RenderResult {
  const unitDir = opts.unitDir ?? DEFAULT_UNIT_DIR;
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  // These paths and names are written into install.sh, which an operator runs as root.
  for (const [flag, dir] of [["--unit-dir", unitDir], ["--config-dir", configDir]] as const) {
    if (!isPlainPath(dir)) throw new Error(`${flag} must be an absolute path of plain characters, got ${JSON.stringify(dir)}`);
  }
  for (const s of inv.services) if (!isPlainName(s.name)) throw new Error(`service name ${JSON.stringify(s.name)} cannot be used in unit and script names`);
  for (const n of inv.nodes) if (!isPlainName(n.hostname)) throw new Error(`hostname ${JSON.stringify(n.hostname)} cannot be used in script paths`);
  const containerOpts: ContainerOptions = { autoUpdate: opts.autoUpdate, selinux: opts.selinux, unitDir, configDir };
  const files: Record<string, string | Uint8Array> = {};
  const configManifest = new Map<string, string[]>(); // host -> "name uid gid mode" lines
  const hosts: Record<string, HostPlan> = {};
  const notes: string[] = [];
  const netByRef = new Map<string, (typeof inv.networks)[number]>();
  for (const n of inv.networks) {
    netByRef.set(n.id, n);
    netByRef.set(n.name, n);
  }
  const volByName = new Map(inv.volumes.map((v) => [v.name, v]));

  const host = (name: string): HostPlan => {
    hosts[name] ??= { hostname: name, units: [], containers: [], ports: [], networks: [], volumes: [], secrets: [], targets: [] };
    return hosts[name];
  };
  const put = (hostname: string, rel: string, content: string | Uint8Array) => {
    files[join("hosts", hostname, rel)] = content;
  };
  const stackUnits = new Map<string, Map<string, string[]>>(); // host -> stack -> units
  const synthesizedVolumes = new Map<string, { host: string; driver: string; options: Record<string, string> }>();

  for (const svc of [...inv.services].sort((a, b) => a.name.localeCompare(b.name))) {
    const placement = placeService(svc, inv.nodes, opts, notes);
    notes.push(...serviceNotes(svc, containerOpts));

    for (const [hostname, count] of placement) {
      const plan = host(hostname);
      for (let i = 1; i <= count; i++) {
        const r = renderContainer(inv, svc, hostname, i, count, containerOpts);
        // Secrets that stand in for redacted variables were always appended; mounted ones once per host.
        for (const s of r.secrets) if (s.kind === "env" || !plan.secrets.includes(s.name)) plan.secrets.push(s.name);
        for (const n of r.networks) if (!plan.networks.includes(n)) plan.networks.push(n);
        plan.ports.push(...r.ports);
        for (const v of r.volumes) if (!plan.volumes.includes(v)) plan.volumes.push(v);
        for (const s of r.synthesized) synthesizedVolumes.set(s.name, { host: hostname, driver: s.driver, options: s.options });
        for (const c of r.configs) {
          if (!c.data) continue;
          put(hostname, `etc/containers/swarm-configs/${c.name}`, c.data);
          configManifest.set(hostname, [...(configManifest.get(hostname) ?? []), `${c.name} ${c.uid} ${c.gid} ${octal(c.mode)}`]);
        }
        notes.push(...r.notes);

        put(hostname, `${unitDirRel(unitDir)}/${r.unitName}.container`, r.text);
        plan.units.push(`${r.unitName}.service`);
        plan.containers.push(r.unitName);
        if (svc.stack) {
          const perHost = stackUnits.get(hostname) ?? new Map<string, string[]>();
          perHost.set(svc.stack, [...(perHost.get(svc.stack) ?? []), `${r.unitName}.service`]);
          stackUnits.set(hostname, perHost);
        }
      }
    }
  }

  // Networks and volumes per host.
  for (const plan of Object.values(hosts)) {
    for (const name of plan.networks) {
      const net = netByRef.get(name)!;
      const r = networkUnit(net);
      put(plan.hostname, `${unitDirRel(unitDir)}/${net.name}.network`, r.text);
      notes.push(...r.notes);
    }
    for (const name of plan.volumes) {
      const vol = volByName.get(name)!;
      const r = volumeUnit(vol, plan.hostname);
      notes.push(...r.notes);
      put(plan.hostname, `${unitDirRel(unitDir)}/${vol.name}.volume`, r.text);
    }
    const perHost = stackUnits.get(plan.hostname) ?? new Map<string, string[]>();
    for (const [stack, units] of perHost) {
      const t = new Unit([`Groups the units of swarm stack ${stack} on ${plan.hostname}`]);
      t.add("Unit", "Description", `Swarm stack ${stack} (migrated)`);
      t.add("Unit", "Wants", units.join(" "));
      t.add("Unit", "After", units.join(" "));
      t.add("Install", "WantedBy", "multi-user.target");
      put(plan.hostname, `etc/systemd/system/${stack}.target`, t.render(["Unit", "Install"]));
      plan.targets.push(`${stack}.target`);
    }
    for (const [name, v] of synthesizedVolumes) {
      if (v.host !== plan.hostname) continue;
      put(plan.hostname, `${unitDirRel(unitDir)}/${name}.volume`, synthesizedVolumeUnit(name, v.driver, v.options));
      if (!plan.volumes.includes(name)) plan.volumes.push(name);
    }
    const manifest = configManifest.get(plan.hostname) ?? [];
    if (manifest.length) put(plan.hostname, "etc/containers/swarm-configs/.manifest", manifest.join("\n") + "\n");
    put(plan.hostname, "secrets/import-secrets.sh", importScript(plan.secrets));
    put(plan.hostname, "install.sh", installScript(plan, unitDir, configDir));
  }

  if (inv.services.some((s) => s.endpoint_mode === "vip" && s.networks.length > 0)) {
    notes.push(VIP_NOTE);
  }
  files["expected.json"] = JSON.stringify({ generated_from: inv.captured_at, hosts }, null, 2) + "\n";
  files["MIGRATION-NOTES.md"] = notesDocument(inv, hosts, notes);
  return { files, hosts, notes };
}

/** The note every Quadlet tree carries when a service relied on Swarm's VIP discovery. */
export const VIP_NOTE = "service discovery: Swarm VIPs are replaced by Podman network DNS; an alias resolves only to containers on the same host's bridge, so cross-host callers need DNS or a load balancer (see migration-planner/references/networking.md)";

/** The per-host script that creates the Podman secrets the units reference; it never holds a value. */
export function importScript(secrets: string[]): string {
  const list = [...new Set(secrets)].sort();
  return `#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Import the Podman secrets this host's units reference.
# Values are read from $SWARM_SECRETS_DIR (default /etc/swarm-migration/secrets),
# a root-only directory outside any agent workspace, one file per secret named
# after the secret (mode 0600). The renderer never writes secret values and
# this script never prints them.
set -euo pipefail
dir="\${SWARM_SECRETS_DIR:-/etc/swarm-migration/secrets}"
[ -d "$dir" ] || { echo "secrets directory $dir does not exist; create it (mode 0700) and add one file per secret" >&2; exit 1; }
missing=0
for name in ${list.map((s) => `'${s}'`).join(" ")}; do
    if [ ! -f "$dir/$name" ]; then
        echo "missing secret value file: $dir/$name" >&2
        missing=1
        continue
    fi
    podman secret create --replace "$name" "$dir/$name" >/dev/null
    echo "imported $name"
done
exit $missing
`;
}

function installScript(plan: HostPlan, unitDirRaw: string, configDirRaw: string): string {
  // Every value from options or the inventory is shell-quoted; the paths were validated in render().
  const unitDir = shellQuote(unitDirRaw);
  const configDir = shellQuote(configDirRaw);
  const units = plan.units.map(shellQuote).join(" ");
  const targets = plan.targets.map(shellQuote).join(" ");
  return `#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Install the rendered Quadlet units for ${plan.hostname}. Run as root on that host.
# Pass --start to enable and start the stack targets after installing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
start=0
[ "\${1:-}" = "--start" ] && start=1
install -d -m 0755 ${unitDir} ${configDir} /etc/systemd/system
if [ -d "$here/etc/containers/swarm-configs" ]; then
    find "$here/etc/containers/swarm-configs" -maxdepth 1 -type f ! -name .manifest -exec install -m 0644 {} ${configDir}/ \\;
fi
install -m 0644 "$here"${unitDir}/* ${unitDir}/
if ls "$here/etc/systemd/system/"*.target >/dev/null 2>&1; then
    install -m 0644 "$here/etc/systemd/system/"*.target /etc/systemd/system/
fi
if [ -f "$here/etc/containers/swarm-configs/.manifest" ]; then
    while read -r name uid gid mode; do
        [ -n "$name" ] || continue
        chown "$uid:$gid" ${configDir}/"$name" && chmod "$mode" ${configDir}/"$name"
    done < "$here/etc/containers/swarm-configs/.manifest"
fi
systemctl daemon-reload
if ! systemd-analyze verify ${units}; then
    echo "systemd-analyze verify failed; units are installed but not started. Fix the rendered tree and re-run." >&2
    exit 1
fi
if [ "$start" -eq 1 ]; then
    systemctl enable --now ${targets} ${units}
fi
echo "installed ${plan.units.length} units on $(hostname)"
`;
}

function notesDocument(inv: Inventory, hosts: Record<string, HostPlan>, notes: string[]): string {
  const lines = [
    "# Migration notes",
    "",
    `Rendered from an inventory captured ${inv.captured_at}${inv.captured_on ? ` on ${inv.captured_on}` : ""}.`,
    "",
    "## Host plan",
    "",
    "| Host | Units | Published ports | Networks | Volumes | Secrets |",
    "|---|---|---|---|---|---|",
  ];
  for (const h of Object.values(hosts).sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    lines.push(`| ${h.hostname} | ${h.units.join(", ") || "none"} | ${h.ports.map((p) => `${p.port}/${p.protocol}`).join(", ") || "none"} | ${h.networks.join(", ") || "none"} | ${h.volumes.join(", ") || "none"} | ${h.secrets.join(", ") || "none"} |`);
  }
  lines.push("", "## Items that need a human decision", "");
  const unique = [...new Set(notes)];
  if (unique.length === 0) lines.push("None recorded by the renderer.");
  for (const n of unique) lines.push(`- ${n}`);
  if (inv.warnings.length) {
    lines.push("", "## Warnings carried from the capture", "");
    for (const w of inv.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n") + "\n";
}

export function writeResult(result: RenderResult, outDir: string): void {
  for (const [rel, content] of Object.entries(result.files)) {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let input: string | undefined;
  const opts: RenderOptions = { outDir: "rendered" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") opts.outDir = argv[++i];
    else if (a === "--host-map") opts.hostMap = JSON.parse(readFileSync(argv[++i], "utf8"));
    else if (a === "--scale-out") opts.scaleOut = true;
    else if (a === "--auto-update") opts.autoUpdate = true;
    else if (a === "--selinux") opts.selinux = true;
    else if (a === "--unit-dir") opts.unitDir = argv[++i];
    else if (a === "--config-dir") opts.configDir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: bun render.ts <inventory.json> -o <outdir> [--host-map map.json] [--scale-out] [--auto-update] [--selinux] [--unit-dir DIR] [--config-dir DIR]");
      process.exit(0);
    } else input = a;
  }
  if (!input) {
    console.error("inventory.json required");
    process.exit(2);
  }
  const inv = JSON.parse(readFileSync(input, "utf8")) as Inventory;
  const result = render(inv, opts);
  writeResult(result, opts.outDir);
  const hostCount = Object.keys(result.hosts).length;
  const unitCount = Object.values(result.hosts).reduce((n, h) => n + h.units.length, 0);
  console.log(`rendered ${unitCount} container units across ${hostCount} hosts into ${opts.outDir}`);
  console.log(`read ${join(opts.outDir, "MIGRATION-NOTES.md")} before installing anything`);
}
