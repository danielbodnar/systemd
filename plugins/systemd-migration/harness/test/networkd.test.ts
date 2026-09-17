// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The networkd component for machines: every address, transport, and name
// comes from a decision in the plan, the zone bridge and its leases follow
// the decided range, each transport renders its own netdevs, and every
// rendered .network and .netdev passes the directive catalogue.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkUnitText } from "../../contract/catalog.ts";
import { RenderContext } from "../../contract/component.ts";
import { composePlan, composeRender, formId, placementId } from "../../contract/compose.ts";
import { type Plan, resolveDecision } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import {
  INGRESS_EVERY_HOST,
  INGRESS_PLACEMENT,
  LEASES,
  MULTIPATH_NEXTHOP,
  MULTIPATH_ROUTE,
  PROXY_IDLE,
  TRANSPORTS,
  VIP_RANGE,
  WIREGUARD_PORT,
  backendsOf,
  endpoint6Id,
  ingressId,
  ingressScope,
  machineMac,
  macsecParentId,
  multipathId,
  nextHopBase,
  parentId,
  publishId,
  subnetId,
  transportId,
  tunnelKeyId,
  tunnelPortId,
  uplinkBondId,
  uplinkId,
  uplinkOwnerId,
  uplinkVlanId,
  uplinkVlanTagId,
  uplinkVrfId,
  uplinkVrfTableId,
  vipId,
  vipLink,
  vniId,
  wireguardEndpointId,
  wireguardSubnetId,
  zoneId,
} from "../../skills/systemd-networkd/scripts/component.ts";
import { DISCOVERY } from "../../skills/systemd-resolved/scripts/component.ts";
import { planFor } from "../../skills/systemd-service/scripts/render.ts";

const capture = resolve(import.meta.dir, "../../../../test/test-container-migration/capture");
const inv: Inventory = normalize(capture);

const WRK = "hosts/swarm-wrk-1";
const MGR = "hosts/swarm-mgr-1";
const NET = "etc/systemd/network";

/** The fixture's transport decision for web_frontend, with web_app and web_proxy as machines on the two hosts. */
function multiHostPlan(transport: string): Plan {
  const plan = planFor(inv);
  resolveDecision(plan, formId("web_app"), "machine");
  resolveDecision(plan, formId("web_proxy"), "machine");
  resolveDecision(plan, transportId("web_frontend"), transport);
  return plan;
}

function render(plan: Plan) {
  return composeRender(inv, plan, COMPONENTS, { acceptDefaults: true });
}

/** Every rendered file under etc/systemd/network, with the catalogue type the checker uses for it. */
function networkFiles(files: Record<string, string | Uint8Array>): Array<[string, string, "network" | "netdev"]> {
  return Object.entries(files)
    .filter(([p]) => p.includes(`/${NET}/`))
    .map(([p, c]) => [p, c as string, p.endsWith(".netdev") ? "netdev" : "network"]);
}

function section(text: string, name: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line === `[${name}]`) {
      current = [];
      out.push(current);
    } else if (line.startsWith("[")) current = null;
    else if (current && line) current.push(line);
  }
  return out;
}

describe("decisions", () => {
  const { plan } = composePlan(inv, COMPONENTS);
  const find = (id: string) => plan.decisions.find((d) => d.id === id);

  test("every service with an application network gets a zone choice defaulting to its first network, plus the host namespace", () => {
    const app = find(zoneId("web_app"))!;
    expect(app.kind).toBe("choice");
    expect(app.options!.map((o) => o.value)).toEqual(["web_frontend", "host"]);
    expect(app.default).toBe("web_frontend");
    const exporter = find(zoneId("data_exporter"))!;
    expect(exporter.options!.map((o) => o.value)).toEqual(["data_backend", "data_monitoring", "host"]);
    expect(exporter.default).toBe("data_backend");
    expect(exporter.evidence!.some((e) => e.includes("services[data_exporter].networks[data_backend]"))).toBe(true);
  });

  test("a macvlan network asks for its parent link: the source's parent as the default, none when the source recorded none", () => {
    const parent = find(parentId("data_monitoring"))!;
    expect(parent.kind).toBe("value");
    expect(parent.format).toBe("name");
    expect(parent.default).toBe("eth1");
    expect(parent.evidence).toContain("networks[data_monitoring].options.parent=eth1");
    const bare = JSON.parse(JSON.stringify(inv)) as Inventory;
    delete bare.networks.find((n) => n.name === "data_monitoring")!.options["parent"];
    const { plan: p } = composePlan(bare, COMPONENTS);
    const d = p.decisions.find((x) => x.id === parentId("data_monitoring"))!;
    expect(d.default).toBeNull();
    expect(d.evidence).toContain("networks[data_monitoring].options.parent=unset");
    expect(p.decisions.some((x) => x.id === parentId("web_frontend"))).toBe(false);
  });

  test("the macvlan range defaults to the source's ip_range, the overlay range to its subnet", () => {
    expect(find(subnetId("data_monitoring"))!.default).toBe("192.168.50.128/25");
    expect(find(subnetId("web_frontend"))!.default).toBe("10.10.1.0/24");
  });

  test("a multi-host overlay gets a VNI, a tunnel range, the WireGuard port, and one endpoint per host, all from the inventory", () => {
    const vni = find(vniId("web_frontend"))!;
    expect(vni.format).toBe("port");
    expect(vni.default).toBe("3"); // data_backend, data_monitoring, web_frontend sorted by name
    expect(find(wireguardSubnetId("web_frontend"))!.default).toBe("100.64.3.0/24");
    expect(find(WIREGUARD_PORT)!.default).toBe("51820");
    const ep = find(wireguardEndpointId("swarm-wrk-1"))!;
    expect(ep.format).toBe("ipv4");
    expect(ep.default).toBe("10.0.0.12");
    expect(ep.evidence).toContain("nodes[swarm-wrk-1].addr=10.0.0.12");
    expect(find(vniId("data_backend"))).toBeUndefined();
    expect(find(uplinkId("swarm-wrk-1"))).toBeUndefined();
    for (const d of plan.decisions.filter((x) => x.component === "networkd")) expect(d.evidence!.length, d.id).toBeGreaterThan(0);
  });

  test("a probed address wins over the inventory's node address for the endpoint", () => {
    const { plan: p } = composePlan(inv, COMPONENTS, { hosts: { "swarm-wrk-1": { hostname: "swarm-wrk-1", systemd: { version: 260 }, kernel: { release: "6.14.0", major: 6, minor: 14 }, arch: "x86_64", cgroup_v2: true, overlayfs_fsconfig: true, daemons: { networkd: true }, tools: {}, addresses: ["198.51.100.12"] }, "swarm-mgr-1": null } });
    expect(p.decisions.find((d) => d.id === wireguardEndpointId("swarm-wrk-1"))!.default).toBe("198.51.100.12");
    expect(p.decisions.find((d) => d.id === wireguardEndpointId("swarm-mgr-1"))!.default).toBe("10.0.0.11");
  });

  test("a MAC derived from the machine name is locally administered, unicast, and stable", () => {
    const mac = machineMac("web_app");
    expect(mac).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
    const first = parseInt(mac.slice(0, 2), 16);
    expect(first & 0x02).toBe(0x02);
    expect(first & 0x01).toBe(0);
    expect(machineMac("web_app")).toBe(mac);
    expect(machineMac("web_app-2")).not.toBe(mac);
  });
});

