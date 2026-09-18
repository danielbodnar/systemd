#!/usr/bin/env bun
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// normalize.ts: turn a capture directory produced by discover-podman's
// capture.sh into inventory.json, the contract every skill in the plugin
// consumes. It mirrors discover-docker-swarm/scripts/normalize.ts and
// reuses its redaction, healthcheck, label, image, and stack helpers so
// both adapters treat values identically.
//
// Usage: bun normalize.ts <capture-dir> [-o inventory.json]
//
// A Podman host is one node: every container becomes a replicated service
// with one replica and one task, every pod becomes a stack, and what
// Podman's inspect output does not carry directly (secrets, sysctls) is
// recovered from the recorded create command. Whatever cannot be mapped is
// a warning, never a silent drop.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileRef, Inventory, Mount, Network, Node, Port, Secret, Service, Task, Volume } from "../../../contract/types.ts";
import { validateSchema } from "../../../contract/schema.ts";
import { envToMap, healthcheck, images, labelsOf, stacks, usedBy } from "../../discover-docker-swarm/scripts/normalize.ts";

const SCHEMA_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contract", "inventory-schema.json");

/** Labels Podman, Buildah, and compose put on a container for their own bookkeeping; they describe the orchestrator, not the workload. */
const ORCHESTRATOR_LABEL = /^(io\.podman\.|io\.buildah\.|com\.docker\.compose\.|PODMAN_SYSTEMD_UNIT$)/;
/** Labels a container inherits from its image. */
const IMAGE_LABEL = /^org\.opencontainers\./;
const COMPOSE_PROJECT = "io.podman.compose.project";
/** Variables Podman sets in every container. */
const INJECTED_ENV = new Set(["container", "HOSTNAME"]);
/** The network every Podman host has; a container attached to it alone has no network of its own to render. */
const DEFAULT_NETWORK = "podman";
const CGROUP_PARENTS = new Set(["", "machine.slice", "user.slice", "system.slice"]);
const PROTOCOLS = new Set(["tcp", "udp", "sctp"]);

type Json = Record<string, any>;

function readJson(dir: string, name: string, fallback: unknown = []): any {
  const p = join(dir, "raw", name);
  if (!existsSync(p)) return fallback;
  const text = readFileSync(p, "utf8").trim();
  return text ? JSON.parse(text) : fallback;
}

/** Podman prints one object for a single id on older versions and an array otherwise. */
function asList(v: unknown): Json[] {
  if (Array.isArray(v)) return v as Json[];
  return v && typeof v === "object" ? [v as Json] : [];
}

/** Entrypoint and command as podman prints them: an array, or on older versions a string. */
function argv(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return v.split(/\s+/);
  return [];
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Values of `--flag value` and `--flag=value` in a recorded podman create command. */
function flagValues(cmd: string[], ...flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const a = cmd[i]!;
    for (const f of flags) {
      if (a === f && i + 1 < cmd.length) out.push(cmd[++i]!);
      else if (a.startsWith(`${f}=`)) out.push(a.slice(f.length + 1));
    }
  }
  return out;
}

interface SecretSpec {
  name: string;
  type: "mount" | "env";
  target: string | null;
  uid: string;
  gid: string;
  mode: number;
}

/** `name[,type=mount|env][,target=...][,uid=][,gid=][,mode=]` or `source=name,...` as podman run --secret takes it. */
function parseSecret(spec: string): SecretSpec | null {
  const parts = spec.split(",").filter(Boolean);
  if (parts.length === 0) return null;
  const opts: Record<string, string> = {};
  const first = parts[0]!;
  const positional = !first.includes("=");
  for (const p of parts.slice(positional ? 1 : 0)) {
    const eq = p.indexOf("=");
    if (eq > 0) opts[p.slice(0, eq)] = p.slice(eq + 1);
  }
  const name = positional ? first : (opts.source ?? "");
  if (!name) return null;
  const mode = opts.mode ? parseInt(opts.mode, 8) : 0o444;
  return { name, type: opts.type === "env" ? "env" : "mount", target: opts.target ?? null, uid: opts.uid ?? "0", gid: opts.gid ?? "0", mode: Number.isNaN(mode) ? 0o444 : mode };
}

