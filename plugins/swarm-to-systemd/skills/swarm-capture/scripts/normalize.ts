#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// normalize.ts: turn a capture directory produced by capture.sh into
// inventory.json, the shape every other swarm-to-systemd skill consumes.
//
// Usage: bun normalize.ts <capture-dir> [-o inventory.json] [--keep-env-values]
//
// No dependencies beyond Bun and the Node standard library, so it can run on
// an operator laptop, in CI, or inside a Managed Agents sandbox.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Config, FileRef, Healthcheck, Inventory, Mount, Network, Node, Port, ResourceSpec,
  Secret, Service, Stack, Task, UpdateConfig, Volume,
} from "./types.ts";
import { nsToDuration } from "./types.ts";
import { validateSchema } from "./schema.ts";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "references", "inventory-schema.json");

const STACK_LABEL = "com.docker.stack.namespace";
const SECRET_ENV = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|pwd|auth)/i;
// Values that carry a credential regardless of the variable name: URI userinfo
// with a password, and key=value credential forms inside the value.
const SECRET_VALUE = /(:\/\/[^/@\s]+:[^/@\s]+@|(^|[;&?, ])(password|passwd|pwd|secret|token|api[_-]?key)=)/i;

type Json = Record<string, any>;

function readJson(dir: string, name: string, fallback: unknown = []): any {
  const p = join(dir, "raw", name);
  if (!existsSync(p)) return fallback;
  const text = readFileSync(p, "utf8").trim();
  return text ? JSON.parse(text) : fallback;
}

