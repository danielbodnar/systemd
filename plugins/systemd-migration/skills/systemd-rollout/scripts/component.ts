// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The rollout component: what docker service update, docker stack deploy,
// rollback, and node drain become on a systemd host. It renders a rollout
// specification per stack from the source's update_config and
// rollback_config and a POSIX sh controller per host that drives systemctl,
// the versioned image directories (systemd.v), and the health units through
// a rolling update with the source's parallelism, delay, order, failure
// action, and monitor window.

import { readFileSync } from "node:fs";
import type { Component, DecisionSpec, Instance, PlanContext, RenderContext } from "../../../contract/component.ts";
import { durationToSeconds, type Service } from "../../../contract/types.ts";
import { credentialNameFor } from "../../systemd-creds/scripts/component.ts";
import { PROXIES, type Proxy } from "../../systemd-networkd/scripts/shared.ts";
import { configsId } from "../../systemd-sysext/scripts/component.ts";

/** Where the specifications and the controller live on a host. */
export const SPEC_DIR = "/etc/systemd-migration/rollout";
export const CONTROLLER = "/usr/local/lib/systemd-migration/stackctl";
/** Where the controller keeps the image target it replaced, so rollback has something to go back to. */
export const STATE_DIR = "/var/lib/systemd-migration/rollout";
/** Where install.sh puts the credential import script the rotate verb re-runs. */
export const CREDENTIAL_SCRIPT = "/usr/local/lib/systemd-migration/import-credentials.sh";

/** Whether the batch keeps the other instances up (start-first) or stops the batch first (stop-first). */
export function orderId(service: string): string {
  return `rollout.order.${service}`;
}
/** What the controller does when a batch does not come back healthy. */
export function failureId(service: string): string {
  return `rollout.failure.${service}`;
}
/** How long a batch is watched before the next one starts. */
export const MONITOR = "rollout.monitor.estate";

const ORDERS = new Set(["start-first", "stop-first"]);
const FAILURE_ACTIONS = new Set(["pause", "continue", "rollback"]);

/** The default monitor window when neither the source nor the operator names one. */
export const DEFAULT_MONITOR = "30s";
export const DEFAULT_PARALLELISM = 1;
export const DEFAULT_DELAY = "0s";
export const DEFAULT_MAX_FAILURE_RATIO = "0";

/** Services that get rollout decisions: the source described an update, a rollback, or there is more than one replica. */
export function needsRollout(svc: Service, hostCount: number): boolean {
  return svc.update_config !== null || svc.rollback_config !== null || (svc.replicas ?? 0) > 1 || hostCount > 1;
}

/** The longest monitor window the source names anywhere in the estate, as a systemd time span. */
export function longestMonitor(services: Service[]): { span: string; from: string | null } {
  let best: { span: string; from: string } | null = null;
  for (const svc of services) {
    for (const [cfg, field] of [
      [svc.update_config, "update_config"],
      [svc.rollback_config, "rollback_config"],
    ] as const) {
      const span = cfg?.monitor;
      if (!span) continue;
      const seconds = durationToSeconds(span);
      if (seconds === null) continue;
      if (!best || seconds > (durationToSeconds(best.span) ?? 0)) best = { span, from: `services[${svc.name}].${field}.monitor=${span}` };
    }
  }
  return best ? { span: best.span, from: best.from } : { span: DEFAULT_MONITOR, from: null };
}

/** One service's line in a stack's specification. */
interface SpecService {
  name: string;
  units: string[];
  health: string[];
  sockets: string[];
  credentials: string[];
  configs: string[];
  parallelism: string;
  delay: string;
  order: string;
  failureAction: string;
  monitor: string;
  maxFailureRatio: string;
  image: string;
  form: string;
}

