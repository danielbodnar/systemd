// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The service component: a container becomes a .service unit whose root is
// the image. This module renders the unit's skeleton (identity, ordering,
// exec line, environment, lifecycle, sandboxing, capabilities, ulimits,
// healthcheck timer), the stack targets, and the config files; the other
// components add their own directives to the same unit through the render
// context: creds (credentials), resource-control (slice and limits), storage
// (mounts), networkd (port policy), journald (log fields), machined (the
// root image and its form).

import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import { durationToSeconds, type ImageConfig, type Service } from "../../../contract/types.ts";
import { fileOwnership, healthCommand, quote } from "../../../contract/unit.ts";
import { materializedByGenerator } from "../../systemd-generator/scripts/component.ts";

/** Docker's default capability set, for services that neither add nor drop anything. */
export const DOCKER_DEFAULT_CAPS = [
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

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function cap(name: string): string {
  const n = name.toUpperCase();
  return n.startsWith("CAP_") ? n : `CAP_${n}`;
}

/** The bounding and ambient sets a service gets: Docker's defaults plus cap_add minus cap_drop. */
export function capabilitySet(svc: Service): { bounding: string[]; ambient: string[] } {
  const dropAll = svc.cap_drop.some((c) => c.toUpperCase() === "ALL");
  const base = dropAll ? [] : DOCKER_DEFAULT_CAPS;
  const added = svc.cap_add.map(cap);
  const dropped = new Set(svc.cap_drop.filter((c) => c.toUpperCase() !== "ALL").map(cap));
  const bounding = [...new Set([...base, ...added])].filter((c) => !dropped.has(c)).sort();
  const ambient = added.filter((c) => !dropped.has(c)).sort();
  return { bounding, ambient };
}

/** The argv a service runs: Swarm's command overrides the entrypoint, otherwise entrypoint plus args or the image's cmd. */
export function commandLine(svc: Service, image: ImageConfig | undefined, notes: string[]): string[] {
  if (svc.command.length) return [...svc.command, ...svc.args];
  const entry = image?.entrypoint ?? [];
  const cmd = svc.args.length ? svc.args : (image?.cmd ?? []);
  const argv = [...entry, ...cmd];
  if (argv.length === 0) {
    notes.push(`${svc.name}: neither the service nor the inventoried image says what to run; ExecStart= is a placeholder (/bin/false), set it by hand`);
    return ["/bin/false"];
  }
  return argv;
}

function execLine(argv: string[], image: ImageConfig | undefined): { exec: string; searchPath: string | null } {
  const first = argv[0]!;
  const searchPath = first.startsWith("/") ? null : (image?.env?.PATH ?? DEFAULT_PATH);
  return { exec: argv.map(quote).join(" "), searchPath };
}

function userGroup(user: string | null): { user: string | null; group: string | null; dynamic: boolean } {
  if (!user || user === "root" || user === "0" || user === "0:0") return { user: null, group: null, dynamic: true };
  const [u, g] = user.split(":");
  return { user: u ?? null, group: g ?? u ?? null, dynamic: false };
}

function restartFor(svc: Service): string {
  switch (svc.restart_policy.condition) {
    case "any":
      return "always";
    case "none":
      return "no";
    default:
      return "on-failure";
  }
}

/** An inventory duration as a systemd.time(7) value, keeping sub-second precision a rounded second would lose. */
export function timeValue(d: string | null | undefined): string | null {
  const seconds = durationToSeconds(d);
  if (seconds === null) return null;
  if (Number.isInteger(seconds)) return String(seconds);
  return `${Math.round(seconds * 1000)}ms`;
}

/**
 * The [Unit] start rate limit a restart policy needs.
 *
 * Swarm counts restart attempts: `max_attempts` within `window`, where 0 or
 * absent attempts mean it never gives up and an absent window means the
 * count runs for the life of the service. systemd counts starts and rate
 * limits every unit by default (`DefaultStartLimitBurst=` within
 * `DefaultStartLimitIntervalSec=`), so a source that never gives up has to
 * say so: `StartLimitIntervalSec=0` disables the limit, and an unbounded
 * window becomes `infinity`, which systemd.unit(5) documents as the total
 * count over any interval. Jobs and `condition: none` are never restarted,
 * so neither gets a limit.
 */
export function startLimit(svc: Service): { burst: string | null; interval: string | null } {
  if (svc.mode.endsWith("job") || svc.restart_policy.condition === "none") return { burst: null, interval: null };
  const attempts = svc.restart_policy.max_attempts;
  if (attempts === null || attempts <= 0) return { burst: null, interval: "0" };
  const window = timeValue(svc.restart_policy.window);
  return { burst: String(attempts), interval: window && window !== "0" ? window : "infinity" };
}

/** The resource limits systemd.exec(5) documents, by the name a ulimit carries without its RLIMIT_ prefix. */
export const RLIMIT_NAMES = ["AS", "CORE", "CPU", "DATA", "FSIZE", "LOCKS", "MEMLOCK", "MSGQUEUE", "NICE", "NOFILE", "NPROC", "RSS", "RTPRIO", "RTTIME", "SIGPENDING", "STACK"];

/** The `Limit*=` directive for a ulimit name, or null when systemd.exec(5) documents none. */
export function limitDirective(name: string): string | null {
  const n = name.toUpperCase().replace(/^RLIMIT_/, "");
  return RLIMIT_NAMES.includes(n) ? `Limit${n}` : null;
}

/** A ulimit value as systemd writes it; Docker's -1 is unlimited, which systemd spells `infinity`. */
export function limitValue(soft: number, hard: number): string {
  const one = (v: number) => (v < 0 ? "infinity" : String(Math.trunc(v)));
  return soft === hard ? one(hard) : `${one(soft)}:${one(hard)}`;
}

/** The stop signal as KillSignal= accepts it, or null with a note when the capture holds something else. */
export function killSignal(svc: Service, notes: string[]): string | null {
  if (!svc.stop_signal) return null;
  const raw = svc.stop_signal.trim().toUpperCase();
  const name = raw.startsWith("SIG") ? raw : `SIG${raw}`;
  if (!/^SIG(RTMIN(\+\d{1,2})?|RTMAX(-\d{1,2})?|[A-Z]{2,8}|\d{1,2})$/.test(name)) {
    notes.push(`${svc.name}: stop_signal ${JSON.stringify(svc.stop_signal)} is not a signal KillSignal= accepts; the unit keeps systemd's default SIGTERM`);
    return null;
  }
  return name;
}

/** Init processes an image can already carry as PID 1; Docker's `init` injects one from outside the image instead. */
export const DOCUMENTED_INITS = ["catatonit", "docker-init", "dumb-init", "runit", "s6-svscan", "supervisord", "tini"];

/** The init the argv already runs through, or null when it starts the workload directly. */
export function initBinary(argv: string[]): string | null {
  const first = argv[0];
  if (!first) return null;
  const base = first.slice(first.lastIndexOf("/") + 1);
  return DOCUMENTED_INITS.includes(base) ? first : null;
}

/** A host name that can be written into ProtectHostname=private: without carrying anything else into the unit. */
export function isHostnameValue(value: string): boolean {
  return value.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value);
}