function readJsonl(dir: string, name: string): Json[] {
  const p = join(dir, "raw", name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function labelsOf(obj: unknown): Record<string, string> {
  return obj && typeof obj === "object" ? { ...(obj as Record<string, string>) } : {};
}

function envToMap(list: string[] | undefined, keepValues: boolean): { env: Record<string, string>; redacted: string[] } {
  const env: Record<string, string> = {};
  const redacted: string[] = [];
  for (const entry of list ?? []) {
    const idx = entry.indexOf("=");
    const key = idx === -1 ? entry : entry.slice(0, idx);
    const value = idx === -1 ? "" : entry.slice(idx + 1);
    if (!keepValues && (SECRET_ENV.test(key) || SECRET_VALUE.test(value))) {
      env[key] = "<redacted>";
      redacted.push(key);
    } else {
      env[key] = value;
    }
  }
  return { env, redacted };
}

function splitImage(ref: string): { image: string; digest: string | null } {
  const at = ref.indexOf("@");
  if (at === -1) return { image: ref, digest: null };
  return { image: ref.slice(0, at), digest: ref.slice(at + 1) };
}

function resourceSpec(r: Json | undefined): ResourceSpec {
  return {
    nano_cpus: r?.NanoCPUs ?? null,
    memory_bytes: r?.MemoryBytes ?? null,
    pids: r?.Pids ?? null,
  };
}

function updateConfig(u: Json | undefined): UpdateConfig | null {
  if (!u) return null;
  return {
    parallelism: u.Parallelism ?? 1,
    delay: nsToDuration(u.Delay),
    failure_action: u.FailureAction ?? "pause",
    monitor: nsToDuration(u.Monitor),
    max_failure_ratio: u.MaxFailureRatio ?? 0,
    order: u.Order ?? "stop-first",
  };
}

function fileRefs(list: Json[] | undefined, idKey: string, nameKey: string): FileRef[] {
  return (list ?? []).map((s) => ({
    name: s[nameKey],
    id: s[idKey],
    target: s.File?.Name ?? s[nameKey],
    uid: s.File?.UID ?? "0",
    gid: s.File?.GID ?? "0",
    mode: s.File?.Mode ?? 0o444,
  }));
}

function healthcheck(h: Json | undefined): Healthcheck | null {
  if (!h || !Array.isArray(h.Test) || h.Test.length === 0) return null;
  if (h.Test[0] === "NONE") return null;
  return {
    test: h.Test,
    interval: nsToDuration(h.Interval),
    timeout: nsToDuration(h.Timeout),
    retries: h.Retries ?? null,
    start_period: nsToDuration(h.StartPeriod),
  };
}

function mounts(list: Json[] | undefined): Mount[] {
  return (list ?? []).map((m) => {
    const mount: Mount = {
      type: m.Type ?? "volume",
      source: m.Source ?? null,
      target: m.Target,
      readonly: Boolean(m.ReadOnly),
    };
    if (m.VolumeOptions) {
      mount.volume_nocopy = Boolean(m.VolumeOptions.NoCopy);
      if (m.VolumeOptions.DriverConfig?.Name) mount.volume_driver = m.VolumeOptions.DriverConfig.Name;
      if (m.VolumeOptions.DriverConfig?.Options) mount.volume_options = { ...m.VolumeOptions.DriverConfig.Options };
    }
    if (m.BindOptions?.Propagation) mount.bind_propagation = m.BindOptions.Propagation;
    if (m.TmpfsOptions) {
      if (m.TmpfsOptions.SizeBytes) mount.tmpfs_size_bytes = m.TmpfsOptions.SizeBytes;
      if (m.TmpfsOptions.Mode) mount.tmpfs_mode = m.TmpfsOptions.Mode;
    }
    return mount;
  });
}

function ports(endpoint: Json | undefined): Port[] {
  const list: Json[] = endpoint?.Spec?.Ports ?? endpoint?.Ports ?? [];
  return list.map((p) => ({
    target: p.TargetPort,
    published: p.PublishedPort ?? null,
    protocol: p.Protocol ?? "tcp",
    mode: p.PublishMode ?? "ingress",
  }));
}

function nodes(raw: Json[]): Node[] {
  return raw.map((n) => ({
    id: n.ID,
    hostname: n.Description?.Hostname ?? n.ID,
    role: n.Spec?.Role ?? "worker",
    leader: Boolean(n.ManagerStatus?.Leader),
    availability: n.Spec?.Availability ?? "active",
    state: n.Status?.State ?? "unknown",
    addr: n.Status?.Addr ?? "",
    labels: labelsOf(n.Spec?.Labels),
    engine_labels: labelsOf(n.Description?.Engine?.Labels),
    engine_version: n.Description?.Engine?.EngineVersion ?? "",
    os: n.Description?.Platform?.OS ?? "",
    arch: n.Description?.Platform?.Architecture ?? "",
    nano_cpus: n.Description?.Resources?.NanoCPUs ?? 0,
    memory_bytes: n.Description?.Resources?.MemoryBytes ?? 0,
  }));
}

function tasksFor(serviceName: string, rows: Json[], nodeByName: Map<string, Node>): Task[] {
  return rows
    .filter((t) => typeof t.Name === "string" && (t.Name === serviceName || t.Name.startsWith(`${serviceName}.`)))
    .filter((t) => !String(t.Name).startsWith("\\_"))
    .map((t) => ({
      id: t.ID,
      node: nodeByName.get(t.Node)?.hostname ?? t.Node ?? "",
      desired_state: String(t.DesiredState ?? "").toLowerCase(),
      current_state: String(t.CurrentState ?? "").split(" ")[0].toLowerCase(),
      error: t.Error ?? "",
    }));
}

function services(raw: Json[], taskRows: Json[], nodeList: Node[], keepEnv: boolean, warnings: string[]): Service[] {
  const nodeByName = new Map(nodeList.map((n) => [n.hostname, n]));
  return raw.map((s) => {
    const spec = s.Spec ?? {};
    const task = spec.TaskTemplate ?? {};
    const c = task.ContainerSpec ?? {};
    const name: string = spec.Name;
    const stack: string | null = spec.Labels?.[STACK_LABEL] ?? null;
    const shortName = stack && name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name;
    const { image, digest } = splitImage(c.Image ?? "");
    const { env, redacted } = envToMap(c.Env, keepEnv);
    const modeKey = Object.keys(spec.Mode ?? { Replicated: {} })[0] ?? "Replicated";
    const mode = ({
      Replicated: "replicated",
      Global: "global",
      ReplicatedJob: "replicated-job",
      GlobalJob: "global-job",
    } as const)[modeKey as "Replicated" | "Global" | "ReplicatedJob" | "GlobalJob"] ?? "replicated";
    const replicas = spec.Mode?.Replicated?.Replicas ?? spec.Mode?.ReplicatedJob?.TotalCompletions ?? null;
    if (!digest) warnings.push(`service ${name}: image ${image} is not pinned to a digest`);
    const restart = task.RestartPolicy ?? {};
    const svc: Service = {
      id: s.ID,
      name,
      short_name: shortName,
      stack,
      image,
      image_digest: digest,
      command: c.Command ?? [],
      args: c.Args ?? [],
      env,
      redacted_env: redacted,
      labels: labelsOf(spec.Labels),
      container_labels: labelsOf(c.Labels),
      mode,
      replicas,
      placement: {
        constraints: task.Placement?.Constraints ?? [],
        preferences: (task.Placement?.Preferences ?? []).map((p: Json) => JSON.stringify(p)),
        max_replicas_per_node: task.Placement?.MaxReplicas ?? null,
        platforms: (task.Placement?.Platforms ?? []).map((p: Json) => `${p.OS}/${p.Architecture}`),
      },
      networks: (task.Networks ?? spec.Networks ?? []).map((n: Json) => ({
        name: n.Target,
        aliases: n.Aliases ?? [],
      })),
      ports: ports(s.Endpoint ?? spec.EndpointSpec),
      mounts: mounts(c.Mounts),
      secrets: fileRefs(c.Secrets, "SecretID", "SecretName"),
      configs: fileRefs(c.Configs, "ConfigID", "ConfigName"),
      healthcheck: healthcheck(c.Healthcheck),
      resources: {
        limits: resourceSpec(task.Resources?.Limits),
        reservations: resourceSpec(task.Resources?.Reservations),
      },
      restart_policy: {
        condition: restart.Condition ?? "any",
        delay: nsToDuration(restart.Delay),
        max_attempts: restart.MaxAttempts ?? null,
        window: nsToDuration(restart.Window),
      },
      update_config: updateConfig(spec.UpdateConfig),
      rollback_config: updateConfig(spec.RollbackConfig),
      stop_grace_period: nsToDuration(c.StopGracePeriod),
      stop_signal: c.StopSignal ?? null,
      user: c.User ?? null,
      workdir: c.Dir ?? null,
      hostname: c.Hostname ?? null,
      dns: {
        nameservers: c.DNSConfig?.Nameservers ?? [],
        search: c.DNSConfig?.Search ?? [],
        options: c.DNSConfig?.Options ?? [],
      },
      extra_hosts: c.Hosts ?? [],
      cap_add: c.CapabilityAdd ?? [],
      cap_drop: c.CapabilityDrop ?? [],
      sysctls: labelsOf(c.Sysctls),
      ulimits: (c.Ulimits ?? []).map((u: Json) => ({ name: u.Name, soft: u.Soft, hard: u.Hard })),
      read_only: Boolean(c.ReadOnly),
      init: Boolean(c.Init),
      tty: Boolean(c.TTY),
      privileged: Boolean(c.Privileges?.NoNewPrivileges === false && (c.CapabilityAdd ?? []).includes("ALL")),
      logging: {
        driver: task.LogDriver?.Name ?? null,
        options: labelsOf(task.LogDriver?.Options),
      },
      endpoint_mode: spec.EndpointSpec?.Mode ?? "vip",
      tasks: tasksFor(name, taskRows, nodeByName),
    };
    return svc;
  });
}

function usedBy(svcs: Service[], pick: (s: Service) => string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const s of svcs) for (const key of pick(s)) m.set(key, [...(m.get(key) ?? []), s.name]);
  return m;
}

function networks(raw: Json[], svcs: Service[]): Network[] {
  const byId = usedBy(svcs, (s) => s.networks.map((n) => n.name));
  return raw.map((n) => ({
    id: n.Id,
    name: n.Name,
    driver: n.Driver,
    scope: n.Scope,
    ingress: Boolean(n.Ingress),
    internal: Boolean(n.Internal),
    attachable: Boolean(n.Attachable),
    encrypted: n.Options?.encrypted === "" || n.Options?.encrypted === "true",
    ipv6: Boolean(n.EnableIPv6),
    ipam: {
      driver: n.IPAM?.Driver ?? "default",
      config: (n.IPAM?.Config ?? []).map((c: Json) => ({
        ...(c.Subnet ? { subnet: c.Subnet } : {}),
        ...(c.Gateway ? { gateway: c.Gateway } : {}),
        ...(c.IPRange ? { ip_range: c.IPRange } : {}),
      })),
    },
    options: labelsOf(n.Options),
    labels: labelsOf(n.Labels),
    stack: n.Labels?.[STACK_LABEL] ?? null,
    used_by: [...(byId.get(n.Id) ?? []), ...(byId.get(n.Name) ?? [])],
  }));
}

function volumes(raw: Json[], svcs: Service[]): Volume[] {
  const byName = usedBy(svcs, (s) => s.mounts.filter((m) => m.type === "volume" && m.source).map((m) => m.source as string));
  return raw.map((v) => ({
    name: v.Name,
    driver: v.Driver,
    scope: v.Scope ?? "local",
    mountpoint: v.Mountpoint ?? null,
    options: labelsOf(v.Options),
    labels: labelsOf(v.Labels),
    stack: v.Labels?.[STACK_LABEL] ?? null,
    used_by: byName.get(v.Name) ?? [],
  }));
}

function secrets(raw: Json[], svcs: Service[]): Secret[] {
  const byName = usedBy(svcs, (s) => s.secrets.map((x) => x.name));
  return raw.map((s) => ({
    id: s.ID,
    name: s.Spec?.Name,
    labels: labelsOf(s.Spec?.Labels),
    created_at: s.CreatedAt,
    stack: s.Spec?.Labels?.[STACK_LABEL] ?? null,
    used_by: byName.get(s.Spec?.Name) ?? [],
  }));
}

function configs(raw: Json[], svcs: Service[]): Config[] {
  const byName = usedBy(svcs, (s) => s.configs.map((x) => x.name));
  return raw.map((c) => ({
    id: c.ID,
    name: c.Spec?.Name,
    labels: labelsOf(c.Spec?.Labels),
    created_at: c.CreatedAt,
    data_base64: c.Spec?.Data ?? null,
    stack: c.Spec?.Labels?.[STACK_LABEL] ?? null,
    used_by: byName.get(c.Spec?.Name) ?? [],
  }));
}

function stacks(svcs: Service[]): Stack[] {
  const m = new Map<string, string[]>();
  for (const s of svcs) if (s.stack) m.set(s.stack, [...(m.get(s.stack) ?? []), s.name]);
  return [...m.entries()].sort().map(([name, services]) => ({ name, services: services.sort() }));
}

export function normalize(dir: string, opts: { keepEnvValues?: boolean } = {}): Inventory {
  const warnings: string[] = [];
  const info = readJson(dir, "info.json", {});
  const manifest = existsSync(join(dir, "manifest.json"))
    ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
    : {};
  const nodeList = nodes(readJson(dir, "nodes.json"));
  const svcs = services(readJson(dir, "services.json"), readJsonl(dir, "tasks.jsonl"), nodeList, Boolean(opts.keepEnvValues), warnings);
  for (const s of svcs) {
    for (const t of s.tasks) {
      if (["failed", "rejected", "orphaned"].includes(t.current_state) || (t.desired_state === "running" && t.current_state !== "running")) {
        warnings.push(`service ${s.name}: task ${t.id} on ${t.node} is ${t.current_state} (${t.error || "no error text"})`);
      }
    }
    if (s.ports.some((p) => p.mode === "ingress")) {
      warnings.push(`service ${s.name}: publishes through the ingress routing mesh; systemd hosts publish per host`);
    }
  }
  const volumeNames = new Set((readJson(dir, "volumes.json") as Json[]).map((v) => v.Name));
  for (const s of svcs) {
    for (const m of s.mounts) {
      if (m.type === "volume" && m.source && !volumeNames.has(m.source)) {
        const where = s.tasks.map((t) => t.node).filter(Boolean).join(", ") || "the nodes running it";
        warnings.push(`service ${s.name}: volume ${m.source} is not present on the capturing node (volumes are node-local); capture or inspect it on ${where}`);
      }
    }
  }
  const nets = networks(readJson(dir, "networks.json"), svcs);
  for (const n of nets) if (n.encrypted) warnings.push(`network ${n.name}: encrypted overlay; cross-host transport must be replaced (see systemd-migration-plan/references/networking.md)`);
  const inv: Inventory = {
    version: "1",
    captured_at: manifest.captured_at ?? new Date().toISOString(),
    captured_on: manifest.captured_on,
    cluster: {
      id: info.Swarm?.Cluster?.ID ?? "",
      engine_version: info.ServerVersion ?? "",
      managers: info.Swarm?.Managers ?? nodeList.filter((n) => n.role === "manager").length,
      workers: info.Swarm?.Nodes !== undefined ? info.Swarm.Nodes - (info.Swarm.Managers ?? 0) : nodeList.filter((n) => n.role === "worker").length,
      is_leader: nodeList.some((n) => n.leader && n.id === (manifest.captured_node_id ?? info.Swarm?.NodeID)),
    },
    nodes: nodeList,
    stacks: stacks(svcs),
    services: svcs,
    networks: nets,
    volumes: volumes(readJson(dir, "volumes.json"), svcs),
    secrets: secrets(readJson(dir, "secrets.json"), svcs),
    configs: configs(readJson(dir, "configs.json"), svcs),
    warnings,
  };
  validate(inv);
  return inv;
}

/** Validate against the published JSON Schema plus cross-field checks. Throws on failure. */
export function validate(inv: Inventory): void {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const errors = validateSchema(inv, schema);
  if (errors.length > 0) {
    throw new Error(`inventory does not match ${SCHEMA_PATH}:\n${errors.slice(0, 20).map((e) => `  ${e.path}: ${e.message}`).join("\n")}${errors.length > 20 ? `\n  ... ${errors.length - 20} more` : ""}`);
  }
  const names = new Set<string>();
  for (const s of inv.services) {
    if (!s.name || !s.image) throw new Error(`service ${s.id ?? "?"} lacks a name or image`);
    if (names.has(s.name)) throw new Error(`duplicate service name ${s.name}`);
    names.add(s.name);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let dir: string | undefined;
  let out = "inventory.json";
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") out = argv[++i];
    else if (a === "--keep-env-values") keep = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: bun normalize.ts <capture-dir> [-o inventory.json] [--keep-env-values]");
      process.exit(0);
    } else dir = a;
  }
  if (!dir) {
    console.error("capture directory required");
    process.exit(2);
  }
  const inv = normalize(dir, { keepEnvValues: keep });
  writeFileSync(out, JSON.stringify(inv, null, 2) + "\n");
  console.log(`wrote ${out}: ${inv.nodes.length} nodes, ${inv.stacks.length} stacks, ${inv.services.length} services, ${inv.networks.length} networks, ${inv.volumes.length} volumes, ${inv.secrets.length} secrets, ${inv.configs.length} configs`);
  for (const w of inv.warnings) console.log(`warning: ${w}`);
}
