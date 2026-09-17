// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Inventory types shared by the systemd-dev-plugins skills. The JSON Schema in
// ./inventory-schema.json is the published contract; these types
// mirror it so the Bun scripts stay checkable without a schema library.

export type NodeRole = "manager" | "worker";
export type ServiceMode = "replicated" | "global" | "replicated-job" | "global-job";
export type PublishMode = "ingress" | "host";
export type MountType = "bind" | "volume" | "tmpfs" | "npipe" | "cluster";

export interface Inventory {
  version: "1";
  captured_at: string;
  captured_on?: string;
  cluster: Cluster;
  nodes: Node[];
  stacks: Stack[];
  services: Service[];
  networks: Network[];
  volumes: Volume[];
  secrets: Secret[];
  configs: Config[];
  warnings: string[];
}

export interface Cluster {
  id: string;
  engine_version: string;
  managers: number;
  workers: number;
  is_leader: boolean;
}

export interface Node {
  id: string;
  hostname: string;
  role: NodeRole;
  leader: boolean;
  availability: "active" | "pause" | "drain";
  state: string;
  addr: string;
  labels: Record<string, string>;
  engine_labels: Record<string, string>;
  engine_version: string;
  os: string;
  arch: string;
  nano_cpus: number;
  memory_bytes: number;
}

export interface Stack {
  name: string;
  services: string[];
}

export interface Port {
  target: number;
  published: number | null;
  protocol: "tcp" | "udp" | "sctp";
  mode: PublishMode;
}

export interface Mount {
  type: MountType;
  source: string | null;
  target: string;
  readonly: boolean;
  volume_nocopy?: boolean;
  volume_driver?: string;
  volume_options?: Record<string, string>;
  bind_propagation?: string;
  tmpfs_size_bytes?: number;
  tmpfs_mode?: number;
}

export interface FileRef {
  name: string;
  id: string;
  target: string;
  uid: string;
  gid: string;
  mode: number;
}

export interface Healthcheck {
  test: string[];
  interval: string | null;
  timeout: string | null;
  retries: number | null;
  start_period: string | null;
}

export interface ResourceSpec {
  nano_cpus: number | null;
  memory_bytes: number | null;
  pids: number | null;
}

export interface Task {
  id: string;
  node: string;
  desired_state: string;
  current_state: string;
  error: string;
}

export interface Service {
  id: string;
  name: string;
  short_name: string;
  stack: string | null;
  image: string;
  image_digest: string | null;
  command: string[];
  args: string[];
  env: Record<string, string>;
  redacted_env: string[];
  labels: Record<string, string>;
  container_labels: Record<string, string>;
  mode: ServiceMode;
  replicas: number | null;
  placement: {
    constraints: string[];
    preferences: string[];
    max_replicas_per_node: number | null;
    platforms: string[];
  };
  networks: { name: string; aliases: string[] }[];
  ports: Port[];
  mounts: Mount[];
  secrets: FileRef[];
  configs: FileRef[];
  healthcheck: Healthcheck | null;
  resources: { limits: ResourceSpec; reservations: ResourceSpec };
  restart_policy: {
    condition: "none" | "on-failure" | "any";
    delay: string | null;
    max_attempts: number | null;
    window: string | null;
  };
  update_config: UpdateConfig | null;
  rollback_config: UpdateConfig | null;
  stop_grace_period: string | null;
  stop_signal: string | null;
  user: string | null;
  workdir: string | null;
  hostname: string | null;
  dns: { nameservers: string[]; search: string[]; options: string[] };
  extra_hosts: string[];
  cap_add: string[];
  cap_drop: string[];
  sysctls: Record<string, string>;
  ulimits: { name: string; soft: number; hard: number }[];
  read_only: boolean;
  init: boolean;
  tty: boolean;
  privileged: boolean;
  logging: { driver: string | null; options: Record<string, string> };
  endpoint_mode: "vip" | "dnsrr";
  tasks: Task[];
}

export interface UpdateConfig {
  parallelism: number;
  delay: string | null;
  failure_action: string;
  monitor: string | null;
  max_failure_ratio: number;
  order: string;
}

export interface Network {
  id: string;
  name: string;
  driver: string;
  scope: string;
  ingress: boolean;
  internal: boolean;
  attachable: boolean;
  encrypted: boolean;
  ipv6: boolean;
  ipam: { driver: string; config: { subnet?: string; gateway?: string; ip_range?: string }[] };
  options: Record<string, string>;
  labels: Record<string, string>;
  stack: string | null;
  used_by: string[];
}

export interface Volume {
  name: string;
  driver: string;
  scope: string;
  mountpoint: string | null;
  options: Record<string, string>;
  labels: Record<string, string>;
  stack: string | null;
  used_by: string[];
}

export interface Secret {
  id: string;
  name: string;
  labels: Record<string, string>;
  created_at: string;
  stack: string | null;
  used_by: string[];
}

export interface Config {
  id: string;
  name: string;
  labels: Record<string, string>;
  created_at: string;
  data_base64: string | null;
  stack: string | null;
  used_by: string[];
}

/** Convert a Docker nanosecond duration into a systemd-style duration string. */
export function nsToDuration(ns: number | null | undefined): string | null {
  if (ns === null || ns === undefined || Number.isNaN(ns)) return null;
  if (ns === 0) return "0s";
  const totalMs = Math.round(ns / 1_000_000);
  const units: [string, number][] = [
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
    ["ms", 1],
  ];
  let rest = totalMs;
  const parts: string[] = [];
  for (const [suffix, size] of units) {
    if (rest >= size) {
      const n = Math.floor(rest / size);
      rest -= n * size;
      parts.push(`${n}${suffix}`);
    }
  }
  return parts.join("") || "0s";
}

/** Parse a systemd-style duration string (as produced by nsToDuration) into seconds. */
export function durationToSeconds(d: string | null | undefined): number | null {
  if (!d) return null;
  const re = /(\d+)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const m of d.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    switch (m[2]) {
      case "h": total += n * 3600; break;
      case "m": total += n * 60; break;
      case "s": total += n; break;
      case "ms": total += n / 1000; break;
    }
  }
  return matched ? total : null;
}
