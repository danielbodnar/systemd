// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The component interface. A systemd component (service, machined,
// networkd, creds, ...) is a module that knows one part of systemd: which
// man pages it covers, what a host must provide, which decisions it needs
// before it can render, and how it contributes files and unit directives
// to a host's tree. The compose engine (compose.ts) runs every registered
// component's decide() to build plan.yaml, and every component's render()
// per host, in dependency order, to build the rendered tree. Components
// share unit files through the render context, so the creds component adds
// LoadCredentialEncrypted= lines to a unit the service component created,
// and the networkd component adds SocketBindAllow= lines to the same unit.

import type { Inventory, Network, Service } from "./types.ts";
import type { Decision, HostCapabilities, Plan } from "./plan.ts";
import { decisionValue, findDecision, splitList } from "./plan.ts";
import { UnitFile } from "./unit.ts";

/** A decision as a component raises it; the engine fills in `component`. */
export type DecisionSpec = Omit<Decision, "component">;

export interface Component {
  /** Short id, also the first segment of every decision id it raises: `networkd`, `creds`. */
  id: string;
  title: string;
  /** The man pages this component implements, by name (`systemd.network`, `importctl`); the coverage test reads them. */
  covers: string[];
  /** Components whose render() must run before this one on a host. */
  after?: string[];
  decide(ctx: PlanContext): DecisionSpec[];
  render(ctx: RenderContext): void;
  /** Runs after every component's render() on the host, for output that depends on what the others registered (stack targets). */
  finish?(ctx: RenderContext): void;
}

/** What a component sees when raising decisions: the inventory, the target hosts, and the placement the plan implies. */
export class PlanContext {
  readonly placement = new Map<string, Map<string, number>>();
  constructor(
    readonly inventory: Inventory,
    readonly hosts: Record<string, HostCapabilities | null>,
    readonly existing: Plan | null,
  ) {}

  /** Target host names, from the probes when present, else the inventory's nodes. */
  get hostNames(): string[] {
    const probed = Object.keys(this.hosts);
    return probed.length ? probed : this.inventory.nodes.map((n) => n.hostname);
  }

  service(name: string): Service | undefined {
    return this.inventory.services.find((s) => s.name === name);
  }

  network(ref: string): Network | undefined {
    return this.inventory.networks.find((n) => n.name === ref || n.id === ref);
  }

  /** Hosts a service lands on under the current placement. */
  hostsOf(service: string): string[] {
    return [...(this.placement.get(service)?.keys() ?? [])];
  }

  /** Hosts the members of a network land on. */
  hostsOfNetwork(net: Network): string[] {
    const out = new Set<string>();
    for (const s of net.used_by) for (const h of this.hostsOf(s)) out.add(h);
    return [...out].sort();
  }

  /** A previously chosen value for a decision id, if the earlier plan had one. */
  previous(id: string): string | null {
    return this.existing ? (findDecision(this.existing, id)?.chosen ?? null) : null;
  }
}

/** What the render driver records for a host; the verifier reads it as expected.json. */
export interface HostExpectation {
  hostname: string;
  units: string[];
  targets: string[];
  slices: string[];
  timers: string[];
  mounts: string[];
  sockets: string[];
  machines: string[];
  /** Container names of the services rendered as Quadlet containers; the Podman verifier checks them. */
  containers: string[];
  /** Podman secret names the Quadlet containers reference; imported by import-secrets.sh. */
  secrets: string[];
  networks: string[];
  ports: { port: number; protocol: string }[];
  credentials: string[];
  images: string[];
  volumes: string[];
  root_kind: "RootMStack" | "RootImage";
}

export interface ImageEntry {
  ref: string;
  digest: string | null;
  hosts: string[];
  services: string[];
}

/** One service instance placed on the host being rendered. */
export interface Instance {
  service: Service;
  stack: string;
  /** 1-based instance number and the number of instances on this host. */
  index: number;
  count: number;
  /** `web_app` or `web_app-2`. */
  base: string;
  /** The primary unit: `web_app.service`, or the nspawn or vmspawn unit when the plan chose that form. */
  unit: string;
  /** The rendering form the plan chose: a plain service, a machine, a virtual machine, a portable service, a Quadlet container. */
  form: string;
}

export type NoteKind = "decision" | "review";

/**
 * Everything a component may read and write while rendering one host. Units
 * are shared: `unit()` returns the same builder for the same name whichever
 * component asks, and the engine writes them all at the end. `set()` and
 * `get()` pass typed state between components (the service component
 * records the user a unit runs as; storage reads it to own a volume).
 */
export class RenderContext {
  readonly files = new Map<string, { content: string | Uint8Array; mode: number }>();
  readonly notes: { kind: NoteKind; text: string }[] = [];
  readonly expected: HostExpectation;
  readonly images = new Map<string, ImageEntry>();
  private readonly units = new Map<string, { unit: UnitFile; path: string }>();
  private readonly state = new Map<string, unknown>();
  private readonly installPre: string[] = [];
  private readonly installPost: string[] = [];
  private readonly stackUnits = new Map<string, Set<string>>();