/** Shell syntax beyond a pipeline or a list: substitutions, redirections, background jobs, subshells, variables. */
export function healthcheckNeedsApproval(command: string): boolean {
  return /[`$<>();{}]|\\|&(?!&)/.test(command);
}

export function healthDecisionId(service: string): string {
  return `service.healthcheck.${service}`;
}

export function scheduleId(service: string): string {
  return `service.schedule.${service}`;
}

/**
 * Whether a value may be written into `OnCalendar=`. The expression reaches a
 * unit file from a plan a person edits, so only the characters
 * systemd.time(7) uses in a calendar event get through; everything else is
 * refused rather than interpolated.
 */
export function isCalendarExpression(value: string): boolean {
  return value.length > 0 && value.length <= 120 && /^[A-Za-z0-9 ,:*/.+-]+$/.test(value);
}

const CRON_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cronField(field: string, day: boolean, pad = false): string | null {
  const out: string[] = [];
  for (const part of field.split(",")) {
    const m = /^(\*|\d{1,4}|\d{1,4}-\d{1,4})(?:\/(\d{1,4}))?$/.exec(part.trim());
    if (!m) return null;
    const base = m[1]!;
    const step = m[2];
    const name = (n: string) => (day ? (CRON_DAYS[Number(n) % 7] ?? null) : pad ? n.padStart(2, "0") : n);
    if (base === "*") out.push(step ? `${pad ? "00" : "0"}/${step}` : "*");
    else if (base.includes("-")) {
      const [from, to] = base.split("-") as [string, string];
      const a = name(from);
      const b = name(to);
      if (a === null || b === null) return null;
      out.push(`${a}..${b}${step ? `/${step}` : ""}`);
    } else {
      const a = name(base);
      if (a === null) return null;
      out.push(`${a}${step ? `/${step}` : ""}`);
    }
  }
  return out.join(",");
}

/**
 * A five-field crontab expression as an `OnCalendar=` event, or null when it
 * is not one. The Swarm cron sidecars carry crontab syntax in a service
 * label; systemd.time(7) calendar events are a different grammar, so the
 * common shapes (`*`, a number, a list, a range, and a step on any of them)
 * are translated and anything else is left for the operator.
 */
export function cronToCalendar(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = cronField(fields[0]!, false, true);
  const hour = cronField(fields[1]!, false, true);
  const dom = cronField(fields[2]!, false);
  const month = cronField(fields[3]!, false);
  const dow = cronField(fields[4]!, true);
  if (minute === null || hour === null || dom === null || month === null || dow === null) return null;
  const days = dow === "*" ? "" : `${dow} `;
  const event = `${days}*-${month}-${dom} ${hour}:${minute}:00`;
  return isCalendarExpression(event) ? event : null;
}

/**
 * The schedule the capture recorded for a job. Swarm has no schedule of its
 * own, so the convention its cron sidecars use is a service label whose last
 * segment is `schedule` or `cron`; a crontab expression there is translated,
 * a calendar event is taken as it stands.
 */
export function capturedSchedule(svc: Service): { label: string; raw: string; calendar: string } | null {
  for (const [label, raw] of Object.entries({ ...svc.container_labels, ...svc.labels }).sort()) {
    if (!/(^|[._-])(schedule|cron)$/i.test(label) || typeof raw !== "string") continue;
    const calendar = cronToCalendar(raw) ?? (isCalendarExpression(raw) ? raw.trim() : null);
    if (calendar) return { label, raw, calendar };
  }
  return null;
}

export const serviceComponent: Component = {
  id: "service",
  title: "Services (systemd.service, systemd.exec, systemd.unit, systemd.target, systemd.timer)",
  covers: ["systemd.service", "systemd.exec", "systemd.unit", "systemd.target", "systemd.timer", "systemd.path", "systemd.kill", "systemd.special", "systemd.syntax", "systemd.time", "systemd.rr", "sysctl.d", "systemd-sysctl.service", "systemd-notify", "systemd-escape", "machine-info"],
  after: ["machined"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    for (const svc of ctx.inventory.services) {
      if (!svc.mode.endsWith("job")) continue;
      const captured = capturedSchedule(svc);
      out.push({
        id: scheduleId(svc.name),
        kind: "value",
        format: "text",
        subject: { kind: "service", name: svc.name },
        question: `${svc.name} ran as a ${svc.mode}, which Swarm starts on demand. On what schedule should it run? An OnCalendar expression (systemd.time(7)) renders a timer; leave it empty to run the job once when its stack target starts.`,
        default: captured?.calendar ?? "",
        evidence: [
          `services[${svc.name}].mode=${svc.mode}`,
          ...(captured ? [`services[${svc.name}].labels[${captured.label}]=${captured.raw}`] : [`services[${svc.name}].labels carry no schedule; Swarm records none of its own`]),
        ],
      });
    }
    for (const svc of ctx.inventory.services) {
      const test = svc.healthcheck?.test ?? [];
      if (test[0] !== "CMD-SHELL" || svc.mode.endsWith("job")) continue;
      const command = test.slice(1).join(" ");
      const risky = healthcheckNeedsApproval(command);
      out.push({
        id: healthDecisionId(svc.name),
        kind: "choice",
        subject: { kind: "service", name: svc.name },
        question: `The healthcheck of ${svc.name} is a shell command (${JSON.stringify(command)}); it will run through /bin/sh -c inside the image's root with the service's privileges. Keep it?`,
        options: [
          { value: "shell", label: "keep the shell healthcheck", consequence: "rendered verbatim into the health service's ExecStart=/bin/sh -c" },
          { value: "drop", label: "no healthcheck", consequence: "no health timer; systemd restarts the service only when its main process exits" },
        ],
        default: risky ? null : "shell",
        evidence: [`services[${svc.name}].healthcheck.test`, ...(risky ? ["the command contains shell control syntax (substitution, redirection, subshell, or variable)"] : [])],
      });
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const inv = ctx.inventory;
    const imageByRef = new Map((inv.images ?? []).map((i) => [i.ref, i]));
    const cfgByName = new Map(inv.configs.map((c) => [c.name, c]));
    const configFiles = new Map<string, { data: string | null; uid: string; gid: string; mode: number; stack: string }>();
    const sysctls = new Map<string, string[]>();
    const noteList: string[] = [];

    for (const inst of ctx.instances) {
      if (inst.form !== "service") continue;
      const svc = inst.service;
      const image = imageByRef.get(svc.image);
      const rootInfo = ctx.get<{ root: string; kind: "RootMStack" | "RootImage" }>(`machined:root:${svc.image}`);
      if (!rootInfo) throw new Error(`${svc.name}: the machined component did not record a root for ${svc.image}; is it registered before service?`);
      const { base, unit: unitName, stack } = inst;
      const u = ctx.unit(unitName, [
        `Rendered by ${ctx.rendererName} from ${inv.cluster ? "swarm" : "container"} service ${svc.name} (stack ${svc.stack ?? "none"}, mode ${svc.mode})`,
        `The image is the service's root; see the [X-Migration] section for its origin.`,
      ]);
      u.add("Unit", "Description", `${svc.name} (migrated from Docker Swarm stack ${stack})`);
      u.add("Unit", "PartOf", `${stack}.target`);
      u.add("Unit", "After", "network-online.target");
      u.add("Unit", "Wants", "network-online.target");
      u.add("Unit", "ConditionHost", ctx.host);
      const limit = startLimit(svc);
      u.add("Unit", "StartLimitBurst", limit.burst);
      u.add("Unit", "StartLimitIntervalSec", limit.interval);
      if (rootInfo.kind === "RootImage") u.add("Unit", "RequiresMountsFor", rootInfo.root.slice(0, rootInfo.root.lastIndexOf("/")));

      const isJob = svc.mode.endsWith("job");
      u.add("Service", "Type", isJob ? "oneshot" : "exec");
      // A Swarm job's task is done when its process exits; nothing about the
      // service stays active afterwards, so the unit does not linger either.
      if (isJob) u.add("Service", "RemainAfterExit", "no");
      u.add("Service", rootInfo.kind, rootInfo.root);
      u.add("Service", "MountAPIVFS", "yes");
      u.add("Service", "PrivateTmp", svc.mounts.some((m) => m.type === "tmpfs" && m.target === "/tmp") ? null : "yes");
      const devices = svc.mounts.some((m) => m.type === "bind" && (m.source ?? "").startsWith("/dev/"));
      u.add("Service", "PrivateDevices", devices ? null : "yes");
      u.add("Service", "ProtectSystem", svc.read_only ? "strict" : null);
      u.add("Service", "ProtectProc", "invisible");
      u.add("Service", "ProtectKernelTunables", Object.keys(svc.sysctls).length ? null : "yes");
      u.add("Service", "PrivateUsers", "self");

      const argv = commandLine(svc, image, noteList);
      const { exec, searchPath } = execLine(argv, image);
      if (svc.init) {
        const init = initBinary(argv);
        if (init) ctx.note(`${svc.name}: init was set and the image already runs through ${init}, so ExecStart= keeps it as the service's first process`);
        else ctx.note(`${svc.name}: init was set, which made Docker run its own init as PID 1 from outside the image; the image records none of the init processes this renderer documents (${DOCUMENTED_INITS.join(", ")}), so ExecStart= runs the workload directly and the service manager reaps the orphans the init would have reaped`);
      }
      u.add("Service", "ExecSearchPath", searchPath);
      u.add("Service", "ExecStart", exec);
      u.add("Service", "WorkingDirectory", svc.workdir ?? image?.workdir ?? null);
      const ug = userGroup(svc.user ?? image?.user ?? null);
      if (ug.dynamic) {
        u.add("Service", "DynamicUser", "yes");
        ctx.note(`${svc.name}: ran as root inside the container (no user set); DynamicUser=yes is rendered instead, set User= and Group= if the workload needs a fixed identity or must own its volumes`);
      } else {
        u.add("Service", "User", ug.user);
        u.add("Service", "Group", ug.group);
      }
      const shape: ServiceShape = { base, unit: unitName, root: rootInfo.root, rootKind: rootInfo.kind, user: ug.user, group: ug.group, dynamic: ug.dynamic, searchPath, isJob, stack };
      ctx.set(instanceKey(base), shape);

      // Environment: the image's variables first (PATH is handled by ExecSearchPath=), then the service's plain ones; creds renders the redacted ones.
      const envLines: string[] = [];
      const redactedImage = image?.redacted_env ?? [];
      for (const [k, v] of Object.entries(image?.env ?? {}).sort()) {
        if (k === "PATH" || k in svc.env) continue;
        if (redactedImage.includes(k)) {
          ctx.note(`${svc.name}: image environment ${k} was redacted at capture; it is not rendered`);
          continue;
        }
        envLines.push(`${k}=${v}`);
      }
      for (const [k, v] of Object.entries(svc.env).sort()) {
        if (svc.redacted_env.includes(k)) continue;
        envLines.push(`${k}=${v}`);
      }
      if (envLines.length > 6) {
        ctx.file(`etc/${stack}/${base}.env`, envLines.join("\n") + "\n");
        u.add("Service", "EnvironmentFile", `/etc/${stack}/${base}.env`);
        ctx.note(`${svc.name}: environment written to /etc/${stack}/${base}.env; install.sh sets mode 0600`);
      } else {
        for (const line of envLines) u.add("Service", "Environment", quote(line));
      }

      // Configs are files under /etc/<stack>/configs/ unless the sysext component turned them into a confext.
      if (ctx.valueOr(`sysext.configs.${stack}`, "files") === "files") {
        for (const c of svc.configs) {
          const def = cfgByName.get(c.name);
          const target = c.target.startsWith("/") ? c.target : `/${c.target}`;
          u.add("Service", "BindReadOnlyPaths", `/etc/${stack}/configs/${c.name}:${target}`);
          configFiles.set(c.name, { data: def?.data_base64 ?? null, uid: c.uid, gid: c.gid, mode: c.mode, stack });
          if (!def?.data_base64) ctx.note(`${svc.name}: config ${c.name} has no payload in the inventory; place it at /etc/${stack}/configs/${c.name} by hand`, "decision");
        }
      }

      if (devices) u.add("Service", "DevicePolicy", "closed");

      // Security.
      const caps = capabilitySet(svc);
      if (caps.bounding.length) u.add("Service", "CapabilityBoundingSet", caps.bounding.join(" "));
      else u.addEmpty("Service", "CapabilityBoundingSet");
      if (caps.ambient.length) u.add("Service", "AmbientCapabilities", caps.ambient.join(" "));
      // Ambient capabilities are raised before exec and coexist with NoNewPrivileges=, so it is always set.
      u.add("Service", "NoNewPrivileges", "yes");
      u.add("Service", "RestrictSUIDSGID", "yes");
      u.add("Service", "LockPersonality", "yes");
      if (svc.privileged) ctx.note(`${svc.name}: privileged is not rendered; the unit has Docker's default capability set, add what the workload needs to CapabilityBoundingSet= and AmbientCapabilities=`, "decision");
      for (const ul of svc.ulimits) {
        const key = limitDirective(ul.name);
        if (!key) {
          ctx.note(`${svc.name}: ulimit ${ul.name} (${ul.soft}:${ul.hard}) has no Limit*= directive in systemd.exec(5); it is not rendered`);
          continue;
        }
        u.add("Service", key, limitValue(ul.soft, ul.hard));
      }
      if (Object.keys(svc.sysctls).length) {
        const lines = sysctls.get(stack) ?? [];
        sysctls.set(stack, lines);
        for (const [k, v] of Object.entries(svc.sysctls).sort()) {
          const line = `${k} = ${v}`;
          if (!lines.includes(line)) lines.push(line);
        }
        ctx.note(`${svc.name}: sysctls ${Object.keys(svc.sysctls).join(", ")} apply to the whole host from /etc/sysctl.d/90-${stack}.conf, not to the service alone`);
      }

      // Lifecycle.
      u.add("Service", "Restart", isJob ? null : restartFor(svc));
      u.add("Service", "RestartSec", isJob ? null : timeValue(svc.restart_policy.delay));
      const grace = timeValue(svc.stop_grace_period);
      u.add("Service", "TimeoutStopSec", grace);
      if (grace === "0") ctx.note(`${svc.name}: stop_grace_period was 0, so TimeoutStopSec=0 lets the manager reach SIGKILL at once, as the source did; raise it if the workload needs time to shut down`);
      u.add("Service", "KillSignal", killSignal(svc, noteList));
      u.add("Service", "KillMode", "mixed");
      if (isJob && svc.restart_policy.condition !== "none") {
        ctx.note(`${svc.name}: restart_policy ${svc.restart_policy.condition} is not rendered for a ${svc.mode}; a oneshot unit that fails stays failed and is run again by its timer or by hand, as a Swarm job's task is`);
      }
      if (limit.burst && svc.healthcheck) {
        ctx.note(`${svc.name}: StartLimitBurst=${limit.burst} counts every start within StartLimitIntervalSec=${limit.interval}, including the restarts ${base}-restart.service performs after a failed healthcheck, which is how Swarm counted an unhealthy task against max_attempts; systemctl reset-failed clears the counter`);
      }

      if (svc.update_config) ctx.note(`${svc.name}: update_config (${svc.update_config.order}, parallelism ${svc.update_config.parallelism}, on failure ${svc.update_config.failure_action}) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback`);
      if (svc.rollback_config) ctx.note(`${svc.name}: rollback_config is a runbook step; the previous image version stays pullable under its own name`);
      const droppedLabels = Object.keys(svc.labels).filter((k) => !k.startsWith("com.docker."));
      if (droppedLabels.length) ctx.note(`${svc.name}: service labels not rendered: ${droppedLabels.join(", ")}`);
      if (svc.hostname) {
        if (isHostnameValue(svc.hostname)) {
          u.add("Service", "ProtectHostname", `private:${svc.hostname}`);
          ctx.note(`${svc.name}: hostname ${svc.hostname} is set inside the service's own UTS namespace by ProtectHostname=private:; the host keeps its name and nothing outside the service resolves the new one`);
        } else {
          ctx.note(`${svc.name}: hostname ${JSON.stringify(svc.hostname)} is not a host name ProtectHostname= accepts; it is not rendered`);
        }
      }
      if (svc.tty) {
        ctx.note(`${svc.name}: tty gave the container a pseudo-terminal; a service has no terminal of its own, so nothing is rendered. Add StandardInput=tty with TTYPath= naming a device on the host when the workload needs one`);
      }
      if (svc.dns.nameservers.length || svc.dns.search.length || svc.dns.options.length) {
        ctx.note(`${svc.name}: the per-service DNS configuration (nameservers ${svc.dns.nameservers.join(", ") || "none"}, search ${svc.dns.search.join(", ") || "none"}, options ${svc.dns.options.join(", ") || "none"}) is not a service directive; the resolved component owns the resolver on each host and a private resolver needs a machine form`);
      }
      if (svc.extra_hosts.length) {
        ctx.note(`${svc.name}: extra_hosts ${svc.extra_hosts.join(", ")} are not rendered as service directives; add each to the host's /etc/hosts or give the resolved component a record for the name`);
      }

      // Healthcheck: a timer runs the command in the same root; failure restarts the service.
      renderHealthcheck(ctx, inst, shape, svc);
      const timerUnit = isJob ? renderJobTimer(ctx, inst, svc) : null;

      u.add("X-Migration", "Source", "docker-swarm");
      u.add("X-Migration", "Stack", svc.stack ?? "");
      u.add("X-Migration", "Service", svc.name);
      u.add("X-Migration", "Image", svc.image);
      u.add("X-Migration", "ImageDigest", svc.image_digest ?? "");
      u.add("X-Migration", "ImageName", rootInfo.root.slice(rootInfo.root.lastIndexOf("/") + 1).replace(/\.(mstack|raw)$/, ""));
      u.add("X-Migration", "Renderer", ctx.rendererName);
      u.add("X-Migration", "Form", inst.form);

      ctx.expect("units", unitName);
      // A scheduled job is started by its timer, so the stack target pulls in
      // the timer; an unscheduled job runs once when the target starts.
      ctx.wantedByStack(stack, timerUnit ?? unitName);
    }
    for (const n of noteList) ctx.note(n, /placeholder/.test(n) ? "decision" : "review");

    for (const [stack, lines] of [...sysctls].sort()) {
      ctx.file(`etc/sysctl.d/90-${stack}.conf`, [`# Rendered by ${ctx.rendererName}: sysctls the services of stack ${stack} set; they apply to the whole host`, ...lines].join("\n") + "\n");
      ctx.install("pre", "sysctl --system >/dev/null || true");
    }
    const manifest: string[] = [];
    for (const [name, c] of [...configFiles].sort()) {
      if (c.data !== null) ctx.file(`etc/${c.stack}/configs/${name}`, Buffer.from(c.data, "base64").toString("utf8"));
      const own = fileOwnership(c, `config ${name}`);
      manifest.push(`${c.stack}/configs/${name} ${own.uid} ${own.gid} ${own.mode}`);
    }
    if (manifest.length) {
      ctx.install("pre", ["while read -r path uid gid mode; do", '    chown "$uid:$gid" "/etc/$path"', '    chmod "$mode" "/etc/$path"', "done <<'MANIFEST'", ...manifest, "MANIFEST"].join("\n"));
    }
    for (const stack of new Set(ctx.instances.map((i) => i.stack))) {
      if ([...ctx.files.keys()].some((f) => f.startsWith(`etc/${stack}/`) && f.endsWith(".env"))) ctx.install("pre", `find '/etc/${stack}' -maxdepth 1 -name '*.env' -exec chmod 0600 {} + 2>/dev/null || true`);
    }
  },

  finish(ctx: RenderContext): void {
    // Stack targets group every unit the components registered for the stack
    // on this host; when the generator materializes them, it reads the same
    // list from the stack description the generator component writes.
    if (materializedByGenerator(ctx)) return;
    for (const [stack, units] of ctx.stacks()) {
      const t = ctx.unit(`${stack}.target`, [`Rendered by ${ctx.rendererName}: groups the units of stack ${stack} on ${ctx.host}`]);
      t.add("Unit", "Description", `stack ${stack}`);
      t.addAll("Unit", "Wants", units);
      t.add("Install", "WantedBy", "multi-user.target");
      ctx.expect("targets", `${stack}.target`);
    }
  },
};