describe("the zone bridge of a local network", () => {
  test("a machine on the single-host overlay gets a bridge .network with a static lease inside the decided range", () => {
    const plan = planFor(inv);
    resolveDecision(plan, formId("data_postgres"), "machine");
    const r = render(plan);
    const bridge = r.files[`${WRK}/${NET}/25-migration-vz-data_backend.network`] as string;
    expect(section(bridge, "Match")).toEqual([["Kind=bridge", "Name=vz-data_backend"]]);
    expect(bridge).toContain("Address=10.10.2.1/24");
    expect(bridge).toContain("DHCPServer=yes");
    expect(bridge).toContain("IPMasquerade=no"); // internal in the source
    expect(bridge).toContain("LinkLocalAddressing=yes");
    expect(bridge).toContain("PoolOffset=3");
    expect(bridge).toContain("PoolSize=252");
    expect(bridge).toContain("LocalLeaseDomain=_dhcp");
    expect(section(bridge, "DHCPServerStaticLease")).toEqual([[`MACAddress=${machineMac("data_postgres")}`, "Address=10.10.2.2", "Hostname=data_postgres"]]);
    expect(r.files[`${WRK}/etc/systemd/system/systemd-nspawn@data_postgres.service.d/10-migration.conf`]).toContain(`Environment=SYSTEMD_NSPAWN_NETWORK_MAC=${machineMac("data_postgres")}`);
    expect(r.hosts["swarm-wrk-1"]!.networks).toContain("25-migration-vz-data_backend.network");
    expect(r.files[`${WRK}/install.sh`]).toContain("networkctl reload");
    // A local network needs no transport, no tunnel, and no forwarding.
    expect(Object.keys(r.files).filter((p) => p.includes("25-migration-wg-") || p.includes("25-migration-vx-"))).toEqual([]);
    expect(r.files[`${WRK}/etc/sysctl.d/80-migration-forwarding.conf`]).toBeUndefined();
    expect(r.files[`${MGR}/${NET}/25-migration-vz-data_backend.network`]).toBeUndefined();
    // A plain service on the same network still renders no bridge on its own.
    expect(r.files[`${MGR}/${NET}/25-migration-vz-web_frontend.network`]).toBeUndefined();
  });

  test("changing networkd.subnet.<network> moves the bridge, the pool, and the lease", () => {
    const plan = planFor(inv);
    resolveDecision(plan, formId("data_postgres"), "machine");
    resolveDecision(plan, subnetId("data_backend"), "10.77.0.0/23");
    const r = render(plan);
    const bridge = r.files[`${WRK}/${NET}/25-migration-vz-data_backend.network`] as string;
    expect(bridge).toContain("Address=10.77.0.1/23");
    expect(bridge).toContain("Address=10.77.0.2");
    expect(bridge).toContain("PoolSize=508");
    expect(bridge).not.toContain("10.10.2.");
    const hosts = r.files[`${WRK}/etc/hosts.d/systemd-migration.hosts`] as string;
    expect(hosts).toContain("10.77.0.2 data_postgres postgres db");
    expect(hosts).toContain("10.0.0.12 data_exporter exporter"); // still a plain service on its host
  });

  test("a machine left in the host's namespace gets no bridge and binds the container port", () => {
    const plan = planFor(inv);
    resolveDecision(plan, formId("data_postgres"), "machine");
    resolveDecision(plan, zoneId("data_postgres"), "host");
    const r = render(plan);
    expect(r.files[`${WRK}/${NET}/25-migration-vz-data_backend.network`]).toBeUndefined();
    expect(r.files[`${WRK}/etc/systemd/nspawn/data_postgres.nspawn`]).toContain("Private=no");
    expect(r.files[`${WRK}/etc/systemd/nspawn/data_postgres.nspawn`]).not.toContain("Zone=");
  });
});

