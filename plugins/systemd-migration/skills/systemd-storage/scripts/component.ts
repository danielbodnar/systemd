// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The storage component: volumes become directories or mount units, bind
// mounts keep their source, tmpfs mounts become TemporaryFileSystem=, and
// the directories are created by tmpfiles.d with the service's owner.

import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import type { Volume } from "../../../contract/types.ts";
import { escapeUnitPath, octal } from "../../../contract/unit.ts";

export const STATE_DIR = "storage.state_dir.estate";
export function volumeMoveId(volume: string): string {
  return `storage.move.${volume}`;
}

function nfsWhat(v: Volume): { what: string; type: string; options: string } | null {
  const type = (v.options.type ?? "").toLowerCase();
  if (!["nfs", "nfs4", "cifs"].includes(type)) return null;
  const o = v.options.o ?? "";
  const addr = /(?:^|,)addr=([^,]+)/.exec(o)?.[1];
  const device = v.options.device ?? "";
  const what = type === "cifs" ? device : `${addr ?? ""}:${device.replace(/^:/, "")}`;
  const options = o
    .split(",")
    .filter((x) => x && !x.startsWith("addr="))
    .join(",");
  return { what, type, options };
}

export const storageComponent: Component = {
  id: "storage",
  title: "Storage (systemd.mount, tmpfiles.d, sysusers.d, repart.d)",
  covers: ["systemd.mount", "systemd.automount", "systemd.swap", "tmpfiles.d", "systemd-tmpfiles", "sysusers.d", "systemd-sysusers", "systemd-fstab-generator", "systemd-gpt-auto-generator", "systemd-mount", "systemd-loop@.service", "systemd-makefs@.service", "systemd-fsck@.service", "systemd-quotacheck@.service", "systemd-validatefs@.service", "systemd-storage-block@.service", "systemd-storage-fs@.service", "storagectl", "file-hierarchy"],
  after: ["service"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [
      {
        id: STATE_DIR,
        kind: "value",
        format: "path",
        subject: { kind: "estate", name: "estate" },
        question: "Where do local volumes live on the hosts? Each becomes <state_dir>/<stack>/<volume>.",
        default: "/var/lib",
      },
    ];
    for (const v of ctx.inventory.volumes) {
      if (nfsWhat(v)) continue;
      out.push({
        id: volumeMoveId(v.name),
        kind: "choice",
        subject: { kind: "volume", name: v.name },
        question: `How does the data of volume ${v.name} (used by ${v.used_by.join(", ") || "nothing"}) reach the new host?`,
        options: [
          { value: "rsync", label: "copy while stopped", consequence: "stop the service on the old host, rsync the volume, start on the new host; the runbook records the window" },
          { value: "snapshot", label: "storage snapshot", consequence: "a snapshot of the volume's file system is restored on the new host" },
          { value: "shared", label: "already shared", consequence: "both sides mount the same storage; only ownership needs checking" },
          { value: "empty", label: "start empty", consequence: "a cache or scratch volume; the directory is created empty" },
        ],
        default: null,
        evidence: [`volumes[${v.name}].driver=${v.driver}`, `volumes[${v.name}].mountpoint=${v.mountpoint ?? "unknown"}`],
      });
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const inv = ctx.inventory;
    const stateDir = ctx.value(STATE_DIR).replace(/\/+$/, "");
    const volByName = new Map(inv.volumes.map((v) => [v.name, v]));
    const tmpfiles = new Map<string, string[]>();
    for (const inst of ctx.instances) {
      if (inst.form !== "service") continue;
      const shape = ctx.get<ServiceShape>(instanceKey(inst.base));
      if (!shape) continue;
      const svc = inst.service;
      const stack = inst.stack;
      const u = ctx.unit(shape.unit);
      for (const m of svc.mounts) {
        if (m.type === "volume" && m.source) {
          const vol = volByName.get(m.source);
          const remote = vol ? nfsWhat(vol) : null;
          const where = `${stateDir}/${stack}/${m.source}`;
          if (remote) {
            const unit = `${escapeUnitPath(where)}.mount`;
            const mu = ctx.unit(unit, [`Rendered by ${ctx.rendererName} from volume ${m.source} (driver ${vol!.driver}, type ${remote.type})`]);
            mu.add("Unit", "Description", `${m.source} (volume, ${remote.type})`);
            mu.add("Unit", "After", "network-online.target");
            mu.add("Unit", "Wants", "network-online.target");
            mu.add("Mount", "What", remote.what);
            mu.add("Mount", "Where", where);
            mu.add("Mount", "Type", remote.type);
            mu.add("Mount", "Options", remote.options || null);
            mu.add("Install", "WantedBy", `${stack}.target`);
            ctx.expect("mounts", unit);
            ctx.wantedByStack(stack, unit);
            u.add("Unit", "RequiresMountsFor", where);
          } else {
            const owner = shape.dynamic ? "-" : (shape.user ?? "-");
            const group = shape.dynamic ? "-" : (shape.group ?? owner);
            const line = `d ${where} 0750 ${owner} ${group} -`;
            const lines = tmpfiles.get(stack) ?? [];
            tmpfiles.set(stack, lines);
            if (!lines.includes(line)) lines.push(line);
            if (shape.dynamic) ctx.note(`${svc.name}: volume ${m.source} at ${where} is created for a DynamicUser= service; StateDirectory= would be the native shape if the path can move under /var/lib/${inst.base}`);
            if (!vol) ctx.note(`${svc.name}: volume ${m.source} was not inventoried on the capturing node; ${where} is created empty, copy the data before cutover`, "decision");
            else {
              const move = ctx.valueOr(volumeMoveId(m.source), "");
              if (move) ctx.note(`${svc.name}: volume ${m.source} moves by "${move}" (decision ${volumeMoveId(m.source)}); the runbook step lands at ${where}`);
              else ctx.note(`${svc.name}: how the data of volume ${m.source} reaches ${where} is undecided (${volumeMoveId(m.source)})`, "decision");
            }
          }
          ctx.expect("volumes", where);
          u.add("Service", m.readonly ? "BindReadOnlyPaths" : "BindPaths", `${where}:${m.target}`);
        } else if (m.type === "bind" && m.source) {
          if (m.source.startsWith("/dev/")) {
            u.add("Service", "DeviceAllow", `${m.source} rw`);
            u.add("Service", "BindPaths", `${m.source}:${m.target}`);
          } else {
            u.add("Service", m.readonly ? "BindReadOnlyPaths" : "BindPaths", `${m.source}:${m.target}`);
            if (m.bind_propagation && m.bind_propagation !== "rprivate") ctx.note(`${svc.name}: bind propagation ${m.bind_propagation} on ${m.target} is not rendered`);
          }
        } else if (m.type === "tmpfs") {
          const tmpOpts: string[] = [];
          if (m.tmpfs_size_bytes) tmpOpts.push(`size=${m.tmpfs_size_bytes}`);
          if (m.tmpfs_mode) tmpOpts.push(`mode=${octal(m.tmpfs_mode)}`);
          u.add("Service", "TemporaryFileSystem", `${m.target}${tmpOpts.length ? ":" + tmpOpts.join(",") : ""}`);
        } else if (m.type === "npipe") {
          ctx.note(`${svc.name}: npipe mount ${m.target} has no Linux equivalent`);
        }
      }
    }
    for (const [stack, lines] of [...tmpfiles].sort()) {
      ctx.file(`etc/tmpfiles.d/${stack}.conf`, [`# Rendered by ${ctx.rendererName}: local volumes of stack ${stack}`, `# Type Path Mode User Group Age`, ...lines].join("\n") + "\n");
      ctx.install("pre", `systemd-tmpfiles --create '/etc/tmpfiles.d/${stack}.conf' || true`);
    }
  },
};
