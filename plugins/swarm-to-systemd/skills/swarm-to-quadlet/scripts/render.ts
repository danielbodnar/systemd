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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Inventory, Node, Service, Task } from "../../swarm-capture/scripts/types.ts";
import { durationToSeconds } from "../../swarm-capture/scripts/types.ts";

export interface RenderOptions {
  outDir: string;
  hostMap?: Record<string, string[]>;
  scaleOut?: boolean;
  autoUpdate?: boolean;
  unitDir?: string;
  configDir?: string;
  selinux?: boolean;
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
  files: Record<string, string>;
  hosts: Record<string, HostPlan>;
  notes: string[];
}

// ---------- placement ----------

interface Constraint { key: string; op: "==" | "!="; value: string }

export function parseConstraint(raw: string): Constraint | null {
  const m = raw.match(/^\s*([\w.\-/]+)\s*(==|!=)\s*(.+?)\s*$/);
  if (!m) return null;
  return { key: m[1], op: m[2] as "==" | "!=", value: m[3] };
}

function nodeValue(node: Node, key: string): string | undefined {
  if (key === "node.id") return node.id;
  if (key === "node.hostname") return node.hostname;
  if (key === "node.role") return node.role;
  if (key === "node.platform.os") return node.os;
  if (key === "node.platform.arch") return node.arch;
  if (key.startsWith("node.labels.")) return node.labels[key.slice("node.labels.".length)];
  if (key.startsWith("engine.labels.")) return node.engine_labels[key.slice("engine.labels.".length)];
  return undefined;
}

export function nodeSatisfies(node: Node, constraints: string[]): boolean {
  for (const raw of constraints) {
    const c = parseConstraint(raw);
    if (!c) return false;
    const v = nodeValue(node, c.key);
    const eq = v !== undefined && v === c.value;
    if (c.op === "==" && !eq) return false;
    if (c.op === "!=" && eq) return false;
  }
  return true;
}