describe("transports of the multi-host encrypted overlay", () => {
  test("vxlan-wireguard renders the tunnel, the VXLAN inside it, and the peer from the endpoint decision", () => {
    const plan = multiHostPlan("vxlan-wireguard");
    resolveDecision(plan, wireguardEndpointId("swarm-wrk-1"), "203.0.113.12");
    const r = render(plan);
    for (const host of [WRK, MGR]) {
      expect(r.files[`${host}/${NET}/25-migration-wg-web_frontend.netdev`]).toBeDefined();
      expect(r.files[`${host}/${NET}/25-migration-vx-web_frontend.netdev`]).toBeDefined();
      expect(r.files[`${host}/${NET}/25-migration-vz-web_frontend.network`]).toBeDefined();
    }
    const wg = r.files[`${MGR}/${NET}/25-migration-wg-web_frontend.netdev`] as string;
    expect(wg).toContain("Kind=wireguard");
    expect(wg).toContain("ListenPort=51822"); // 51820 plus the network's position
    expect(wg).toContain("PrivateKey=@network.wireguard.private.25-migration-wg-web_frontend");
    expect(section(wg, "WireGuardPeer")).toEqual([["PublicKey=@network.wireguard.public.swarm-wrk-1", "Endpoint=203.0.113.12:51822", "AllowedIPs=100.64.3.2/32", "PersistentKeepalive=25"]]);
    expect(wg).not.toMatch(/PrivateKey=[^@]/);
    expect(r.files[`${MGR}/${NET}/25-migration-wg-web_frontend.network`]).toContain("Address=100.64.3.1/24");
    const vx = r.files[`${WRK}/${NET}/25-migration-vx-web_frontend.netdev`] as string;
    expect(vx).toContain("Kind=vxlan");
    expect(vx).toContain("VNI=3");
    expect(vx).toContain("Local=100.64.3.2");
    expect(vx).toContain("Remote=100.64.3.1");
    expect(r.files[`${WRK}/${NET}/25-migration-vx-web_frontend.network`]).toContain("Bridge=vz-web_frontend");
    // One L2 domain: each host takes a slice for its gateway and pool, and both hold the whole lease table.
    const mgr = r.files[`${MGR}/${NET}/25-migration-vz-web_frontend.network`] as string;
    const wrk = r.files[`${WRK}/${NET}/25-migration-vz-web_frontend.network`] as string;
    expect(mgr).toContain("Address=10.10.1.1/24");
    expect(wrk).toContain("Address=10.10.1.129/24");
    expect(section(mgr, "DHCPServerStaticLease")).toEqual(section(wrk, "DHCPServerStaticLease"));
    expect(section(wrk, "DHCPServerStaticLease").map((l) => l[1])).toEqual(["Address=10.10.1.2", "Address=10.10.1.130"]);
    expect(r.hosts["swarm-mgr-1"]!.credentials).toContain("network.wireguard.private.25-migration-wg-web_frontend");
    expect(r.hosts["swarm-mgr-1"]!.credentials).toContain("network.wireguard.public.swarm-wrk-1");
    expect(r.files[`${WRK}/etc/sysctl.d/80-migration-forwarding.conf`]).toBeUndefined();
    expect(r.files[`${WRK}/etc/systemd/nspawn/web_app.nspawn`]).toContain("Port=tcp:8080:8080");
  });

  test("the VNI and the tunnel range follow their decisions", () => {
    const plan = multiHostPlan("vxlan-wireguard");
    resolveDecision(plan, vniId("web_frontend"), "4242");
    resolveDecision(plan, wireguardSubnetId("web_frontend"), "10.200.0.0/29");
    resolveDecision(plan, WIREGUARD_PORT, "40000");
    const r = render(plan);
    const vx = r.files[`${WRK}/${NET}/25-migration-vx-web_frontend.netdev`] as string;
    expect(vx).toContain("VNI=4242");
    expect(vx).toContain("Local=10.200.0.2");
    expect(r.files[`${WRK}/${NET}/25-migration-wg-web_frontend.netdev`]).toContain("Endpoint=10.0.0.11:40002");
  });

  test("plain vxlan uses the hosts' own addresses and no tunnel", () => {
    const r = render(multiHostPlan("vxlan"));
    expect(r.files[`${WRK}/${NET}/25-migration-wg-web_frontend.netdev`]).toBeUndefined();
    const vx = r.files[`${WRK}/${NET}/25-migration-vx-web_frontend.netdev`] as string;
    expect(vx).toContain("Local=10.0.0.12");
    expect(vx).toContain("Remote=10.0.0.11");
  });

  test("routed WireGuard gives each host its own slice, routes the peer's slice through the tunnel, and enables forwarding", () => {
    const r = render(multiHostPlan("wireguard"));
    expect(r.files[`${WRK}/${NET}/25-migration-vx-web_frontend.netdev`]).toBeUndefined();
    const bridge = r.files[`${WRK}/${NET}/25-migration-vz-web_frontend.network`] as string;
    expect(bridge).toContain("Address=10.10.1.129/25");
    expect(bridge).toContain("IPv4Forwarding=yes");
    expect(bridge).toContain("PoolOffset=3"); // relative to the slice
    expect(section(bridge, "DHCPServerStaticLease")).toEqual([[`MACAddress=${machineMac("web_app")}`, "Address=10.10.1.130", "Hostname=web_app"]]);
    const wg = r.files[`${WRK}/${NET}/25-migration-wg-web_frontend.netdev`] as string;
    expect(section(wg, "WireGuardPeer")[0]).toContain("AllowedIPs=10.10.1.0/25");
    const tunnel = r.files[`${WRK}/${NET}/25-migration-wg-web_frontend.network`] as string;
    expect(section(tunnel, "Route")).toEqual([["Destination=10.10.1.0/25", "Gateway=100.64.3.1"]]);
    expect(r.files[`${WRK}/etc/sysctl.d/80-migration-forwarding.conf`]).toContain("net.ipv4.ip_forward = 1");
    expect(r.files[`${WRK}/install.sh`]).toContain("sysctl --system");
  });

  test("underlay renders routes as a drop-in for the decided uplink and no netdev", () => {
    const first = multiHostPlan("underlay");
    // Choosing underlay raises the uplink question on the next plan; it has no default.
    const { plan } = composePlan(inv, COMPONENTS, { existing: first });
    const uplink = plan.decisions.find((d) => d.id === uplinkId("swarm-wrk-1"))!;
    expect(uplink.default).toBeNull();
    expect(uplink.format).toBe("path");
    resolveDecision(plan, uplinkId("swarm-wrk-1"), "/etc/systemd/network/10-eth0.network");
    resolveDecision(plan, uplinkId("swarm-mgr-1"), "/usr/lib/systemd/network/89-ethernet.network");
    resolveDecision(plan, DISCOVERY, "hosts");
    const r = render(plan);
    expect(Object.keys(r.files).some((p) => p.endsWith(".netdev"))).toBe(false);
    const routes = r.files[`${WRK}/${NET}/10-eth0.network.d/25-migration-web_frontend.conf`] as string;
    expect(section(routes, "Route")).toEqual([["Destination=10.10.1.0/25", "Gateway=10.0.0.11"]]);
    expect(checkUnitText(routes, "network").unknown).toEqual([]);
    expect(r.files[`${MGR}/${NET}/89-ethernet.network.d/25-migration-web_frontend.conf`]).toContain("Destination=10.10.1.128/25");
    expect(r.files[`${MGR}/etc/sysctl.d/80-migration-forwarding.conf`]).toBeDefined();
    // Without the uplink answered, the routes are a decision note, not a guess.
    const bare = render(first);
    expect(Object.keys(bare.files).some((p) => p.includes(".network.d/"))).toBe(false);
    expect(bare.decisions.some((n) => n.includes(uplinkId("swarm-wrk-1")))).toBe(true);
  });

  test("more than two hosts flood the VXLAN with one entry per peer instead of Remote=", () => {
    const three = JSON.parse(JSON.stringify(inv)) as Inventory;
    three.nodes.push({ ...three.nodes[0]!, id: "n3", hostname: "swarm-wrk-2", addr: "10.0.0.13", leader: false, role: "worker" });
    const plan = planFor(three);
    resolveDecision(plan, formId("web_app"), "machine");
    resolveDecision(plan, placementId("web_app"), "swarm-mgr-1,swarm-wrk-1,swarm-wrk-2");
    resolveDecision(plan, transportId("web_frontend"), "vxlan");
    const { plan: again } = composePlan(three, COMPONENTS, { existing: plan });
    const r = composeRender(three, again, COMPONENTS, { acceptDefaults: true });
    const vx = r.files[`${WRK}/${NET}/25-migration-vx-web_frontend.netdev`] as string;
    expect(vx).not.toContain("Remote=");
    expect(section(r.files[`${WRK}/${NET}/25-migration-vx-web_frontend.network`] as string, "BridgeFDB")).toEqual([
      ["MACAddress=00:00:00:00:00:00", "Destination=10.0.0.11"],
      ["MACAddress=00:00:00:00:00:00", "Destination=10.0.0.13"],
    ]);
    // Three hosts take four slices of /26.
    expect(r.files[`hosts/swarm-wrk-2/${NET}/25-migration-vz-web_frontend.network`]).toContain("Address=10.10.1.129/24");
  });
});