/**
 * A job's schedule. Swarm starts a job when it is created or forced, so the
 * default is a run when the stack target starts and the unit needs no timer.
 * When the schedule decision carries a calendar event, the job gets a timer
 * and the stack target wants the timer rather than the service. Returns the
 * timer unit name when one was rendered.
 */
function renderJobTimer(ctx: RenderContext, inst: { base: string; unit: string; stack: string }, svc: Service): string | null {
  const schedule = ctx.valueOr(scheduleId(svc.name), "").trim();
  if (!schedule) {
    ctx.note(`${svc.name}: the ${svc.mode} runs once when ${inst.stack}.target starts; set ${scheduleId(svc.name)} to an OnCalendar expression to run it on a schedule instead`);
    return null;
  }
  if (!isCalendarExpression(schedule)) throw new Error(`${scheduleId(svc.name)}: ${JSON.stringify(schedule)} is not a calendar expression`);
  const name = `${inst.base}.timer`;
  const t = ctx.unit(name, [`Rendered by ${ctx.rendererName}: schedule of ${svc.mode} ${svc.name}, which Swarm ran on demand`]);
  t.add("Unit", "Description", `schedule for ${inst.base}`);
  t.add("Unit", "PartOf", `${inst.stack}.target`);
  t.add("Timer", "OnCalendar", schedule);
  t.add("Timer", "Persistent", "yes");
  t.add("Timer", "AccuracySec", "1s");
  t.add("Timer", "Unit", inst.unit);
  ctx.expect("timers", name);
  ctx.note(`${svc.name}: the job runs on ${schedule} from ${name}; Persistent=yes runs a schedule the host missed once it is up again`);
  return name;
}

