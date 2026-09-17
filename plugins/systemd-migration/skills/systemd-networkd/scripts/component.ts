// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The networkd component: what replaces the orchestrator's networks. Every
// address range, overlay transport, and published-port policy is a decision
// with the source's own values as evidence, never a constant. This module
// raises those decisions and renders the port policy of plain services;
// bridges, overlays, and machine attachment are rendered by the same
// component as the plan resolves them (see the systemd-networkd skill).

import type { Component, DecisionSpec, PlanContext, RenderContext, ServiceShape } from "../../../contract/component.ts";
import { instanceKey } from "../../../contract/component.ts";
import type { Network } from "../../../contract/types.ts";

export function subnetId(net: string): string {
  return `networkd.subnet.${net}`;
}
export function transportId(net: string): string {
  return `networkd.transport.${net}`;
}
export function publishId(service: string, port: number, protocol: string): string {
  return `networkd.publish.${service}.${port}-${protocol}`;
}
export function zoneId(service: string): string {
  return `networkd.zone.${service}`;
}

function isApplicationNetwork(n: Network): boolean {
  return !n.ingress && n.name !== "host" && n.name !== "bridge" && n.name !== "none" && n.driver !== "null" && n.driver !== "host";
}

export const networkdComponent: Component = {
  id: "networkd",
  title: "Networking (systemd.network, systemd.netdev, systemd.link, systemd.socket)",
  covers: ["systemd-networkd.service", "systemd.network", "systemd.netdev", "systemd.link", "networkd.conf", "networkctl", "systemd.socket", "systemd-socket-activate", "systemd-socket-proxyd", "systemd.net-naming-scheme", "systemd-networkd-wait-online.service", "systemd-network-generator.service"],
  after: ["service", "machined"],

  decide(ctx: PlanContext): DecisionSpec[] {
    const out: DecisionSpec[] = [];
    for (const n of ctx.inventory.networks.filter(isApplicationNetwork)) {
      const hosts = ctx.hostsOfNetwork(n);
      const source = n.ipam.config.map((c) => c.subnet).filter(Boolean) as string[];
      out.push({
        id: subnetId(n.name),
        kind: "value",
        format: "cidr",
        subject: { kind: "network", name: n.name },
        hosts,
        question: `Which address range does network ${n.name} use on the systemd hosts? The source used ${source.join(", ") || "an assigned range"}.`,
        default: source[0] ?? null,
        evidence: [`networks[${n.name}].driver=${n.driver}`, `networks[${n.name}].ipam.config=${JSON.stringify(n.ipam.config)}`, `members: ${n.used_by.join(", ") || "none"}`, `hosts: ${hosts.join(", ") || "none"}`],
      });
      if (n.driver === "overlay" && hosts.length > 1) {
        out.push({
          id: transportId(n.name),
          kind: "choice",
          subject: { kind: "network", name: n.name },
          hosts,
          question: `Network ${n.name} spans ${hosts.join(", ")}${n.encrypted ? " and was encrypted" : ""}. What carries it between the hosts?`,
          options: [
            { value: "vxlan-wireguard", label: "VXLAN over a WireGuard mesh", consequence: "a wg netdev per host pair with keys as credentials, the VXLAN rides inside it; encrypted like the source", requires: { daemons: ["networkd"] } },
            { value: "vxlan", label: "VXLAN over the underlay", consequence: "plain VXLAN between the hosts' addresses; unencrypted", requires: { daemons: ["networkd"] } },
            { value: "wireguard", label: "WireGuard only, routed", consequence: "each host's zone bridge subnet is routed over WireGuard; no L2 between hosts, aliases resolve per host", requires: { daemons: ["networkd"] } },
            { value: "underlay", label: "route over the existing network", consequence: "no overlay; each host's bridge subnet must be reachable through the site's routers" },
          ],
          default: n.encrypted ? "vxlan-wireguard" : null,
          evidence: [`networks[${n.name}].encrypted=${n.encrypted}`, `networks[${n.name}].scope=${n.scope}`, `members on ${hosts.length} hosts`],
        });
      }
    }
    for (const svc of ctx.inventory.services) {
      for (const p of svc.ports) {
        const published = p.published ?? p.target;
        out.push({
          id: publishId(svc.name, published, p.protocol),
          kind: "choice",
          subject: { kind: "port", name: `${svc.name}:${published}/${p.protocol}` },
          question: `Port ${published}/${p.protocol} of ${svc.name} was published in ${p.mode} mode${p.mode === "ingress" ? " through the routing mesh" : ""}. How do clients reach it now?`,
          options: [
            { value: "host", label: "on each host that runs it", consequence: "the service binds the port on its host; SocketBindAllow= restricts it to that port; clients use the host's address" },
            { value: "socket", label: "socket activation", consequence: "a .socket unit owns the port and passes it in; the process must accept an inherited socket", requires: { systemd: 250 } },
            { value: "external-lb", label: "behind an external load balancer", consequence: "same as host, and the plan lists the hosts as backends for the balancer you operate" },
            { value: "dns-rr", label: "DNS round robin", consequence: "same as host, plus one resolved/dnssd record per host announcing the port" },
          ],
          default: p.mode === "host" ? "host" : null,
          evidence: [`services[${svc.name}].ports[${p.target}] mode=${p.mode} published=${p.published ?? "unset"}`],
        });
      }
    }
    return out;
  },

  render(ctx: RenderContext): void {
    const inv = ctx.inventory;
    for (const inst of ctx.instances) {
      if (inst.form !== "service") continue;
      const shape = ctx.get<ServiceShape>(instanceKey(inst.base));
      if (!shape) continue;
      const svc = inst.service;
      const u = ctx.unit(shape.unit);
      for (const p of svc.ports) {
        const published = p.published ?? p.target;
        const port = inst.count > 1 ? published + (inst.index - 1) : published;
        const how = ctx.value(publishId(svc.name, published, p.protocol));
        if (port !== p.target) ctx.note(`${svc.name}: published port ${port} differs from the container port ${p.target}; a native service listens on the port the process opens, so configure the process to listen on ${port} or front it`, "decision");
        if (how === "socket") {
          const s = ctx.unit(`${inst.base}-${port}.socket`, [`Rendered by ${ctx.rendererName}: socket activation for ${svc.name} port ${port}/${p.protocol}`]);
          s.add("Unit", "Description", `${inst.base} port ${port}/${p.protocol}`);
          s.add("Socket", p.protocol === "udp" ? "ListenDatagram" : "ListenStream", port);
          s.add("Socket", "Service", shape.unit);
          s.add("Install", "WantedBy", "sockets.target");
          ctx.expect("sockets", `${inst.base}-${port}.socket`);
          ctx.wantedByStack(inst.stack, `${inst.base}-${port}.socket`);
          ctx.note(`${svc.name}: port ${port} is socket-activated; the process must accept the inherited listening socket (sd_listen_fds)`, "decision");
        } else {
          u.add("Service", "SocketBindAllow", `${p.protocol}:${port}`);
        }
        ctx.expectPort(port, p.protocol);
        if (how === "external-lb") ctx.note(`${svc.name}: port ${port} is a backend of your external load balancer on ${ctx.host}`);
        if (how === "dns-rr") ctx.note(`${svc.name}: port ${port} on ${ctx.host} is announced for DNS round robin by the resolved component`);
        if (inst.count > 1) ctx.note(`${svc.name}: instance ${inst.index} publishes ${port} instead of ${published} because several instances share ${ctx.host}`);
      }
      if (svc.ports.some((p) => ctx.value(publishId(svc.name, p.published ?? p.target, p.protocol)) !== "socket")) u.add("Service", "SocketBindDeny", "any");
      const nets = svc.networks.map((n) => inv.networks.find((x) => x.name === n.name || x.id === n.name)).filter((n): n is Network => !!n && isApplicationNetwork(n));
      for (const n of nets) {
        const subnet = ctx.valueOr(subnetId(n.name), "");
        const transport = ctx.hasDecision(transportId(n.name)) ? ctx.valueOr(transportId(n.name), "") : "local";
        ctx.expect("networks", n.name);
        ctx.note(`${svc.name}: member of ${n.driver} network ${n.name} (${subnet || "range undecided"}, ${transport || "transport undecided"}); a plain service shares the host's network namespace, so it reaches peers by host address or the name the resolved component provides; the network's bridge is rendered for the machines attached to it`);
      }
      if (svc.endpoint_mode === "vip" && nets.length) ctx.note(`${svc.name}: the source's VIP becomes one address per host; other services reach it by the host's address or a name the plan provides`);
    }
  },
};