export const rolloutComponent: Component = {
  id: "rollout",
  title: "Rollouts, rollback, and drain (systemctl, systemd-run, systemd.v)",
  covers: ["systemctl", "systemd-run", "systemd-run-generator", "systemd.offline-updates"],
  // The specification names the units, the health units, the sockets, the
  // credentials, and the image path the other components rendered, so every
  // one of them must have run on this host first.
  after: ["service", "machined", "creds", "networkd", "sysext"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    for (const svc of [...ctx.inventory.services].sort((a, b) => a.name.localeCompare(b.name))) {
      const hosts = ctx.hostsOf(svc.name);
      if (!needsRollout(svc, hosts.length)) continue;
      const update = svc.update_config;
      const sourceOrder = update && ORDERS.has(update.order) ? update.order : null;
      out.push({
        id: orderId(svc.name),
        kind: "choice",
        subject: { kind: "service", name: svc.name },
        question: `In what order does a batch of ${svc.name} change over during a deploy?`,
        options: [
          { value: "stop-first", label: "stop the batch, then start it", consequence: "the batch's capacity is gone while it restarts; the only order a single instance can have" },
          { value: "start-first", label: "keep the rest up, then restart the batch", consequence: "the controller confirms the instances outside the batch are active before restarting it, so capacity never drops below the instance count minus the parallelism" },
        ],
        default: sourceOrder ?? "stop-first",
        evidence: [
          ...(update ? [`services[${svc.name}].update_config.order=${update.order}`] : [`services[${svc.name}].update_config is absent; stop-first is the safe order`]),
          `services[${svc.name}].replicas=${svc.replicas ?? "null"}`,
          ...(hosts.length ? [`placement.hosts.${svc.name}=${hosts.join(",")}`] : []),
        ],
      });
      const sourceFailure = update && FAILURE_ACTIONS.has(update.failure_action) ? update.failure_action : null;
      out.push({
        id: failureId(svc.name),
        kind: "choice",
        subject: { kind: "service", name: svc.name },
        question: `What does the controller do when a batch of ${svc.name} is not active and healthy within the monitor window?`,
        options: [
          { value: "pause", label: "stop the deploy where it is", consequence: "the remaining batches are left alone and the controller exits non-zero; the operator decides what follows" },
          { value: "continue", label: "carry on with the next batch", consequence: "every batch is changed over whatever the health results say; only for services where a failing instance costs nothing" },
          { value: "rollback", label: "roll the service back", consequence: "the image target this deploy replaced is restored and the service's instances are restarted in the same batches before the controller exits non-zero" },
        ],
        default: sourceFailure ?? "pause",
        evidence: [
          ...(update ? [`services[${svc.name}].update_config.failure_action=${update.failure_action}`] : [`services[${svc.name}].update_config is absent; pausing leaves the estate for a human`]),
          ...(svc.rollback_config ? [`services[${svc.name}].rollback_config.order=${svc.rollback_config.order}`] : []),
          ...(svc.healthcheck ? [`services[${svc.name}].healthcheck.test`] : [`services[${svc.name}] has no healthcheck; only the unit's own state is watched`]),
        ],
      });
    }
    const longest = longestMonitor(ctx.inventory.services);
    out.push({
      id: MONITOR,
      kind: "value",
      format: "text",
      subject: { kind: "estate", name: "estate" },
      question: "How long is a batch watched after it changes over, before the deploy moves on? A systemd time span (systemd.time(7)), used for every service whose source named no monitor window.",
      default: longest.span,
      evidence: longest.from ? [longest.from, "the longest monitor window the source names"] : ["no service names a monitor window; 30s is the controller's own default"],
    });
    return out;
  },

  render(ctx: RenderContext): void {
    const byStack = new Map<string, Instance[]>();
    for (const inst of ctx.instances) {
      const list = byStack.get(inst.stack) ?? [];
      byStack.set(inst.stack, list);
      list.push(inst);
    }
    if (byStack.size === 0) return;
    const estateMonitor = ctx.valueOr(MONITOR, DEFAULT_MONITOR);
    // The sockets a drain must close come from two places: the ones
    // expected.json records for the instances (socket activation and
    // reuseport), and the socket-proxyd sockets the networkd component
    // publishes under networkd:proxies, which also front the backends on
    // other hosts. Without that table the line covers the local sockets only.
    const proxies = ctx.get<Proxy[]>(PROXIES);
    if (!proxies) ctx.note(`${ctx.host}: the networkd component published no proxy table (${PROXIES}), so the rollout specification's Sockets= lines carry only the sockets expected.json records for this host's instances`);

    for (const [stack, instances] of [...byStack].sort()) {
      const services: SpecService[] = [];
      const names = [...new Set(instances.map((i) => i.service.name))].sort();
      for (const name of names) {
        const mine = instances.filter((i) => i.service.name === name).sort((a, b) => a.index - b.index);
        const svc = mine[0]!.service;
        const update = svc.update_config;
        const root = ctx.get<{ root: string; kind: string }>(`machined:root:${svc.image}`);
        if (update === null) ctx.note(`${svc.name}: the source describes no update_config; the rollout specification takes parallelism ${DEFAULT_PARALLELISM}, delay ${DEFAULT_DELAY}, and max failure ratio ${DEFAULT_MAX_FAILURE_RATIO}, and the order and failure action come from ${orderId(svc.name)} and ${failureId(svc.name)} when those decisions exist`);
        services.push({
          name,
          units: mine.map((i) => i.unit),
          health: mine.map((i) => `${i.base}-health.service`).filter((u) => ctx.hasUnit(u)),
          sockets: socketsOf(ctx, name, mine, proxies),
          credentials: credentialsOf(ctx, svc),
          configs: svc.configs.map((c) => c.name).sort(),
          parallelism: String(update?.parallelism ?? DEFAULT_PARALLELISM),
          delay: update?.delay ?? DEFAULT_DELAY,
          order: ctx.valueOr(orderId(name), update && ORDERS.has(update.order) ? update.order : "stop-first"),
          failureAction: ctx.valueOr(failureId(name), update && FAILURE_ACTIONS.has(update.failure_action) ? update.failure_action : "pause"),
          monitor: update?.monitor ?? estateMonitor,
          maxFailureRatio: update ? String(update.max_failure_ratio) : DEFAULT_MAX_FAILURE_RATIO,
          image: root?.root ?? "",
          form: mine[0]!.form,
        });
      }
      ctx.file(`etc/systemd-migration/rollout/${stack}.conf`, specFile(ctx, stack, estateMonitor, services));
    }

    ctx.file("usr/local/lib/systemd-migration/stackctl", controllerText(), 0o755);
    // install.sh copies etc/ only (see finishHost in contract/compose.ts), so
    // everything outside it is installed by name, with the mode it runs under.
    ctx.install("pre", `install -D -m 0755 "$here/usr/local/lib/systemd-migration/stackctl" '${CONTROLLER}'`);
    ctx.install("pre", `install -d -m 0755 '${STATE_DIR}'`);
    if (ctx.files.has("secrets/import-credentials.sh")) {
      ctx.install("pre", `install -D -m 0700 "$here/secrets/import-credentials.sh" '${CREDENTIAL_SCRIPT}'`);
    }
    ctx.note(`${ctx.host}: ${CONTROLLER} drives deploy, rollback, drain, activate, scale, rotate, and status from ${SPEC_DIR}/<stack>.conf; every verb takes --dry-run and prints the systemctl commands it would run`);
  },
};

