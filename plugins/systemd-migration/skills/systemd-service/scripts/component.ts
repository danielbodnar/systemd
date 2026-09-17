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
import { healthCommand, octal, quote } from "../../../contract/unit.ts";

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

/** Shell syntax beyond a pipeline or a list: substitutions, redirections, background jobs, subshells, variables. */
export function healthcheckNeedsApproval(command: string): boolean {
  return /[`$<>();{}]|\\|&(?!&)/.test(command);
}

export function healthDecisionId(service: string): string {
  return `service.healthcheck.${service}`;
}

export const serviceComponent: Component = {
  id: "service",
  title: "Services (systemd.service, systemd.exec, systemd.unit, systemd.target, systemd.timer)",
  covers: ["systemd.service", "systemd.exec", "systemd.unit", "systemd.target", "systemd.timer", "systemd.path", "systemd.kill", "systemd.special", "systemd.syntax", "systemd.time", "systemd.rr", "sysctl.d", "systemd-sysctl.service", "systemd-notify", "systemd-escape", "machine-info"],
  after: ["machined"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    for (const svc of ctx.inventory.services) {
      const test = svc.healthcheck?.test ?? [];
      if (test[0] !== "CMD-SHELL") continue;
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
      if (svc.restart_policy.max_attempts) u.add("Unit", "StartLimitBurst", svc.restart_policy.max_attempts);
      const window = durationToSeconds(svc.restart_policy.window);
      if (window) u.add("Unit", "StartLimitIntervalSec", Math.round(window));
      if (rootInfo.kind === "RootImage") u.add("Unit", "RequiresMountsFor", rootInfo.root.slice(0, rootInfo.root.lastIndexOf("/")));

      u.add("Service", "Type", inst.service.mode.endsWith("job") ? "oneshot" : "exec");
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
      const shape: ServiceShape = { base, unit: unitName, root: rootInfo.root, rootKind: rootInfo.kind, user: ug.user, group: ug.group, dynamic: ug.dynamic, searchPath, isJob: svc.mode.endsWith("job"), stack };
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
        const key = `Limit${ul.name.toUpperCase().replace(/^RLIMIT_/, "")}`;
        u.add("Service", key, ul.soft === ul.hard ? String(ul.hard) : `${ul.soft}:${ul.hard}`);
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
      u.add("Service", "Restart", shape.isJob ? null : restartFor(svc));
      const delay = durationToSeconds(svc.restart_policy.delay);
      if (delay) u.add("Service", "RestartSec", Math.round(delay));
      const grace = durationToSeconds(svc.stop_grace_period);
      if (grace) u.add("Service", "TimeoutStopSec", Math.round(grace));
      u.add("Service", "KillSignal", svc.stop_signal);
      u.add("Service", "KillMode", "mixed");

      if (svc.update_config) ctx.note(`${svc.name}: update_config (${svc.update_config.order}, parallelism ${svc.update_config.parallelism}, on failure ${svc.update_config.failure_action}) is a runbook step; restart hosts one at a time and keep the previous image version under a .v/ directory for rollback`);
      if (svc.rollback_config) ctx.note(`${svc.name}: rollback_config is a runbook step; the previous image version stays pullable under its own name`);
      const droppedLabels = Object.keys(svc.labels).filter((k) => !k.startsWith("com.docker."));
      if (droppedLabels.length) ctx.note(`${svc.name}: service labels not rendered: ${droppedLabels.join(", ")}`);
      if (svc.hostname) ctx.note(`${svc.name}: hostname ${svc.hostname} is not applied; a native service keeps the host's name (a machine can set it)`);
      if (svc.dns.nameservers.length || svc.dns.search.length) ctx.note(`${svc.name}: per-service DNS settings are not applied to a native service; the resolved component configures the host's resolver`);
      for (const eh of svc.extra_hosts) ctx.note(`${svc.name}: extra host "${eh}" must be added to the host's /etc/hosts or the resolver`);

      // Healthcheck: a timer runs the command in the same root; failure restarts the service.
      renderHealthcheck(ctx, inst, shape, svc);

      u.add("X-Migration", "Source", "docker-swarm");
      u.add("X-Migration", "Stack", svc.stack ?? "");
      u.add("X-Migration", "Service", svc.name);
      u.add("X-Migration", "Image", svc.image);
      u.add("X-Migration", "ImageDigest", svc.image_digest ?? "");
      u.add("X-Migration", "ImageName", rootInfo.root.slice(rootInfo.root.lastIndexOf("/") + 1).replace(/\.(mstack|raw)$/, ""));
      u.add("X-Migration", "Renderer", ctx.rendererName);
      u.add("X-Migration", "Form", inst.form);

      ctx.expect("units", unitName);
      ctx.wantedByStack(stack, unitName);
    }
    for (const n of noteList) ctx.note(n, /placeholder/.test(n) ? "decision" : "review");

    for (const [stack, lines] of [...sysctls].sort()) {
      ctx.file(`etc/sysctl.d/90-${stack}.conf`, [`# Rendered by ${ctx.rendererName}: sysctls the services of stack ${stack} set; they apply to the whole host`, ...lines].join("\n") + "\n");
      ctx.install("pre", "sysctl --system >/dev/null || true");
    }
    const manifest: string[] = [];
    for (const [name, c] of [...configFiles].sort()) {
      if (c.data !== null) ctx.file(`etc/${c.stack}/configs/${name}`, Buffer.from(c.data, "base64").toString("utf8"));
      manifest.push(`${c.stack}/configs/${name} ${c.uid} ${c.gid} ${octal(c.mode)}`);
    }
    if (manifest.length) {
      ctx.install("pre", ["while read -r path uid gid mode; do", '    chown "$uid:$gid" "/etc/$path"', '    chmod "$mode" "/etc/$path"', "done <<'MANIFEST'", ...manifest, "MANIFEST"].join("\n"));
    }
    for (const stack of new Set(ctx.instances.map((i) => i.stack))) {
      if ([...ctx.files.keys()].some((f) => f.startsWith(`etc/${stack}/`) && f.endsWith(".env"))) ctx.install("pre", `find '/etc/${stack}' -maxdepth 1 -name '*.env' -exec chmod 0600 {} + 2>/dev/null || true`);
    }
  },

  finish(ctx: RenderContext): void {
    // Stack targets group every unit the components registered for the stack on this host.
    for (const [stack, units] of ctx.stacks()) {
      const t = ctx.unit(`${stack}.target`, [`Rendered by ${ctx.rendererName}: groups the units of stack ${stack} on ${ctx.host}`]);
      t.add("Unit", "Description", `stack ${stack}`);
      t.addAll("Unit", "Wants", units);
      t.add("Install", "WantedBy", "multi-user.target");
      ctx.expect("targets", `${stack}.target`);
    }
  },
};

function renderHealthcheck(ctx: RenderContext, inst: { base: string; unit: string; stack: string }, shape: ServiceShape, svc: Service): void {
  if (!svc.healthcheck) return;
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