/** Decide which hosts run a service, and how many instances each host gets. */
export function placeService(svc: Service, nodes: Node[], opts: { hostMap?: Record<string, string[]>; scaleOut?: boolean }, notes: string[]): Map<string, number> {
  const placement = new Map<string, number>();
  const override = opts.hostMap?.[svc.name];
  if (override) {
    for (const h of override) placement.set(h, (placement.get(h) ?? 0) + 1);
    return placement;
  }
  const candidates = nodes.filter((n) => n.availability === "active" && n.state === "ready" && nodeSatisfies(n, svc.placement.constraints));
  if (candidates.length === 0) {
    notes.push(`${svc.name}: no node satisfies constraints ${JSON.stringify(svc.placement.constraints)}; rendered nowhere, add a host-map entry`);
    return placement;
  }
  if (svc.mode === "global" || svc.mode === "global-job") {
    for (const n of candidates) placement.set(n.hostname, 1);
    return placement;
  }
  const wanted = svc.replicas ?? 1;
  const perNodeCap = svc.placement.max_replicas_per_node ?? (opts.scaleOut ? Number.POSITIVE_INFINITY : 1);
  const running = new Set(svc.tasks.filter((t: Task) => t.desired_state === "running").map((t) => t.node));
  const ordered = [...candidates].sort((a, b) => Number(running.has(b.hostname)) - Number(running.has(a.hostname)) || a.hostname.localeCompare(b.hostname));
  let remaining = wanted;
  // First pass: one per host, preferring hosts already running the service.
  for (const n of ordered) {
    if (remaining <= 0) break;
    placement.set(n.hostname, 1);
    remaining -= 1;
  }
  // Second pass: scale out round-robin within the per-node cap.
  while (remaining > 0 && opts.scaleOut) {
    let progressed = false;
    for (const n of ordered) {
      if (remaining <= 0) break;
      const cur = placement.get(n.hostname) ?? 0;
      if (cur < perNodeCap) {
        placement.set(n.hostname, cur + 1);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  if (remaining > 0) {
    notes.push(`${svc.name}: wanted ${wanted} replicas but rendered ${wanted - remaining} (one per eligible host; pass --scale-out for numbered instances)`);
  }
  return placement;
}

// ---------- unit rendering helpers ----------

function q(value: string): string {
  if (value === "") return '""';
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

class Unit {
  private sections = new Map<string, string[]>();
  constructor(private header: string[]) {}
  add(section: string, key: string, value: string | number | boolean | null | undefined): void {
    if (value === null || value === undefined || value === "") return;
    const list = this.sections.get(section) ?? [];
    list.push(`${key}=${String(value)}`);
    this.sections.set(section, list);
  }
  render(order: string[]): string {
    const out = this.header.map((l) => `# ${l}`);
    for (const s of order) {
      const lines = this.sections.get(s);
      if (!lines || lines.length === 0) continue;
      out.push("", `[${s}]`, ...lines);
    }
    return out.join("\n") + "\n";
  }
}

function cpuQuota(nanoCpus: number | null): string | null {
  if (!nanoCpus) return null;
  return `${Math.round(nanoCpus / 10_000_000)}%`;
}

/** Docker stores extra hosts as "IP hostname"; Podman's AddHost= wants "hostname:IP". */
export function addHost(entry: string): string {
  if (entry.includes(":") && !/\s/.test(entry)) return entry;
  const parts = entry.trim().split(/\s+/);
  if (parts.length >= 2 && /^[0-9a-fA-F.:]+$/.test(parts[0])) return `${parts.slice(1).join(",")}:${parts[0]}`;
  return entry.replace(/\s+/, ":");
}

function octal(mode: number): string {
  return "0" + mode.toString(8);
}

function unitNameFor(svc: Service, instance: number, total: number): string {
  return total > 1 ? `${svc.name}-${instance}` : svc.name;
}

function healthCmd(test: string[]): string | null {
  if (test.length === 0) return null;
  const [kind, ...rest] = test;
  if (kind === "NONE") return null;
  if (kind === "CMD-SHELL") return rest.join(" ");
  if (kind === "CMD") return rest.map(q).join(" ");
  return test.map(q).join(" ");
}

// ---------- main renderer ----------

export function render(inv: Inventory, opts: RenderOptions): RenderResult {
  const unitDir = opts.unitDir ?? "/etc/containers/systemd";
  const configDir = opts.configDir ?? "/etc/containers/swarm-configs";
  const files: Record<string, string> = {};
  const hosts: Record<string, HostPlan> = {};
  const notes: string[] = [];
  const netByRef = new Map<string, (typeof inv.networks)[number]>();
  for (const n of inv.networks) {
    netByRef.set(n.id, n);
    netByRef.set(n.name, n);
  }
  const volByName = new Map(inv.volumes.map((v) => [v.name, v]));
  const cfgByName = new Map(inv.configs.map((c) => [c.name, c]));

  const host = (name: string): HostPlan => {
    hosts[name] ??= { hostname: name, units: [], containers: [], ports: [], networks: [], volumes: [], secrets: [], targets: [] };
    return hosts[name];
  };
  const put = (hostname: string, rel: string, content: string) => {
    files[join("hosts", hostname, rel)] = content;
  };
  const stackUnits = new Map<string, Map<string, string[]>>(); // host -> stack -> units

  for (const svc of [...inv.services].sort((a, b) => a.name.localeCompare(b.name))) {
    const placement = placeService(svc, inv.nodes, opts, notes);
    const isJob = svc.mode.endsWith("job");
    if (svc.ports.some((p) => p.mode === "ingress")) {
      notes.push(`${svc.name}: ingress-mode ports become per-host published ports; front them with an external load balancer or DNS round robin`);
    }
    if (svc.update_config) notes.push(`${svc.name}: update_config (${svc.update_config.order}, parallelism ${svc.update_config.parallelism}) has no systemd equivalent; roll hosts one at a time${opts.autoUpdate ? ", AutoUpdate=registry is enabled" : ""}`);
    if (svc.privileged) notes.push(`${svc.name}: privileged; review AddCapability lines before installing`);
    if (svc.logging.driver && svc.logging.driver !== "journald") notes.push(`${svc.name}: log driver ${svc.logging.driver} rendered as journald`);

    for (const [hostname, count] of placement) {
      const plan = host(hostname);
      for (let i = 1; i <= count; i++) {
        const unitName = unitNameFor(svc, i, count);
        const containerName = unitName;
        const u = new Unit([
          `Rendered by swarm-to-systemd from swarm service ${svc.name} (stack ${svc.stack ?? "none"}, mode ${svc.mode})`,
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
            plan.secrets.push(secretName);
            notes.push(`${svc.name}: environment ${k} was redacted at capture; supply it as Podman secret ${secretName}`);
          } else {
            u.add("Container", "Environment", q(`${k}=${v}`));
          }
        }
        for (const [k, v] of Object.entries(svc.container_labels).sort()) u.add("Container", "Label", q(`${k}=${v}`));
        u.add("Container", "Label", `io.swarm-to-systemd.service=${svc.name}`);
        if (svc.stack) u.add("Container", "Label", `io.swarm-to-systemd.stack=${svc.stack}`);

        const aliases = new Set<string>([svc.short_name]);
        for (const net of svc.networks) {
          const def = netByRef.get(net.name);
          if (!def || def.ingress) continue;
          u.add("Container", "Network", `${def.name}.network`);
          for (const a of net.aliases) aliases.add(a);
          if (!plan.networks.includes(def.name)) plan.networks.push(def.name);
        }
        // Quadlet applies NetworkAlias= to every attached network, so one line per alias.
        for (const a of aliases) u.add("Container", "NetworkAlias", a);
        for (const p of svc.ports) {
          const proto = p.protocol === "tcp" ? "" : `/${p.protocol}`;
          const published = p.published ?? p.target;
          const hostPort = count > 1 ? published + (i - 1) : published;
          u.add("Container", "PublishPort", `${hostPort}:${p.target}${proto}`);
          plan.ports.push({ port: hostPort, protocol: p.protocol });
          if (count > 1) notes.push(`${svc.name}: instance ${i} publishes ${hostPort} instead of ${published} because several instances share ${hostname}`);
        }
        for (const m of svc.mounts) {
          const ro = m.readonly ? ":ro" : "";
          const label = opts.selinux ? (m.readonly ? ",z" : ",Z") : "";
          if (m.type === "volume" && m.source) {
            const vol = volByName.get(m.source);
            if (vol) {
              u.add("Container", "Volume", `${vol.name}.volume:${m.target}${ro}`);
              if (!plan.volumes.includes(vol.name)) plan.volumes.push(vol.name);
            } else {
              u.add("Container", "Volume", `${m.source}:${m.target}${ro}`);
              notes.push(`${svc.name}: volume ${m.source} was not in the inventory; Podman will create an empty named volume`);
            }
          } else if (m.type === "bind" && m.source) {
            const prop = m.bind_propagation ? `,${m.bind_propagation}` : "";
            u.add("Container", "Volume", `${m.source}:${m.target}${ro}${label}${prop}`.replace(":ro,", ":ro,"));
            notes.push(`${svc.name}: bind mount ${m.source} must exist on ${hostname} with the right ownership before the unit starts`);
          } else if (m.type === "tmpfs") {
            const optsList: string[] = [];
            if (m.tmpfs_size_bytes) optsList.push(`size=${m.tmpfs_size_bytes}`);
            if (m.tmpfs_mode) optsList.push(`mode=${octal(m.tmpfs_mode)}`);
            u.add("Container", "Tmpfs", optsList.length ? `${m.target}:${optsList.join(",")}` : m.target);
          } else {
            notes.push(`${svc.name}: mount type ${m.type} at ${m.target} is not supported by the renderer`);
          }
        }
        for (const s of svc.secrets) {
          const base = s.target.startsWith("/run/secrets/") ? s.target.slice("/run/secrets/".length) : s.target;
          u.add("Container", "Secret", `${s.name},type=mount,target=${base},uid=${s.uid},gid=${s.gid},mode=${octal(s.mode)}`);
          if (!plan.secrets.includes(s.name)) plan.secrets.push(s.name);
        }
        for (const c of svc.configs) {
          const path = `${configDir}/${c.name}`;
          u.add("Container", "Volume", `${path}:${c.target}:ro${opts.selinux ? ",z" : ""}`);
          const def = cfgByName.get(c.name);
          if (def?.data_base64) {
            put(hostname, `etc/containers/swarm-configs/${c.name}`, Buffer.from(def.data_base64, "base64").toString("utf8"));
          } else {
            notes.push(`${svc.name}: config ${c.name} has no payload in the inventory; place it at ${path} on ${hostname}`);
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
        u.add("Container", "StopTimeout", grace ? Math.round(grace) : 10);
        u.add("Container", "LogDriver", "journald");
        if (svc.resources.limits.pids) u.add("Container", "PidsLimit", svc.resources.limits.pids);

        u.add("Service", "Restart", isJob ? "no" : ({ any: "always", "on-failure": "on-failure", none: "no" } as const)[svc.restart_policy.condition]);
        const delay = durationToSeconds(svc.restart_policy.delay);
        u.add("Service", "RestartSec", delay ? Math.round(delay) : 5);
        u.add("Service", "TimeoutStartSec", "900");
        u.add("Service", "CPUQuota", cpuQuota(svc.resources.limits.nano_cpus));
        if (svc.resources.limits.memory_bytes) u.add("Service", "MemoryMax", svc.resources.limits.memory_bytes);
        if (svc.resources.reservations.memory_bytes) u.add("Service", "MemoryLow", svc.resources.reservations.memory_bytes);
        if (svc.resources.reservations.nano_cpus) u.add("Service", "CPUWeight", Math.max(1, Math.min(10000, Math.round(svc.resources.reservations.nano_cpus / 10_000_000))));
        if (svc.resources.limits.pids) u.add("Service", "TasksMax", svc.resources.limits.pids);
        if (!isJob) u.add("Install", "WantedBy", svc.stack ? `multi-user.target ${svc.stack}.target` : "multi-user.target");

        put(hostname, `${unitDir.replace(/^\//, "")}/${unitName}.container`, u.render(["Unit", "Container", "Service", "Install"]));
        plan.units.push(`${unitName}.service`);
        plan.containers.push(containerName);
        if (svc.stack) {
          const perHost = stackUnits.get(hostname) ?? new Map<string, string[]>();
          perHost.set(svc.stack, [...(perHost.get(svc.stack) ?? []), `${unitName}.service`]);
          stackUnits.set(hostname, perHost);
        }
      }
    }
  }

  // Networks and volumes per host.
  for (const plan of Object.values(hosts)) {
    for (const name of plan.networks) {
      const net = netByRef.get(name)!;
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
      put(plan.hostname, `${unitDir.replace(/^\//, "")}/${net.name}.network`, u.render(["Unit", "Network"]));
      if (net.driver === "overlay" && net.used_by.length > 1) {
        notes.push(`network ${net.name}: overlay spanned hosts; on systemd each host gets a local bridge with the same subnet, so cross-host members need routed or WireGuard connectivity (see systemd-migration-plan/references/networking.md)`);
      }
    }
    for (const name of plan.volumes) {
      const vol = volByName.get(name)!;
      const u = new Unit([`Rendered from swarm volume ${vol.name} (driver ${vol.driver})`]);
      u.add("Unit", "Description", `${vol.name} (migrated from Docker Swarm)`);
      u.add("Volume", "VolumeName", vol.name);
      if (vol.driver !== "local") {
        u.add("Volume", "Driver", vol.driver);
        notes.push(`volume ${vol.name}: driver ${vol.driver} must be available to Podman on ${plan.hostname}`);
      }
      if (vol.options.type) u.add("Volume", "Type", vol.options.type);
      if (vol.options.device) u.add("Volume", "Device", vol.options.device);
      if (vol.options.o) u.add("Volume", "Options", vol.options.o);
      for (const [k, v] of Object.entries(vol.labels).sort()) u.add("Volume", "Label", q(`${k}=${v}`));
      put(plan.hostname, `${unitDir.replace(/^\//, "")}/${vol.name}.volume`, u.render(["Unit", "Volume"]));
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
    put(plan.hostname, "secrets/import-secrets.sh", importScript(plan.secrets));
    put(plan.hostname, "install.sh", installScript(plan, unitDir, configDir));
  }

  if (inv.services.some((s) => s.endpoint_mode === "vip" && s.networks.length > 0)) {
    notes.push("service discovery: Swarm VIPs are replaced by Podman network DNS; an alias resolves only to containers on the same host's bridge, so cross-host callers need DNS or a load balancer (see systemd-migration-plan/references/networking.md)");
  }
  files["expected.json"] = JSON.stringify({ generated_from: inv.captured_at, hosts }, null, 2) + "\n";
  files["MIGRATION-NOTES.md"] = notesDocument(inv, hosts, notes);
  return { files, hosts, notes };
}

function importScript(secrets: string[]): string {
  const list = [...new Set(secrets)].sort();
  return `#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Import the Podman secrets this host's units reference.
# Place each value in secrets/values/<name> (mode 0600) before running; the
# renderer never writes secret values and this script never prints them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)/values"
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

function installScript(plan: HostPlan, unitDir: string, configDir: string): string {
  return `#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Install the rendered Quadlet units for ${plan.hostname}. Run as root on that host.
# Pass --start to enable and start the stack targets after installing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
start=0
[ "\${1:-}" = "--start" ] && start=1
install -d -m 0755 "${unitDir}" "${configDir}" /etc/systemd/system
if [ -d "$here/etc/containers/swarm-configs" ]; then
    install -m 0644 "$here/etc/containers/swarm-configs/"* "${configDir}/"
fi
install -m 0644 "$here${unitDir}/"* "${unitDir}/"
if ls "$here/etc/systemd/system/"*.target >/dev/null 2>&1; then
    install -m 0644 "$here/etc/systemd/system/"*.target /etc/systemd/system/
fi
systemctl daemon-reload
systemd-analyze verify ${plan.units.join(" ")} || echo "systemd-analyze reported problems; review before starting" >&2
if [ "$start" -eq 1 ]; then
    systemctl enable --now ${plan.targets.join(" ")} ${plan.units.join(" ")}
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
