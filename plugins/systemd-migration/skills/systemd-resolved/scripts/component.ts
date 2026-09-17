// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The resolved component: how services find each other once the
// orchestrator's embedded DNS is gone. One decision per estate picks the
// mechanism; the component renders what the choice needs on each host.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";
import { placementId } from "../../../contract/compose.ts";
import { splitList } from "../../../contract/plan.ts";
import { LEASES, type Lease, domainId, vipId } from "../../systemd-networkd/scripts/component.ts";

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
    /** The address a service answers on estate-wide, when a published port gave it one of its own. */
    const vip = (service: string): string | null => (ctx.resolvable(vipId(service)) ? ctx.value(vipId(service)) : null);
    if (how === "dnssd") {
      for (const inst of ctx.instances) {
        const address = vip(inst.service.name);
        if (address) ctx.note(`${inst.service.name}: the DNS-SD records announce ${ctx.host}, not the virtual address ${address} the multipath publish decision gave the service; a client that resolves the service through DNS-SD reaches one host directly and bypasses the multipath route, so publish an A record for ${address} in the site's DNS when the virtual address is meant to be the entry point`, "decision");
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
      const lines: string[] = [`# Rendered by ${ctx.rendererName}: service names for the migrated estate; one line per name, pointing at the host that runs it, or at the machine's static lease on its zone bridge`];
      const hostAddr = (h: string) => ctx.plan.hosts[h]?.addresses?.[0] ?? ctx.inventory.nodes.find((n) => n.hostname === h)?.addr ?? null;
      const leases = ctx.get<Lease[]>(LEASES) ?? [];
      const zones = new Set<string>();
      const segments = new Set<string>();
      for (const svc of [...ctx.inventory.services].sort((a, b) => a.name.localeCompare(b.name))) {
        const hosts = [...new Set(splitList(ctx.valueOr(placementId(svc.name), "")))].sort();
        const names = new Set<string>([svc.name, svc.short_name]);
        for (const n of svc.networks) for (const a of n.aliases) names.add(a);
        // A service with an address of its own answers there wherever it runs, so the
        // fragment names the virtual address once instead of every host that carries it.
        const address = vip(svc.name);
        if (address) {
          lines.push(`${address} ${[...names].join(" ")}`);
          ctx.note(`${svc.name}: resolved at its virtual address ${address} rather than at ${hosts.join(", ")}; the multipath routes the networkd component renders are what carry that address to the instances`);
          continue;
        }
        for (const h of hosts) {
          const machines = leases.filter((l) => l.service === svc.name && l.host === h).sort((a, b) => a.base.localeCompare(b.base));
          if (machines.length) {
            for (const m of machines) {
              lines.push(`${m.address} ${[...new Set([m.base, ...names])].join(" ")}`);
              (m.kind === "lease" ? zones : segments).add(m.network);
            }
            continue;
          }
          const addr = hostAddr(h);
          if (addr) lines.push(`${addr} ${[...names].join(" ")}`);
          else ctx.note(`${svc.name}: no address known for ${h}; add its hosts line by hand`, "decision");
        }
      }
      ctx.file("etc/hosts.d/systemd-migration.hosts", lines.join("\n") + "\n");
      ctx.install("pre", "cat /etc/hosts.d/systemd-migration.hosts >> /etc/hosts");
      ctx.note("service names are resolved from /etc/hosts (decision resolved.discovery.estate); install.sh appends the rendered fragment once, dedupe it by hand on re-install");
      for (const z of [...segments].sort()) ctx.note(`machines on the ${z} segment are listed at the address the guest must configure (see the networkd component's notes)`, "decision");
      for (const z of [...zones].sort()) ctx.note(`machines on zone vz-${z} are listed at their static lease address; on ${ctx.host} their DHCP lease names also resolve under ${ctx.valueOr(domainId(z), "the zone's local lease domain")} through the bridge's LocalLeaseDomain=`);
    } else {
      ctx.note(`service names are published in the site's DNS by decision; the records to create are listed per service in the plan (${ctx.instances.map((i) => `${i.service.name} -> ${vip(i.service.name) ?? ctx.host}${i.service.ports.map((p) => `:${p.published ?? p.target}`).join("")}`).join("; ")})`, "decision");
      for (const name of [...new Set(ctx.instances.map((i) => i.service.name))].sort()) {
        const address = vip(name);
        if (address) ctx.note(`${name}: publish one A record for ${address}, its virtual address, instead of one per host; the multipath routes carry it to whichever instance the flow hashes onto`, "decision");
      }
    }
  },
};