/** A tmpfs size as podman accepts it (64m, 1g, bytes) in bytes. */
function parseSize(v: string): number | null {
  const m = /^(\d+)([kmgKMG]?)$/.exec(v);
  if (!m) return null;
  const mult: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(m[1]) * mult[m[2]!.toLowerCase()]!;
}

const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 9: "SIGKILL", 15: "SIGTERM" };

function signalName(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return SIGNALS[v] ?? String(v);
  return String(v);
}

/** Published ports of a container from its network settings (or the port bindings when a container is not running). */
function ports(c: Json, name: string, warnings: string[]): Port[] {
  const map: Json = c.NetworkSettings?.Ports ?? c.HostConfig?.PortBindings ?? {};
  const out: Port[] = [];
  for (const [key, bindings] of Object.entries(map).sort()) {
    const [t, proto = "tcp"] = key.split("/");
    if (!PROTOCOLS.has(proto)) {
      warnings.push(`container ${name}: port ${key} uses a protocol the inventory has no value for; not mapped`);
      continue;
    }
    for (const b of asList(bindings)) {
      const published = Number(b.HostPort);
      if (!published) continue;
      if (b.HostIp && !["", "0.0.0.0", "::"].includes(b.HostIp)) warnings.push(`container ${name}: port ${published}/${proto} is published on ${b.HostIp} only; the inventory records the port without the address`);
      if (!out.some((p) => p.target === Number(t) && p.published === published && p.protocol === proto)) out.push({ target: Number(t), published, protocol: proto as Port["protocol"], mode: "host" });
    }
  }
  return out;
}

function mounts(c: Json): Mount[] {
  const out: Mount[] = [];
  for (const m of asList(c.Mounts)) {
    const type: string = m.Type ?? "bind";
    if (type === "volume") {
      const mount: Mount = { type: "volume", source: m.Name ?? m.Source ?? null, target: m.Destination, readonly: m.RW === false };
      if (m.Driver && m.Driver !== "local") mount.volume_driver = m.Driver;
      out.push(mount);
    } else if (type === "bind") {
      const mount: Mount = { type: "bind", source: m.Source ?? null, target: m.Destination, readonly: m.RW === false };
      if (m.Propagation && m.Propagation !== "rprivate") mount.bind_propagation = m.Propagation;
      out.push(mount);
    } else if (type === "tmpfs") {
      out.push({ type: "tmpfs", source: null, target: m.Destination, readonly: m.RW === false });
    } else {
      out.push({ type: type as Mount["type"], source: m.Source ?? null, target: m.Destination, readonly: m.RW === false });
    }
  }
  // Tmpfs mounts live in HostConfig.Tmpfs as "path": "options".
  const tmpfs: Json = c.HostConfig?.Tmpfs ?? {};
  for (const [target, optText] of Object.entries(Array.isArray(tmpfs) ? Object.fromEntries((tmpfs as string[]).map((s) => [s.split(":")[0]!, s.split(":").slice(1).join(":")])) : tmpfs)) {
    if (out.some((m) => m.type === "tmpfs" && m.target === target)) continue;
    const mount: Mount = { type: "tmpfs", source: null, target, readonly: false };
    for (const o of String(optText ?? "").split(",")) {
      if (o === "ro") mount.readonly = true;
      else if (o.startsWith("size=")) {
        const n = parseSize(o.slice(5));
        if (n !== null) mount.tmpfs_size_bytes = n;
      } else if (o.startsWith("mode=")) mount.tmpfs_mode = parseInt(o.slice(5), 8);
    }
    out.push(mount);
  }
  return out;
}