function renderHealthcheck(ctx: RenderContext, inst: { base: string; unit: string; stack: string }, shape: ServiceShape, svc: Service): void {
  if (!svc.healthcheck) return;
  if (shape.isJob) {
    ctx.note(`${svc.name}: the healthcheck is not rendered for a ${svc.mode}; a oneshot unit's result is its exit status, which the journal and systemctl report, and there is nothing to restart between runs`);
    return;
  }
  const test = svc.healthcheck.test;
  if (test.length === 0 || test[0] === "NONE") return;
  const { base, unit: unitName, stack } = inst;
  const retries = svc.healthcheck.retries ?? 3;
  const timeout = Math.round(durationToSeconds(svc.healthcheck.timeout) ?? 30);
  let exec: string;
  if (test[0] === "CMD-SHELL") {
    if (ctx.value(healthDecisionId(svc.name)) === "drop") {
      ctx.note(`${svc.name}: the shell healthcheck was dropped by decision; no health timer is rendered`, "decision");
      return;
    }
    const command = healthCommand(test)!;
    exec = `/bin/sh -c ${quote(`for i in $(seq ${retries}); do if ( ${command} ); then exit 0; fi; sleep 1; done; exit 1`)}`;
  } else {
    // CMD (argv) checks run without a shell; the retry loop is the timer's job: OnFailure= counts failures through the restart unit.
    const argv = test[0] === "CMD" ? test.slice(1) : test;
    if (argv.length === 0) return;
    exec = argv.map(quote).join(" ");
  }
  const u = ctx.unit(unitName);
  const hs = ctx.unit(`${base}-health.service`, [`Rendered by ${ctx.rendererName}: healthcheck of service ${svc.name}, run by ${base}-health.timer`]);
  hs.add("Unit", "Description", `healthcheck for ${base}`);
  hs.add("Unit", "After", unitName);
  hs.add("Unit", "BindsTo", unitName);
  hs.add("Unit", "OnFailure", `${base}-restart.service`);
  hs.add("Service", "Type", "oneshot");
  hs.add("Service", "Slice", `stack-${stack}.slice`);
  hs.add("Service", shape.rootKind, shape.root);
  hs.add("Service", "MountAPIVFS", "yes");
  hs.add("Service", "PrivateUsers", "self");
  // The check runs with the service's identity and none of its capabilities:
  // a probe of a port or a file needs neither root nor the bounding set.
  if (shape.dynamic) hs.add("Service", "DynamicUser", "yes");
  else {
    hs.add("Service", "User", shape.user);
    hs.add("Service", "Group", shape.group);
  }
  hs.addEmpty("Service", "CapabilityBoundingSet");
  hs.add("Service", "NoNewPrivileges", "yes");
  hs.add("Service", "RestrictSUIDSGID", "yes");
  hs.add("Service", "LockPersonality", "yes");
  hs.add("Service", "ProtectProc", "invisible");
  hs.add("Service", "ExecSearchPath", shape.searchPath);
  hs.add("Service", "ExecStart", exec);
  hs.add("Service", "TimeoutStartSec", (timeout + 1) * retries);
  hs.add("Service", "SyslogIdentifier", `${base}-health`);
  const ht = ctx.unit(`${base}-health.timer`, [`Rendered by ${ctx.rendererName}: healthcheck schedule of service ${svc.name}`]);
  ht.add("Unit", "Description", `healthcheck timer for ${base}`);
  ht.add("Unit", "PartOf", unitName);
  ht.add("Unit", "After", unitName);
  const start = Math.round(durationToSeconds(svc.healthcheck.start_period) ?? 0);
  const interval = Math.round(durationToSeconds(svc.healthcheck.interval) ?? 30);
  ht.add("Timer", "OnActiveSec", Math.max(start, 1));
  ht.add("Timer", "OnUnitActiveSec", interval);
  ht.add("Timer", "Unit", `${base}-health.service`);
  ht.add("Timer", "AccuracySec", "1s");
  const hr = ctx.unit(`${base}-restart.service`, [`Rendered by ${ctx.rendererName}: restarts service ${svc.name} after ${retries} failed healthchecks`]);
  hr.add("Unit", "Description", `restart ${base} after a failed healthcheck`);
  hr.add("Service", "Type", "oneshot");
  hr.add("Service", "ExecStart", `systemctl restart ${unitName}`);
  u.add("Unit", "Wants", `${base}-health.timer`);
  ctx.expect("timers", `${base}-health.timer`);
  ctx.expect("units", `${base}-health.service`);
  ctx.expect("units", `${base}-restart.service`);
  ctx.note(`${svc.name}: the healthcheck runs from ${base}-health.timer every ${interval}s and restarts the service after ${retries} consecutive failures; the start period becomes the timer's first delay`);
}