describe("macvlan", () => {
  test("renders a macvlan netdev on the decided parent and attaches the machine to the parent", () => {
    const plan = planFor(inv);
    resolveDecision(plan, formId("data_exporter"), "machine");
    resolveDecision(plan, zoneId("data_exporter"), "data_monitoring");
    const r = render(plan);
    const netdev = r.files[`${WRK}/${NET}/25-migration-mv-data_monitoring.netdev`] as string;
    expect(netdev).toContain("Kind=macvlan");
    // mv-data_monitoring would be eighteen characters, which the kernel refuses,
    // so the name keeps its first ten and takes a digest of the whole.
    const dev = /^Name=(.*)$/m.exec(netdev)![1]!;
    expect(dev).toMatch(/^mv-data_mo-[0-9a-f]{4}$/);
    expect(dev.length).toBe(15);
    expect(section(netdev, "MACVLAN")).toEqual([["Mode=bridge"]]);
    const parent = r.files[`${WRK}/${NET}/25-migration-parent-data_monitoring.network`] as string;
    expect(section(parent, "Match")).toEqual([["Name=eth1"]]);
    expect(parent).toContain(`MACVLAN=${dev}`);
    expect(r.files[`${WRK}/${NET}/25-migration-mv-data_monitoring.network`]).toContain("Address=192.168.50.129/25");
    expect(r.files[`${WRK}/etc/systemd/nspawn/data_exporter.nspawn`]).toContain("MACVLAN=eth1");
    // The machine sits on the parent's segment, so no zone bridge is created beside it.
    expect(r.files[`${WRK}/etc/systemd/nspawn/data_exporter.nspawn`]).not.toContain("Zone=");
    expect(r.files[`${WRK}/${NET}/25-migration-vz-data_monitoring.network`]).toBeUndefined();
    expect(r.files[`${WRK}/etc/hosts.d/systemd-migration.hosts`]).toContain("192.168.50.130 data_exporter exporter");
    resolveDecision(plan, parentId("data_monitoring"), "eth2");
    const again = render(plan);
    expect(section(again.files[`${WRK}/${NET}/25-migration-parent-data_monitoring.network`] as string, "Match")).toEqual([["Name=eth2"]]);
    expect(again.files[`${WRK}/etc/systemd/nspawn/data_exporter.nspawn`]).toContain("MACVLAN=eth2");
  });
});