  constructor(
    readonly inventory: Inventory,
    readonly plan: Plan,
    readonly host: string,
    readonly capabilities: HostCapabilities | null,
    readonly instances: Instance[],
    readonly acceptDefaults: boolean,
    readonly rendererName: string,
  ) {
    this.expected = {
      hostname: host,
      units: [],
      targets: [],
      slices: [],
      timers: [],
      mounts: [],
      sockets: [],
      machines: [],
      containers: [],
      secrets: [],
      networks: [],
      ports: [],
      credentials: [],
      images: [],
      volumes: [],
      root_kind: "RootMStack",
    };
  }

  /** The effective value of a decision; throws when unresolved and defaults are not accepted. */
  value(id: string): string {
    return decisionValue(this.plan, id, this.acceptDefaults);
  }

  /** The value when the decision exists and is resolvable, else the fallback. */
  valueOr(id: string, fallback: string): string {
    const d = findDecision(this.plan, id);
    if (!d) return fallback;
    if (d.chosen != null) return d.chosen;
    if (d.default != null && this.acceptDefaults) return d.default;
    return fallback;
  }

  hasDecision(id: string): boolean {
    return findDecision(this.plan, id) !== undefined;
  }

  list(id: string): string[] {
    return splitList(this.value(id));
  }

  /** Whether the decision exists and resolves to a value; false when it would throw. */
  resolvable(id: string): boolean {
    const d = findDecision(this.plan, id);
    return !!d && (d.chosen != null || (d.default != null && this.acceptDefaults));
  }

  /** The builder for a unit under /etc/systemd/system, created with the header on first use. */
  unit(name: string, header: string[] = []): UnitFile {
    return this.unitAt(`etc/systemd/system/${name}`, header);
  }

  /** The builder for any unit-style file at a path relative to the host root. */
  unitAt(path: string, header: string[] = []): UnitFile {
    let entry = this.units.get(path);
    if (!entry) {
      entry = { unit: new UnitFile(header), path };
      this.units.set(path, entry);
    }
    return entry.unit;
  }

  hasUnit(name: string): boolean {
    return this.units.has(`etc/systemd/system/${name}`);
  }

  file(rel: string, content: string | Uint8Array, mode?: number): void {
    this.files.set(rel, { content, mode: mode ?? (rel.endsWith(".sh") ? 0o755 : rel.includes("/secrets/") || rel.endsWith(".env") ? 0o600 : 0o644) });
  }

  note(text: string, kind: NoteKind = "review"): void {
    if (!this.notes.some((n) => n.text === text)) this.notes.push({ kind, text });
  }

  /** Append to a list in expected.json without duplicates. */
  expect<K extends "units" | "targets" | "slices" | "timers" | "mounts" | "sockets" | "machines" | "containers" | "secrets" | "networks" | "credentials" | "images" | "volumes">(key: K, value: string): void {
    const list = this.expected[key];
    if (!list.includes(value)) list.push(value);
  }

  expectPort(port: number, protocol: string): void {
    if (!this.expected.ports.some((p) => p.port === port && p.protocol === protocol)) this.expected.ports.push({ port, protocol });
  }

  /** Record an image the host needs; the engine writes images.json across hosts. */
  image(name: string, ref: string, digest: string | null, service: string): ImageEntry {
    let e = this.images.get(name);
    if (!e) {
      e = { ref, digest, hosts: [this.host], services: [] };
      this.images.set(name, e);
    }
    if (!e.digest && digest) e.digest = digest;
    if (!e.services.includes(service)) e.services.push(service);
    return e;
  }

  /** A unit the stack's target should want. */
  wantedByStack(stack: string, unit: string): void {
    const set = this.stackUnits.get(stack) ?? new Set<string>();
    this.stackUnits.set(stack, set);
    set.add(unit);
  }

  stacks(): Map<string, string[]> {
    return new Map([...this.stackUnits].sort().map(([k, v]) => [k, [...v].sort()]));
  }

  /** Shell lines install.sh runs before (`pre`) or after (`post`) daemon-reload. */
  install(phase: "pre" | "post", line: string): void {
    const list = phase === "pre" ? this.installPre : this.installPost;
    if (!list.includes(line)) list.push(line);
  }

  installLines(phase: "pre" | "post"): string[] {
    return [...(phase === "pre" ? this.installPre : this.installPost)];
  }

  set<T>(key: string, value: T): T {
    this.state.set(key, value);
    return value;
  }

  get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  /** Every unit builder with its path, for the engine. */
  unitFiles(): { path: string; unit: UnitFile }[] {
    return [...this.units.values()].map((e) => ({ path: e.path, unit: e.unit }));
  }
}

/** The key under which the service component publishes an instance's shape for the other components. */
export function instanceKey(base: string): string {
  return `service:${base}`;
}

/** What the service component records per instance, for the components that add to its unit. */
export interface ServiceShape {
  base: string;
  unit: string;
  root: string;
  rootKind: "RootMStack" | "RootImage";
  user: string | null;
  group: string | null;
  dynamic: boolean;
  searchPath: string | null;
  isJob: boolean;
  stack: string;
}