function restartPolicy(hc: Json, name: string, managed: boolean, warnings: string[]): Service["restart_policy"] {
  const policy = String(hc.RestartPolicy?.Name ?? "");
  let condition: "none" | "on-failure" | "any";
  if (policy === "always" || policy === "unless-stopped") condition = "any";
  else if (policy === "on-failure") condition = "on-failure";
  else {
    condition = "none";
    if (!managed) warnings.push(`container ${name}: no restart policy; the rendered unit gets Restart=no, set restart_policy.condition in the inventory if it should restart`);
  }
  const max = Number(hc.RestartPolicy?.MaximumRetryCount ?? 0);
  return { condition, delay: null, max_attempts: condition === "on-failure" && max > 0 ? max : null, window: null };
}

interface PodInfo {
  pod: Json;
  infra: Json | null;
  members: Json[];
}

function digestFor(image: string, img: Json | undefined): string | null {
  const repo = image.replace(/:[^/:]+$/, "");
  for (const d of asList(img?.RepoDigests).map(String)) {
    const at = d.indexOf("@");
    if (at < 0) continue;
    const digest = d.slice(at + 1);
    if (d.slice(0, at) === repo && /^sha256:[0-9a-f]{64}$/.test(digest)) return digest;
  }
  return null;
}

function services(raw: Json[], podsRaw: Json[], imgs: Json[], secretIds: Map<string, string>, hostname: string, keepEnv: boolean, warnings: string[], envSecretUse: Map<string, string[]>): Service[] {
  const byId = new Map(raw.map((c) => [String(c.Id), c]));
  const pods = new Map<string, PodInfo>();
  const podOfContainer = new Map<string, PodInfo>();
  for (const p of podsRaw) {
    const infra = byId.get(String(p.InfraContainerID ?? "")) ?? null;
    const members = asList(p.Containers)
      .map((m) => byId.get(String(m.Id)))
      .filter((c): c is Json => Boolean(c) && !c!.IsInfra)
      .sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
    const info: PodInfo = { pod: p, infra, members };
    pods.set(String(p.Id), info);
    for (const m of members) podOfContainer.set(String(m.Id), info);
    const shared = asList(p.SharedNamespaces).map(String).filter((n) => ["ipc", "pid", "cgroup"].includes(n));
    if (shared.length) warnings.push(`pod ${p.Name}: its containers share the ${shared.join(", ")} namespace${shared.length > 1 ? "s" : ""}; systemd services do not, so review anything that relies on it`);
  }
  const out: Service[] = [];
  for (const c of raw) {
    if (c.IsInfra) continue;
    const name = String(c.Name ?? "").replace(/^\//, "");
    const cfg: Json = c.Config ?? {};
    const hc: Json = c.HostConfig ?? {};
    const podInfo = podOfContainer.get(String(c.Id)) ?? (c.Pod ? pods.get(String(c.Pod)) : undefined) ?? null;
    const stack = podInfo ? String(podInfo.pod.Name) : null;
    const shortName = stack && (name.startsWith(`${stack}-`) || name.startsWith(`${stack}_`)) ? name.slice(stack.length + 1) : name;
    const rawRef = String(c.ImageName ?? cfg.Image ?? "");
    const at = rawRef.indexOf("@");
    const image = at === -1 ? rawRef : rawRef.slice(0, at);
    const img = imgs.find((i) => i.Id === c.Image || `sha256:${i.Id}` === c.Image || (Array.isArray(i.RepoTags) ? (i.RepoTags as string[]) : []).includes(image));
    const digest = at === -1 ? digestFor(image, img) : rawRef.slice(at + 1);
    if (!digest) warnings.push(`service ${name}: image ${image} is not pinned to a digest`);
    const labels = labelsOf(cfg.Labels);
    const managed = Boolean(labels.PODMAN_SYSTEMD_UNIT);
    if (managed) warnings.push(`container ${name}: already run by systemd unit ${labels.PODMAN_SYSTEMD_UNIT}; the captured Quadlet files under quadlet/ record its unit settings`);

    // Environment: drop what Podman injects and what the image already sets, then redact.
    const imageEnv = new Set(asList(img?.Config?.Env).map(String));
    const envList = asList(cfg.Env).map(String).filter((e) => !INJECTED_ENV.has(e.split("=")[0]!) && !(img && imageEnv.has(e)));
    const { env, redacted } = envToMap(envList, keepEnv);

    // Entrypoint and command: what differs from the image; a changed entrypoint keeps both, since --entrypoint clears the image's command.
    const entrypoint = argv(cfg.Entrypoint);
    const cmd = argv(cfg.Cmd);
    let command: string[];
    let args: string[];
    if (img && same(entrypoint, argv(img.Config?.Entrypoint))) {
      command = [];
      args = same(cmd, argv(img.Config?.Cmd)) ? [] : cmd;
    } else {
      command = entrypoint;
      args = cmd;
    }

    // Secrets and sysctls are not in the inspect output; the recorded create command has them.
    const createCmd = argv(cfg.CreateCommand);
    const secrets: FileRef[] = [];
    for (const spec of flagValues(createCmd, "--secret")) {
      const s = parseSecret(spec);
      if (!s) continue;
      if (s.type === "env") {
        const key = s.target ?? s.name;
        env[key] = "<redacted>";
        if (!redacted.includes(key)) redacted.push(key);
        envSecretUse.set(s.name, [...(envSecretUse.get(s.name) ?? []), name]);
        warnings.push(`container ${name}: environment ${key} comes from Podman secret ${s.name}; the renderers name that credential ${name}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}, so create or alias it under that name`);
      } else {
        secrets.push({ name: s.name, id: secretIds.get(s.name) ?? "", target: s.target ?? s.name, uid: s.uid, gid: s.gid, mode: s.mode });
      }
    }
    if (createCmd.length === 0 && secretIds.size) warnings.push(`container ${name}: no create command was recorded, so any Podman secret it uses could not be linked; add it to services[${name}].secrets by hand`);
    const sysctls = labelsOf(hc.Sysctls);
    for (const kv of flagValues(createCmd, "--sysctl")) {
      const eq = kv.indexOf("=");
      if (eq > 0) sysctls[kv.slice(0, eq)] = kv.slice(eq + 1);
    }

    // Networks and ports come from the pod's infra container for a pod member.
    const netSource: Json = podInfo?.infra ?? c;
    const mode = String(netSource.HostConfig?.NetworkMode ?? "");
    if (mode === "host") warnings.push(`container ${name}: host network mode; a plain service shares the host's network anyway, a Quadlet container needs Network=host added by hand`);
    else if (["none", "slirp4netns", "pasta"].includes(mode) || mode.startsWith("slirp4netns:") || mode.startsWith("pasta:")) warnings.push(`container ${name}: network mode ${mode} has no inventory equivalent; the service gets no network`);
    const networks: { name: string; aliases: string[] }[] = [];
    for (const [netName, n] of Object.entries((netSource.NetworkSettings?.Networks ?? {}) as Json).sort()) {
      if (netName === DEFAULT_NETWORK) {
        warnings.push(`container ${name}: attached to Podman's default network only; no network is rendered for it, attach it to a named network or expect the target host's default`);
        continue;
      }
      // Podman adds the container's (or the pod's) id prefix as an alias; only the named ones carry over.
      const idPrefixes = [String(c.Id), ...(podInfo ? [String(podInfo.pod.Id), String(podInfo.infra?.Id ?? "")] : [])].filter(Boolean);
      networks.push({ name: netName, aliases: asList(n?.Aliases).map(String).filter((a) => !idPrefixes.some((id) => id.startsWith(a))) });
    }
    let published: Port[];
    if (podInfo?.infra) {
      const podPorts = ports(podInfo.infra, `${name} (pod ${stack})`, warnings);
      const exposed = new Set(Object.keys(cfg.ExposedPorts ?? {}));
      const first = podInfo.members[0];
      published = podPorts.filter((p) => {
        const key = `${p.target}/${p.protocol}`;
        if (exposed.has(key)) return true;
        const anyExposes = podInfo.members.some((m) => Object.keys(m.Config?.ExposedPorts ?? {}).includes(key));
        if (!anyExposes && first && first.Id === c.Id) {
          warnings.push(`pod ${stack}: port ${p.published}/${p.protocol} is published by the pod and no member image exposes ${key}; assigned to ${name}, move it if another member serves it`);
          return true;
        }
        return false;
      });
    } else published = ports(c, name, warnings);

    const memory = Number(hc.Memory ?? 0);
    const nano = Number(hc.NanoCpus ?? 0) || (Number(hc.CpuQuota ?? 0) > 0 && Number(hc.CpuPeriod ?? 0) > 0 ? Math.round((Number(hc.CpuQuota) / Number(hc.CpuPeriod)) * 1e9) : 0);
    const pids = Number(hc.PidsLimit ?? 0);
    const reservation = Number(hc.MemoryReservation ?? 0);
    if (Number(hc.CpuShares ?? 0) > 0) warnings.push(`container ${name}: cpu shares ${hc.CpuShares} are not mapped; set a CPU reservation or CPUWeight= by hand`);
    for (const [field, text] of [["Devices", "devices"], ["SecurityOpt", "security options"], ["GroupAdd", "supplementary groups"]] as const) {
      const list = (Array.isArray(hc[field]) ? (hc[field] as unknown[]) : []).filter((x) => x !== "" && x !== null);
      if (list.length) warnings.push(`container ${name}: ${text} (${list.map((x) => (typeof x === "string" ? x : String((x as Json).PathOnHost ?? JSON.stringify(x)))).join(", ")}) are not mapped; add them to the rendered unit by hand`);
    }
    if (hc.UsernsMode) warnings.push(`container ${name}: user namespace mode ${hc.UsernsMode} is not mapped`);
    if (hc.CgroupParent && !CGROUP_PARENTS.has(String(hc.CgroupParent))) warnings.push(`container ${name}: cgroup parent ${hc.CgroupParent} is not mapped; the resource-control component chooses the slice`);
    const status = String(c.State?.Status ?? "unknown").toLowerCase();
    if (status !== "running") warnings.push(`container ${name}: is ${status}${c.State?.Error ? ` (${c.State.Error})` : ""}; migrating it reproduces that state`);
    const hostnameRaw = String(cfg.Hostname ?? "");
    const hostnameIsId = !hostnameRaw || String(c.Id).startsWith(hostnameRaw) || Boolean(podInfo?.infra && String(podInfo.infra.Id).startsWith(hostnameRaw));
    const stopTimeout = typeof cfg.StopTimeout === "number" ? cfg.StopTimeout : null;
    const task: Task = { id: String(c.Id), node: hostname, desired_state: "running", current_state: status, error: String(c.State?.Error ?? "") };

    out.push({
      id: String(c.Id),
      name,
      short_name: shortName,
      stack,
      image,
      image_digest: digest,
      command,
      args,
      env,
      redacted_env: redacted,
      labels: Object.fromEntries(Object.entries(labels).filter(([k]) => ORCHESTRATOR_LABEL.test(k))),
      container_labels: Object.fromEntries(Object.entries(labels).filter(([k]) => !ORCHESTRATOR_LABEL.test(k) && !IMAGE_LABEL.test(k))),
      mode: "replicated",
      replicas: 1,
      placement: { constraints: [], preferences: [], max_replicas_per_node: null, platforms: [] },
      networks,
      ports: published,
      mounts: mounts(c),
      secrets,
      configs: [],
      healthcheck: healthcheck(cfg.Healthcheck),
      resources: {
        limits: { nano_cpus: nano > 0 ? nano : null, memory_bytes: memory > 0 ? memory : null, pids: pids > 0 ? pids : null },
        reservations: { nano_cpus: null, memory_bytes: reservation > 0 ? reservation : null, pids: null },
      },
      restart_policy: restartPolicy(hc, name, managed, warnings),
      update_config: null,
      rollback_config: null,
      stop_grace_period: stopTimeout === null ? null : `${stopTimeout}s`,
      stop_signal: signalName(cfg.StopSignal),
      user: cfg.User ? String(cfg.User) : null,
      workdir: cfg.WorkingDir ? String(cfg.WorkingDir) : null,
      hostname: hostnameIsId ? null : hostnameRaw,
      dns: { nameservers: asList(hc.Dns).map(String), search: asList(hc.DnsSearch).map(String), options: asList(hc.DnsOptions).map(String) },
      extra_hosts: asList(hc.ExtraHosts).map(String),
      cap_add: asList(hc.CapAdd).map(String),
      cap_drop: asList(hc.CapDrop).map(String),
      sysctls,
      ulimits: asList(hc.Ulimits).map((u) => ({ name: String(u.Name).replace(/^RLIMIT_/i, "").toLowerCase(), soft: Number(u.Soft), hard: Number(u.Hard) })),
      read_only: Boolean(hc.ReadonlyRootfs),
      init: Boolean(hc.Init),
      tty: Boolean(cfg.Tty),
      privileged: Boolean(hc.Privileged),
      logging: { driver: hc.LogConfig?.Type ? String(hc.LogConfig.Type) : null, options: labelsOf(hc.LogConfig?.Config) },
      endpoint_mode: "dnsrr",
      tasks: [task],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function networks(raw: Json[], svcs: Service[], warnings: string[]): Network[] {
  const byName = usedBy(svcs, (s) => s.networks.map((n) => n.name));
  const out: Network[] = [];
  for (const n of raw) {
    const name = String(n.name ?? n.Name ?? "");
    if (!name || name === DEFAULT_NETWORK) continue;
    const config: { subnet?: string; gateway?: string; ip_range?: string }[] = [];
    for (const s of asList(n.subnets)) {
      config.push({ ...(s.subnet ? { subnet: String(s.subnet) } : {}), ...(s.gateway ? { gateway: String(s.gateway) } : {}) });
      if (s.lease_range) warnings.push(`network ${name}: the DHCP lease range ${s.lease_range.start_ip ?? "?"} to ${s.lease_range.end_ip ?? "?"} is not representable; the rendered network allocates from the whole subnet`);
    }
    const labels = labelsOf(n.labels ?? n.Labels);
    out.push({
      id: String(n.id ?? n.Id ?? name),
      name,
      driver: String(n.driver ?? n.Driver ?? "bridge"),
      scope: "local",
      ingress: false,
      internal: Boolean(n.internal),
      attachable: true,
      encrypted: false,
      ipv6: Boolean(n.ipv6_enabled),
      ipam: { driver: String(n.ipam_options?.driver ?? "host-local"), config },
      options: labelsOf(n.options ?? n.Options),
      labels,
      stack: labels[COMPOSE_PROJECT] ?? null,
      used_by: byName.get(name) ?? [],
    });
  }
  return out;
}

function volumes(raw: Json[], svcs: Service[]): Volume[] {
  const byName = usedBy(svcs, (s) => s.mounts.filter((m) => m.type === "volume" && m.source).map((m) => m.source as string));
  return raw.map((v) => {
    const labels = labelsOf(v.Labels);
    return {
      name: String(v.Name),
      driver: String(v.Driver ?? "local"),
      scope: String(v.Scope ?? "local"),
      mountpoint: v.Mountpoint ? String(v.Mountpoint) : null,
      options: labelsOf(v.Options),
      labels,
      stack: labels[COMPOSE_PROJECT] ?? null,
      used_by: byName.get(String(v.Name)) ?? [],
    };
  });
}

function secrets(raw: Json[], svcs: Service[], envUse: Map<string, string[]>): Secret[] {
  const byName = usedBy(svcs, (s) => s.secrets.map((x) => x.name));
  return raw.map((s) => {
    const name = String(s.Name);
    const driver = typeof s.Driver === "string" ? s.Driver : (s.Driver?.Name ?? s.Spec?.Driver?.Name ?? null);
    const users = [...new Set([...(byName.get(name) ?? []), ...(envUse.get(name) ?? [])])].sort();
    const labels: Record<string, string> = {};
    if (driver) labels["podman.secret.driver"] = String(driver);
    return { id: String(s.ID ?? ""), name, labels, created_at: String(s.CreatedAt ?? ""), stack: null, used_by: users };
  });
}

function node(info: Json, manifest: Json): Node {
  const host: Json = info.host ?? {};
  const hostname = String(host.hostname ?? manifest.captured_on ?? "podman-host");
  return {
    id: hostname,
    hostname,
    role: "manager",
    leader: true,
    availability: "active",
    state: "ready",
    addr: "",
    labels: {},
    engine_labels: {
      "podman.rootless": String(Boolean(host.security?.rootless)),
      "podman.cgroup_version": String(host.cgroupVersion ?? ""),
      ...(host.distribution?.distribution ? { "podman.distribution": String(host.distribution.distribution) } : {}),
    },
    engine_version: String(info.version?.Version ?? ""),
    os: String(host.os ?? "linux"),
    arch: String(host.arch ?? ""),
    nano_cpus: Math.round(Number(host.cpus ?? 0) * 1e9),
    memory_bytes: Number(host.memTotal ?? 0),
  };
}

/** Relative paths of the Quadlet files the capture copied, for the warning that lists them. */
function quadletFiles(dir: string): string[] {
  const root = join(dir, "quadlet");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push("/" + relative(root, p));
    }
  };
  walk(root);
  return out;
}

export function normalize(dir: string, opts: { keepEnvValues?: boolean } = {}): Inventory {
  const warnings: string[] = [];
  const info: Json = readJson(dir, "info.json", {});
  const manifest: Json = existsSync(join(dir, "manifest.json")) ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) : {};
  const host = node(info, manifest);
  const secretsRaw = asList(readJson(dir, "secrets.json"));
  const secretIds = new Map(secretsRaw.map((s) => [String(s.Name), String(s.ID ?? "")]));
  const imagesRaw = asList(readJson(dir, "images.json"));
  const envSecretUse = new Map<string, string[]>();
  const svcs = services(asList(readJson(dir, "containers.json")), asList(readJson(dir, "pods.json")), imagesRaw, secretIds, host.hostname, Boolean(opts.keepEnvValues), warnings, envSecretUse);
  const volumeNames = new Set(asList(readJson(dir, "volumes.json")).map((v) => String(v.Name)));
  for (const s of svcs) {
    for (const m of s.mounts) {
      if (m.type === "volume" && m.source && !volumeNames.has(m.source)) warnings.push(`service ${s.name}: volume ${m.source} is not in the capture; inspect it on ${host.hostname}`);
    }
  }
  const quadlet = quadletFiles(dir);
  if (quadlet.length) warnings.push(`existing Quadlet files were captured under quadlet/ and are not parsed: ${quadlet.join(", ")}`);
  const inv: Inventory = {
    version: "1",
    captured_at: manifest.captured_at ?? new Date().toISOString(),
    captured_on: manifest.captured_on ?? host.hostname,
    cluster: { id: `podman:${host.hostname}`, engine_version: host.engine_version, managers: 1, workers: 0, is_leader: true },
    nodes: [host],
    stacks: stacks(svcs),
    services: svcs,
    networks: networks(asList(readJson(dir, "networks.json")), svcs, warnings),
    volumes: volumes(asList(readJson(dir, "volumes.json")), svcs),
    secrets: secrets(secretsRaw, svcs, envSecretUse),
    configs: [],
    warnings,
  };
  if (existsSync(join(dir, "raw", "images.json"))) inv.images = images(imagesRaw, svcs, Boolean(opts.keepEnvValues), warnings);
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") out = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: bun normalize.ts <capture-dir> [-o inventory.json]");
      process.exit(0);
    } else dir = a;
  }
  if (!dir) {
    console.error("capture directory required");
    process.exit(2);
  }
  const inv = normalize(dir);
  writeFileSync(out, JSON.stringify(inv, null, 2) + "\n");
  console.log(`wrote ${out}: ${inv.nodes.length} node, ${inv.stacks.length} pods, ${inv.services.length} containers, ${inv.networks.length} networks, ${inv.volumes.length} volumes, ${inv.secrets.length} secrets`);
  for (const w of inv.warnings) console.log(`warning: ${w}`);
}