describe("the catalogue", () => {
  test("every rendered .network and .netdev uses documented directives only", () => {
    const plans = [
      (() => {
        const p = planFor(inv);
        resolveDecision(p, formId("data_postgres"), "machine");
        resolveDecision(p, formId("data_exporter"), "machine");
        resolveDecision(p, zoneId("data_exporter"), "data_monitoring");
        return p;
      })(),
      multiHostPlan("vxlan-wireguard"),
      multiHostPlan("vxlan"),
      multiHostPlan("wireguard"),
    ];
    let checked = 0;
    for (const plan of plans) {
      for (const [path, text, type] of networkFiles(render(plan).files)) {
        const check = checkUnitText(text, type);
        expect(check.unknown, path).toEqual([]);
        expect(check.resolved.length, path).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(12);
  });
});

// PLAN.md 10.5: every tunnel kind systemd.netdev(5) documents as a transport,
// and the uplink the harness owns. PLAN.md 10.2: the load-balancing options of
// a published port, the ingress scope, and the backend table behind them.

/** A second planning pass, which is what raises the decisions a chosen option needs. */
function replan(plan: Plan, inventory: Inventory = inv): Plan {
  return composePlan(inventory, COMPONENTS, { existing: plan }).plan;
}

/** Answer whatever a fresh pass raised without a default, so the plan renders. */
function settle(plan: Plan): Plan {
  for (const d of plan.decisions) {
    if (d.chosen != null || d.default != null) continue;
    if (d.kind === "choice" && d.options?.length) resolveDecision(plan, d.id, d.options[0]!.value);
    else if (d.id === endpoint6Id("swarm-wrk-1")) resolveDecision(plan, d.id, "2001:db8::12");
    else if (d.id === endpoint6Id("swarm-mgr-1")) resolveDecision(plan, d.id, "2001:db8::11");
    else if (d.id === macsecParentId("web_frontend")) resolveDecision(plan, d.id, "eth0");
    else throw new Error(`the test has no answer for ${d.id} (${d.question})`);
  }
  return plan;
}

/** web_frontend across both hosts on `kind`, with the decisions that kind raises answered. */
function transportPlan(kind: string): Plan {
  return settle(replan(multiHostPlan(kind)));
}

describe("every transport kind of PLAN.md 10.5", () => {
  const cases: Array<[transport: string, file: string, netdev: string, shape: "bridge" | "route"]> = [
    ["geneve", "25-migration-gn-web_frontend-swarm-mgr-1", "geneve", "bridge"],
    ["gretap", "25-migration-gt-web_frontend-swarm-mgr-1", "gretap", "bridge"],
    ["ip6gretap", "25-migration-g6t-web_frontend-swarm-mgr-1", "ip6gretap", "bridge"],
    ["erspan", "25-migration-er-web_frontend-swarm-mgr-1", "erspan", "bridge"],
    ["l2tp", "25-migration-l2-web_frontend-swarm-mgr-1", "l2tp", "bridge"],
    ["macsec", "25-migration-ms-web_frontend", "macsec", "bridge"],
    ["gre", "25-migration-gr-web_frontend-swarm-mgr-1", "gre", "route"],
    ["ip6gre", "25-migration-g6-web_frontend-swarm-mgr-1", "ip6gre", "route"],
    ["ipip", "25-migration-ii-web_frontend-swarm-mgr-1", "ipip", "route"],
    ["sit", "25-migration-si-web_frontend-swarm-mgr-1", "sit", "route"],
    ["ip6tnl", "25-migration-i6-web_frontend-swarm-mgr-1", "ip6tnl", "route"],
    ["vti", "25-migration-vti-web_frontend-swarm-mgr-1", "vti", "route"],
    ["vti6", "25-migration-vt6-web_frontend-swarm-mgr-1", "vti6", "route"],
    ["xfrm", "25-migration-xf-web_frontend", "xfrm", "route"],
    ["bareudp", "25-migration-bu-web_frontend", "bareudp", "route"],
    ["fou", "25-migration-fo-web_frontend-swarm-mgr-1", "ipip", "route"],
  ];

  for (const [transport, file, netdev, shape] of cases) {
    test(`${transport} renders a ${netdev} netdev that the catalogue documents, ${shape === "bridge" ? "enslaved into the zone bridge" : "routing the peer's slice"}`, () => {
      const r = render(transportPlan(transport));
      const dev = r.files[`${WRK}/${NET}/${file}.netdev`] as string;
      const net = r.files[`${WRK}/${NET}/${file}.network`] as string;
      expect(dev, `${file}.netdev`).toBeDefined();
      expect(dev).toContain(`Kind=${netdev}`);
      // The interface name never exceeds what the kernel accepts.
      expect(/^Name=(.*)$/m.exec(dev)![1]!.length).toBeLessThanOrEqual(15);
      if (shape === "bridge") expect(net).toContain("Bridge=vz-web_frontend");
      else expect(section(net, "Route")[0]).toContain("Destination=10.10.1.0/25");
      // The bridge follows the layer: one broadcast domain, or a routed slice.
      const bridge = r.files[`${WRK}/${NET}/25-migration-vz-web_frontend.network`] as string;
      expect(bridge).toContain(shape === "bridge" ? "Address=10.10.1.129/24" : "Address=10.10.1.129/25");
      expect(r.files[`${WRK}/etc/sysctl.d/80-migration-forwarding.conf`] === undefined).toBe(shape === "bridge");
      // Every file the transport rendered passes the catalogue.
      let checked = 0;
      for (const [path, text, type] of networkFiles(r.files)) {
        expect(checkUnitText(text, type).unknown, path).toEqual([]);
        checked++;
      }
      expect(checked).toBeGreaterThan(3);
      expect(r.hosts["swarm-wrk-1"]!.networks).toContain(`${file}.netdev`);
    });
  }

  test("the identifiers and ports come from decisions, not from the kind", () => {
    const plan = transportPlan("geneve");
    resolveDecision(plan, vniId("web_frontend"), "7777");
    resolveDecision(plan, tunnelPortId("web_frontend"), "7788");
    const dev = render(plan).files[`${WRK}/${NET}/25-migration-gn-web_frontend-swarm-mgr-1.netdev`] as string;
    expect(dev).toContain("Id=7777");
    expect(dev).toContain("DestinationPort=7788");
    expect(dev).toContain("Remote=10.0.0.11");
    const key = transportPlan("gre");
    resolveDecision(key, tunnelKeyId("web_frontend"), "4242");
    expect(render(key).files[`${WRK}/${NET}/25-migration-gr-web_frontend-swarm-mgr-1.netdev`]).toContain("Key=4242");
  });

  test("a kind whose endpoints are IPv6 asks for an IPv6 endpoint per host and uses it", () => {
    const first = multiHostPlan("ip6gre");
    const raised = replan(first);
    const ep = raised.decisions.find((d) => d.id === endpoint6Id("swarm-mgr-1"))!;
    expect(ep.kind).toBe("value");
    expect(ep.default).toBeNull(); // the fixture's nodes carry no IPv6 address
    expect(raised.decisions.find((d) => d.id === endpoint6Id("swarm-wrk-1"))).toBeDefined();
    const dev = render(settle(raised)).files[`${WRK}/${NET}/25-migration-g6-web_frontend-swarm-mgr-1.netdev`] as string;
    expect(dev).toContain("Local=2001:db8::12");
    expect(dev).toContain("Remote=2001:db8::11");
    // An IPv4 kind raises no IPv6 endpoint at all.
    expect(replan(multiHostPlan("gre")).decisions.some((d) => d.id === endpoint6Id("swarm-mgr-1"))).toBe(false);
  });

  test("MACsec keeps its key in a credential and stacks on the decided parent link", () => {
    const plan = transportPlan("macsec");
    resolveDecision(plan, macsecParentId("web_frontend"), "eth3");
    const r = render(plan);
    const dev = r.files[`${WRK}/${NET}/25-migration-ms-web_frontend.netdev`] as string;
    expect(dev).toContain("KeyFile=/run/credentials/systemd-networkd.service/network.macsec.key.web_frontend");
    expect(dev).not.toMatch(/^Key=/m);
    expect(section(r.files[`${WRK}/${NET}/25-migration-macsec-parent-web_frontend.network`] as string, "Match")).toEqual([["Name=eth3"]]);
    expect(r.files[`${WRK}/etc/systemd/system/systemd-networkd.service.d/25-migration-macsec.conf`]).toContain("LoadCredentialEncrypted=network.macsec.key.web_frontend");
    expect(r.hosts["swarm-wrk-1"]!.credentials).toContain("network.macsec.key.web_frontend");
  });

  test("L2TP mirrors the tunnel and session ids of the two ends", () => {
    const r = render(transportPlan("l2tp"));
    const wrk = r.files[`${WRK}/${NET}/25-migration-l2-web_frontend-swarm-mgr-1.netdev`] as string;
    const mgr = r.files[`${MGR}/${NET}/25-migration-l2-web_frontend-swarm-wrk-1.netdev`] as string;
    const value = (text: string, key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)![1];
    expect(value(wrk, "TunnelId")).toBe(value(mgr, "PeerTunnelId"));
    expect(value(mgr, "TunnelId")).toBe(value(wrk, "PeerTunnelId"));
    expect(value(wrk, "SessionId")).toBe(value(mgr, "PeerSessionId"));
    expect(value(wrk, "EncapsulationType")).toBe("udp");
  });

  test("Foo-over-UDP renders the receive port beside the tunnels", () => {
    const r = render(transportPlan("fou"));
    const fou = r.files[`${WRK}/${NET}/25-migration-fou-web_frontend.netdev`] as string;
    expect(fou).toContain("Kind=fou");
    expect(fou).toContain("Protocol=ipip");
    const tun = r.files[`${WRK}/${NET}/25-migration-fo-web_frontend-swarm-mgr-1.netdev`] as string;
    expect(tun).toContain("FooOverUDP=yes");
    expect(tun).toContain(`FOUDestinationPort=${/^Port=(.*)$/m.exec(fou)![1]}`);
  });

  test("every transport option carries the systemd version the catalogue gives its directives", () => {
    const { plan } = composePlan(inv, COMPONENTS);
    const options = plan.decisions.find((d) => d.id === transportId("web_frontend"))!.options!;
    expect(options.map((o) => o.value)).toEqual(TRANSPORTS.map((t) => t.value));
    const version = (value: string) => options.find((o) => o.value === value)!.requires?.systemd;
    expect(version("vxlan")).toBe(243); // VNI= was named Id= before v243
    expect(version("erspan")).toBe(252); // ERSPANVersion= and ERSPANDirection=
    expect(version("l2tp")).toBe(245); // UDPDestinationPort=
    expect(version("bareudp")).toBe(247);
    expect(version("underlay")).toBeUndefined(); // nothing is created
    for (const o of options) if (o.value !== "underlay") expect(o.requires!.daemons, o.value).toEqual(["networkd"]);
  });
});

describe("the uplink the harness owns", () => {
  /** underlay with the uplink answered on both hosts and owned by the harness on swarm-wrk-1 only. */
  function uplinkPlan(shape: { bond?: string; vlan?: string; vrf?: string }): Plan {
    const answered = replan(multiHostPlan("underlay"));
    resolveDecision(answered, uplinkId("swarm-wrk-1"), "/etc/systemd/network/10-eth0.network");
    resolveDecision(answered, uplinkId("swarm-mgr-1"), "/etc/systemd/network/10-eth0.network");
    resolveDecision(answered, uplinkOwnerId("swarm-wrk-1"), "harness");
    resolveDecision(answered, DISCOVERY, "hosts");
    const owned = replan(answered);
    if (shape.bond) resolveDecision(owned, uplinkBondId("swarm-wrk-1"), shape.bond);
    if (shape.vlan) resolveDecision(owned, uplinkVlanId("swarm-wrk-1"), "yes");
    if (shape.vrf) resolveDecision(owned, uplinkVrfId("swarm-wrk-1"), "yes");
    const shaped = replan(owned);
    if (shape.vlan) resolveDecision(shaped, uplinkVlanTagId("swarm-wrk-1"), shape.vlan);
    return shaped;
  }

  test("the owner decision defaults to the site, and nothing about the link is touched until it says otherwise", () => {
    const answered = replan(multiHostPlan("underlay"));
    const owner = answered.decisions.find((d) => d.id === uplinkOwnerId("swarm-wrk-1"))!;
    expect(owner.kind).toBe("choice");
    expect(owner.default).toBe("site");
    expect(owner.options!.map((o) => o.value)).toEqual(["site", "harness"]);
    // Until the owner says harness, the bond, VLAN, and VRF questions do not exist.
    resolveDecision(answered, uplinkId("swarm-wrk-1"), "/etc/systemd/network/10-eth0.network");
    resolveDecision(answered, uplinkId("swarm-mgr-1"), "/etc/systemd/network/10-eth0.network");
    resolveDecision(answered, DISCOVERY, "hosts");
    const again = replan(answered);
    for (const id of [uplinkBondId("swarm-wrk-1"), uplinkVlanId("swarm-wrk-1"), uplinkVrfId("swarm-wrk-1")]) expect(again.decisions.some((d) => d.id === id), id).toBe(false);
    const r = render(again);
    expect(Object.keys(r.files).some((p) => p.includes("25-migration-bond"))).toBe(false);
    expect(r.files[`${WRK}/${NET}/10-eth0.network.d/25-migration-web_frontend.conf`]).toBeDefined();
  });

  test("answering the owner with harness raises the bond, VLAN, and VRF questions on that host only", () => {
    const plan = uplinkPlan({});
    for (const id of [uplinkBondId("swarm-wrk-1"), uplinkVlanId("swarm-wrk-1"), uplinkVrfId("swarm-wrk-1")]) expect(plan.decisions.some((d) => d.id === id), id).toBe(true);
    for (const id of [uplinkBondId("swarm-mgr-1"), uplinkVlanId("swarm-mgr-1"), uplinkVrfId("swarm-mgr-1")]) expect(plan.decisions.some((d) => d.id === id), id).toBe(false);
    expect(plan.decisions.find((d) => d.id === uplinkBondId("swarm-wrk-1"))!.default).toBe("none");
    expect(plan.decisions.find((d) => d.id === uplinkVrfId("swarm-wrk-1"))!.default).toBe("no");
    // Every question answered with its default leaves the link exactly as the site has it.
    const r = render(plan);
    expect(Object.keys(r.files).filter((p) => p.includes("25-migration-bond") || p.includes("25-migration-vlan") || p.includes("25-migration-vrf"))).toEqual([]);
    expect(r.files[`${WRK}/${NET}/10-eth0.network.d/25-migration-web_frontend.conf`]).toBeDefined();
  });

  test("a bond, a tagged VLAN, and a VRF stack on the uplink and take the peer routes with them", () => {
    const plan = uplinkPlan({ bond: "802.3ad", vlan: "100", vrf: "yes" });
    expect(plan.decisions.find((d) => d.id === uplinkVrfTableId("swarm-wrk-1"))!.default).toBe("101"); // swarm-wrk-1 is the second overlay host
    const r = render(plan);
    const bond = r.files[`${WRK}/${NET}/25-migration-bond.netdev`] as string;
    expect(bond).toContain("Kind=bond");
    expect(bond).toContain("Mode=802.3ad");
    expect(r.files[`${WRK}/${NET}/10-eth0.network.d/25-migration-uplink.conf`]).toContain("Bond=bond-mig");
    expect(r.files[`${WRK}/${NET}/25-migration-bond.network`]).toContain("VLAN=vl-100");
    expect(r.files[`${WRK}/${NET}/25-migration-vlan.netdev`]).toContain("Id=100");
    expect(r.files[`${WRK}/${NET}/25-migration-uplink.network`]).toContain("VRF=vrf-mig");
    expect(r.files[`${WRK}/${NET}/25-migration-vrf.netdev`]).toContain("Table=101");
    // The routes move off the site's file onto the topmost interface, in the VRF's table.
    expect(r.files[`${WRK}/${NET}/10-eth0.network.d/25-migration-web_frontend.conf`]).toBeUndefined();
    expect(section(r.files[`${WRK}/${NET}/25-migration-uplink.network.d/25-migration-web_frontend.conf`] as string, "Route")).toEqual([["Destination=10.10.1.0/25", "Gateway=10.0.0.11", "Table=101"]]);
    // The host whose uplink stays the site's is untouched.
    expect(r.files[`${MGR}/${NET}/25-migration-bond.netdev`]).toBeUndefined();
    expect(r.files[`${MGR}/${NET}/10-eth0.network.d/25-migration-web_frontend.conf`]).toBeDefined();
    for (const [path, text, type] of networkFiles(r.files)) expect(checkUnitText(text, type).unknown, path).toEqual([]);
  });
});

describe("backends", () => {
  const webApp = inv.services.find((s) => s.name === "web_app")!;

  function contextFor(plan: Plan, host: string): RenderContext {
    return new RenderContext(inv, plan, host, null, [], true, "test");
  }

  test("backendsOf reads the plan's placement, so a remote host with several instances yields several backends", () => {
    const plan = planFor(inv);
    resolveDecision(plan, placementId("web_app"), "swarm-mgr-1,swarm-mgr-1,swarm-wrk-1");
    const b = backendsOf(contextFor(plan, "swarm-wrk-1"), webApp, webApp.ports[0]!, "swarm-wrk-1");
    expect(b.map((x) => `${x.base}@${x.host}:${x.port} ${x.scope}`)).toEqual([
      "web_app-1@swarm-mgr-1:8080 remote",
      "web_app-2@swarm-mgr-1:8081 remote",
      "web_app@swarm-wrk-1:8080 local",
    ]);
    expect(b.every((x) => x.address === (x.host === "swarm-mgr-1" ? "10.0.0.11" : "10.0.0.12"))).toBe(true);
  });

  test("a machine's backend is its lease at the container's own port", () => {
    const plan = planFor(inv);
    resolveDecision(plan, placementId("web_app"), "swarm-mgr-1,swarm-wrk-1");
    const ctx = contextFor(plan, "swarm-wrk-1");
    ctx.set(LEASES, [{ network: "web_frontend", host: "swarm-mgr-1", kind: "lease", base: "web_app", service: "web_app", address: "10.10.1.2", mac: machineMac("web_app") }]);
    const b = backendsOf(ctx, webApp, { target: 8080, published: 9090, protocol: "tcp" }, "swarm-wrk-1");
    expect(b.find((x) => x.host === "swarm-mgr-1")).toMatchObject({ address: "10.10.1.2", port: 8080, scope: "remote" });
    expect(b.find((x) => x.host === "swarm-wrk-1")).toMatchObject({ address: "10.0.0.12", port: 9090, scope: "local" });
  });

  test("the ingress decision defaults to the placement hosts and widens to every host of the plan", () => {
    const { plan } = composePlan(inv, COMPONENTS);
    const d = plan.decisions.find((x) => x.id === ingressId("web_app", 8080, "tcp"))!;
    expect(d.default).toBe(INGRESS_PLACEMENT);
    expect(d.options!.map((o) => o.value)).toEqual([INGRESS_PLACEMENT, INGRESS_EVERY_HOST]);
    expect(d.evidence).toContain("the source accepted this port on every node through the routing mesh");
    const resolved = planFor(inv);
    const exporter = inv.services.find((s) => s.name === "data_exporter")!;
    expect(ingressScope(contextFor(resolved, "swarm-mgr-1"), exporter, 9187, "tcp")).toEqual(["swarm-wrk-1"]);
    resolveDecision(resolved, ingressId("data_exporter", 9187, "tcp"), INGRESS_EVERY_HOST);
    expect(ingressScope(contextFor(resolved, "swarm-mgr-1"), exporter, 9187, "tcp")).toEqual(["swarm-mgr-1", "swarm-wrk-1"]);
  });
});

describe("load balancing on one host: reuseport", () => {
  function reuseportPlan(): Plan {
    const plan = planFor(inv);
    resolveDecision(plan, publishId("web_app", 8080, "tcp"), "reuseport");
    resolveDecision(plan, placementId("web_app"), "swarm-wrk-1,swarm-wrk-1");
    return plan;
  }

  test("one socket per instance, all on the published port, with ReusePort=yes", () => {
    const r = render(reuseportPlan());
    const first = r.files[`${WRK}/etc/systemd/system/web_app-1-8080.socket`] as string;
    const second = r.files[`${WRK}/etc/systemd/system/web_app-2-8080.socket`] as string;
    for (const [name, text, unit] of [["first", first, "web_app-1.service"], ["second", second, "web_app-2.service"]] as const) {
      expect(text, name).toBeDefined();
      expect(text).toContain("ListenStream=8080");
      expect(text).toContain("ReusePort=yes");
      expect(text).toContain(`Service=${unit}`);
      expect(checkUnitText(text, "socket").unknown).toEqual([]);
    }
    // The instances inherit the socket, so neither binds the port itself.
    expect(r.files[`${WRK}/etc/systemd/system/web_app-1.service`]).not.toContain("SocketBindAllow=tcp:8080");
    expect(r.hosts["swarm-wrk-1"]!.sockets).toEqual(["web_app-1-8080.socket", "web_app-2-8080.socket"]);
    expect(r.notes.some((n) => n.includes("the kernel picks one per connection"))).toBe(true);
  });

  test("the options that cannot honour an every-host ingress say so", () => {
    for (const how of ["host", "socket", "reuseport"]) {
      const plan = reuseportPlan();
      resolveDecision(plan, publishId("web_app", 8080, "tcp"), how);
      resolveDecision(plan, ingressId("web_app", 8080, "tcp"), INGRESS_EVERY_HOST);
      const r = render(plan);
      expect(r.decisions.some((n) => n.includes("every-host ingress") && n.includes(how)), how).toBe(true);
    }
  });
});

describe("load balancing over the estate: systemd-socket-proxyd", () => {
  function proxyPlan(ingress?: string): Plan {
    const plan = planFor(inv);
    resolveDecision(plan, publishId("web_app", 8080, "tcp"), "socket-proxyd");
    resolveDecision(plan, placementId("web_app"), "swarm-mgr-1,swarm-wrk-1");
    if (ingress) resolveDecision(plan, ingressId("web_app", 8080, "tcp"), ingress);
    return settle(replan(plan));
  }

  test("one socket per backend on the published port, each activating a proxy to that backend", () => {
    const r = render(proxyPlan());
    const local = r.files[`${WRK}/etc/systemd/system/web_app-8080-web_app-swarm-wrk-1.socket`] as string;
    const remote = r.files[`${WRK}/etc/systemd/system/web_app-8080-web_app-swarm-mgr-1.socket`] as string;
    for (const text of [local, remote]) {
      expect(text).toContain("ListenStream=8080");
      expect(text).toContain("ReusePort=yes");
      expect(checkUnitText(text, "socket").unknown).toEqual([]);
    }
    expect(local).toContain("Service=migration-socket-proxy@10.0.0.12:8080.service");
    expect(remote).toContain("Service=migration-socket-proxy@10.0.0.11:8080.service");
    // The local backend's proxy lives and dies with the instance behind it; the remote one does not.
    expect(r.files[`${WRK}/etc/systemd/system/migration-socket-proxy@10.0.0.12:8080.service.d/10-migration.conf`]).toContain("BindsTo=web_app.service");
    expect(r.files[`${WRK}/etc/systemd/system/migration-socket-proxy@10.0.0.11:8080.service.d/10-migration.conf`]).toBeUndefined();
    const template = r.files[`${WRK}/etc/systemd/system/migration-socket-proxy@.service`] as string;
    expect(template).toContain("ExecStart=/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=5min %I");
    expect(template).toContain("Type=notify");
    expect(template).toContain("DynamicUser=yes");
    expect(template).toContain("CapabilityBoundingSet=");
    expect(checkUnitText(template, "service").unknown).toEqual([]);
    expect(r.hosts["swarm-wrk-1"]!.units).toContain("migration-socket-proxy@.service");
    expect(r.hosts["swarm-wrk-1"]!.ports).toContainEqual({ port: 8080, protocol: "tcp" });
    // A local instance listening on the same port as the proxy is a collision, not a silence.
    expect(r.decisions.some((n) => n.includes("the same address and port the proxy sockets bind"))).toBe(true);
  });

  test("the idle timeout is a decision raised once a port chose the proxy", () => {
    const plan = proxyPlan();
    const idle = plan.decisions.find((d) => d.id === PROXY_IDLE)!;
    expect(idle.default).toBe("5min");
    resolveDecision(plan, idle.id, "90s");
    expect(render(plan).files[`${WRK}/etc/systemd/system/migration-socket-proxy@.service`]).toContain("--exit-idle-time=90s");
    expect(composePlan(inv, COMPONENTS).plan.decisions.some((d) => d.id === PROXY_IDLE)).toBe(false);
  });

  test("the ingress scope decides which hosts carry the proxies", () => {
    const placement = planFor(inv);
    resolveDecision(placement, publishId("data_exporter", 9187, "tcp"), "socket-proxyd");
    const near = render(settle(replan(placement)));
    expect(Object.keys(near.files).some((p) => p.startsWith(`${MGR}/etc/systemd/system/data_exporter-9187-`))).toBe(false);
    expect(Object.keys(near.files).some((p) => p.startsWith(`${WRK}/etc/systemd/system/data_exporter-9187-`))).toBe(true);

    const mesh = planFor(inv);
    resolveDecision(mesh, publishId("data_exporter", 9187, "tcp"), "socket-proxyd");
    resolveDecision(mesh, ingressId("data_exporter", 9187, "tcp"), INGRESS_EVERY_HOST);
    const r = render(settle(replan(mesh)));
    const remote = r.files[`${MGR}/etc/systemd/system/data_exporter-9187-data_exporter.socket`] as string;
    expect(remote).toContain("ListenStream=9187");
    expect(remote).toContain("Service=migration-socket-proxy@10.0.0.12:9187.service");
    expect(r.hosts["swarm-mgr-1"]!.ports).toContainEqual({ port: 9187, protocol: "tcp" });
  });
});

describe("load balancing over the estate: multipath and the service VIP", () => {
  /** data_exporter runs on swarm-wrk-1 only, so swarm-mgr-1 is a host in the mesh that runs no instance. */
  function multipathPlan(): Plan {
    const plan = planFor(inv);
    resolveDecision(plan, publishId("data_exporter", 9187, "tcp"), "multipath");
    resolveDecision(plan, ingressId("data_exporter", 9187, "tcp"), INGRESS_EVERY_HOST);
    resolveDecision(plan, DISCOVERY, "hosts");
    return settle(replan(plan));
  }

  test("the VIP and its range are decisions raised once a port chose multipath", () => {
    expect(composePlan(inv, COMPONENTS).plan.decisions.some((d) => d.id === VIP_RANGE)).toBe(false);
    const plan = multipathPlan();
    const range = plan.decisions.find((d) => d.id === VIP_RANGE)!;
    expect(range.format).toBe("cidr");
    expect(range.default).toBe("100.65.0.0/24");
    expect(range.evidence!.some((e) => e.includes("RFC 6598"))).toBe(true);
    const vip = plan.decisions.find((d) => d.id === vipId("data_exporter"))!;
    expect(vip.format).toBe("ipv4");
    expect(vip.default).toBe("100.65.0.1");
    expect(plan.decisions.find((d) => d.id === multipathId("data_exporter"))!.default).toBe(MULTIPATH_ROUTE);
  });

  test("the host that runs the service holds the address; the host that does not routes it over the backends", () => {
    const r = render(multipathPlan());
    const dev = r.files[`${WRK}/${NET}/25-migration-vip-data_exporter.netdev`] as string;
    expect(dev).toContain("Kind=dummy");
    const name = /^Name=(.*)$/m.exec(dev)![1]!;
    expect(name).toBe(vipLink("data_exporter"));
    expect(name.length).toBeLessThanOrEqual(15);
    const holder = r.files[`${WRK}/${NET}/25-migration-vip-data_exporter.network`] as string;
    expect(holder).toContain("Address=100.65.0.1/32");
    expect(section(holder, "Route")).toEqual([]);
    const router = r.files[`${MGR}/${NET}/25-migration-vip-data_exporter.network`] as string;
    expect(router).not.toContain("Address=");
    expect(section(router, "Route")).toEqual([["Destination=100.65.0.1/32", "MultiPathRoute=10.0.0.12 1"]]);
    expect(r.hosts["swarm-mgr-1"]!.ports).toContainEqual({ port: 9187, protocol: "tcp" });
    expect(r.notes.some((n) => n.includes("per flow and not health aware"))).toBe(true);
    for (const [path, text, type] of networkFiles(r.files)) expect(checkUnitText(text, type).unknown, path).toEqual([]);
  });

  test("the VIP follows its decision and the nexthop group is the second form", () => {
    const plan = multipathPlan();
    resolveDecision(plan, vipId("data_exporter"), "192.0.2.7");
    resolveDecision(plan, multipathId("data_exporter"), MULTIPATH_NEXTHOP);
    const r = render(plan);
    const router = r.files[`${MGR}/${NET}/25-migration-vip-data_exporter.network`] as string;
    const first = nextHopBase("data_exporter");
    expect(section(router, "NextHop")).toEqual([[`Id=${first}`, "Gateway=10.0.0.12"], [`Id=${first + 1}`, `Group=${first}:1`]]);
    expect(section(router, "Route")).toEqual([["Destination=192.0.2.7/32", `NextHop=${first + 1}`]]);
    expect(r.files[`${WRK}/${NET}/25-migration-vip-data_exporter.network`]).toContain("Address=192.0.2.7/32");
    expect(checkUnitText(router, "network").unknown).toEqual([]);
  });

  test("a service with a VIP is resolved at the VIP instead of per host", () => {
    const r = render(multipathPlan());
    const hosts = r.files[`${MGR}/etc/hosts.d/systemd-migration.hosts`] as string;
    expect(hosts).toContain("100.65.0.1 data_exporter exporter");
    expect(hosts).not.toContain("10.0.0.12 data_exporter");
    expect(hosts).toContain("10.0.0.12 data_postgres postgres db"); // still per host, it has no VIP
  });

  test("multipath without a VIP in the plan yet is a decision note, not a guess", () => {
    const plan = planFor(inv);
    resolveDecision(plan, publishId("data_exporter", 9187, "tcp"), "multipath");
    const r = render(plan);
    expect(Object.keys(r.files).some((p) => p.includes("25-migration-vip-"))).toBe(false);
    expect(r.decisions.some((n) => n.includes(vipId("data_exporter")))).toBe(true);
  });
});

describe("the publish decision", () => {
  test("offers every option of PLAN.md 10.2 with the requirements each needs", () => {
    const { plan } = composePlan(inv, COMPONENTS);
    const d = plan.decisions.find((x) => x.id === publishId("web_app", 8080, "tcp"))!;
    expect(d.options!.map((o) => o.value)).toEqual(["host", "socket", "reuseport", "socket-proxyd", "multipath", "haproxy", "external-lb", "dns-rr"]);
    expect(d.default).toBeNull(); // an ingress-mode port: the mesh is gone, so say what replaces it
    expect(d.options!.find((o) => o.value === "haproxy")!.requires).toEqual({ tools: ["haproxy"] });
    expect(d.options!.find((o) => o.value === "multipath")!.requires).toEqual({ systemd: 245 });
    expect(d.evidence).toContain("services[web_app].endpoint_mode=vip");
  });
});