/** The sockets a drain closes before the service's instances stop: its own, and the proxies that front it. */
function socketsOf(ctx: RenderContext, service: string, instances: Instance[], proxies: Proxy[] | undefined): string[] {
  const out = new Set(ctx.expected.sockets.filter((s) => instances.some((i) => s.startsWith(`${i.base}-`))));
  for (const p of proxies ?? []) if (p.service === service) out.add(p.socket);
  return [...out].sort();
}

/** The credentials a service's units load on this host, in the names the creds component gave them. */
function credentialsOf(ctx: RenderContext, svc: Service): string[] {
  const wanted = new Set<string>([...svc.secrets.map((s) => s.name), ...svc.redacted_env.map((k) => credentialNameFor(svc.name, k))]);
  return ctx.expected.credentials.filter((c) => wanted.has(c)).sort();
}

function specFile(ctx: RenderContext, stack: string, estateMonitor: string, services: SpecService[]): string {
  const lines: string[] = [
    `# Rendered by ${ctx.rendererName}: rollout specification of stack ${stack} on ${ctx.host}.`,
    `# Read by ${CONTROLLER}; see the systemd-rollout skill's references/rollout-spec.md.`,
    "# The sections are in rollout order: deploy and activate walk them from the",
    "# top, drain walks them from the bottom. Reordering the sections reorders the",
    "# walk; nothing else in the file depends on their order.",
    "",
    "[Rollout]",
    `Stack=${stack}`,
    `Host=${ctx.host}`,
    `Monitor=${estateMonitor}`,
    `StateDirectory=${STATE_DIR}`,
    `CredentialScript=${CREDENTIAL_SCRIPT}`,
    `ConfigForm=${ctx.valueOr(configsId(stack), "files")}`,
  ];
  for (const s of services) {
    lines.push("", `[Service ${s.name}]`);
    lines.push(`Units=${s.units.join(" ")}`);
    lines.push(`Health=${s.health.join(" ")}`);
    lines.push(`Sockets=${s.sockets.join(" ")}`);
    lines.push(`Credentials=${s.credentials.join(" ")}`);
    lines.push(`Configs=${s.configs.join(" ")}`);
    lines.push(`Parallelism=${s.parallelism}`);
    lines.push(`Delay=${s.delay}`);
    lines.push(`Order=${s.order}`);
    lines.push(`FailureAction=${s.failureAction}`);
    lines.push(`Monitor=${s.monitor}`);
    lines.push(`MaxFailureRatio=${s.maxFailureRatio}`);
    lines.push(`Image=${s.image}`);
    lines.push(`Form=${s.form}`);
  }
  return lines.join("\n") + "\n";
}

let controllerCache: string | null = null;

/** The controller's text, read from scripts/stackctl next to this module. */
export function controllerText(): string {
  if (controllerCache === null) controllerCache = readFileSync(new URL("./stackctl", import.meta.url), "utf8");
  return controllerCache;
}
