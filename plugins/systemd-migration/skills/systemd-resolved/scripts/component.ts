// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The resolved component: how services find each other once the
// orchestrator's embedded DNS is gone. One decision per estate picks the
// mechanism; the component renders what the choice needs on each host.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import { publishId } from "../../systemd-networkd/scripts/component.ts";

export const DISCOVERY = "resolved.discovery.estate";

export const resolvedComponent: Component = {
  id: "resolved",
  title: "Name resolution (resolved.conf, systemd.dnssd, resolvectl)",
  covers: ["systemd-resolved.service", "resolved.conf", "systemd.dnssd", "resolvectl", "nss-resolve", "nss-myhostname", "nss-mymachines", "systemd.dns-delegate", "dnssec-trust-anchors.d"],
  after: ["networkd"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const names = new Set<string>();
    for (const s of ctx.inventory.services) for (const n of s.networks) for (const a of n.aliases) names.add(a);
    return [
      {
        id: DISCOVERY,
        kind: "choice",
        subject: { kind: "estate", name: "estate" },
        question: "How do services resolve each other's names on the systemd hosts?",
        options: [
          { value: "hosts", label: "/etc/hosts entries", consequence: "each host gets a rendered hosts fragment mapping service names and aliases to the host that runs them; static, no daemon" },
          { value: "dnssd", label: "resolved with DNS-SD", consequence: "each host announces its services with .dnssd files and resolves peers through mDNS/LLMNR on the zone", requires: { daemons: ["resolved"] } },
          { value: "site-dns", label: "the site's DNS", consequence: "you publish the records; the plan lists name, host, and port for each service" },
        ],
        default: null,
        evidence: [`service names and aliases in use: ${[...names].sort().join(", ") || "none"}`],
      },
    ];
  },

  render(ctx: RenderContext): void {
    const how = ctx.value(DISCOVERY);
    if (how === "dnssd") {
      for (const inst of ctx.instances) {
        for (const p of inst.service.ports) {
          const published = p.published ?? p.target;
          const port = inst.count > 1 ? published + (inst.index - 1) : published;
          const d = ctx.unitAt(`etc/systemd/dnssd/${inst.base}-${port}.dnssd`, [`Rendered by ${ctx.rendererName}: announces ${inst.service.name} port ${port}/${p.protocol} on ${ctx.host}`]);
          d.add("Service", "Name", `${inst.base} on %H`);
          d.add("Service", "Type", `_${inst.service.short_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}._${p.protocol}`);
          d.add("Service", "Port", port);
          d.add("Service", "TxtText", `stack=${inst.stack} service=${inst.service.name}`);
        }
      }
      ctx.file("etc/systemd/resolved.conf.d/10-migration.conf", [`# Rendered by ${ctx.rendererName}: multicast resolution for service discovery`, "[Resolve]", "MulticastDNS=yes", "LLMNR=yes", ""].join("\n"));
      ctx.install("post", "systemctl try-restart systemd-resolved.service");
    } else if (how === "hosts") {
      const lines: string[] = [`# Rendered by ${ctx.rendererName}: service names for the migrated estate; one line per name, pointing at the host that runs it`];
      const hostAddr = (h: string) => ctx.plan.hosts[h]?.addresses?.[0] ?? ctx.inventory.nodes.find((n) => n.hostname === h)?.addr ?? null;
      for (const svc of [...ctx.inventory.services].sort((a, b) => a.name.localeCompare(b.name))) {
        const hosts = [...new Set(svc.tasks.filter((t) => t.desired_state === "running").map((t) => t.node))];
        const names = new Set<string>([svc.name, svc.short_name]);
        for (const n of svc.networks) for (const a of n.aliases) names.add(a);
        for (const h of hosts) {
          const addr = hostAddr(h);
          if (addr) lines.push(`${addr} ${[...names].join(" ")}`);
          else ctx.note(`${svc.name}: no address known for ${h}; add its hosts line by hand`, "decision");
        }
      }
      ctx.file("etc/hosts.d/systemd-migration.hosts", lines.join("\n") + "\n");
      ctx.install("pre", "cat /etc/hosts.d/systemd-migration.hosts >> /etc/hosts");
      ctx.note("service names are resolved from /etc/hosts (decision resolved.discovery.estate); install.sh appends the rendered fragment once, dedupe it by hand on re-install");
    } else {
      ctx.note(`service names are published in the site's DNS by decision; the records to create are listed per service in the plan (${ctx.instances.map((i) => `${i.service.name} -> ${ctx.host}${i.service.ports.map((p) => `:${p.published ?? p.target}`).join("")}`).join("; ")})`, "decision");
    }
    void publishId;
  },
};
