// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The networkd component for machines: every address, transport, and name
// comes from a decision in the plan, the zone bridge and its leases follow
// the decided range, each transport renders its own netdevs, and every
// rendered .network and .netdev passes the directive catalogue.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkUnitText } from "../../contract/catalog.ts";
import { composePlan, composeRender, formId, placementId } from "../../contract/compose.ts";
import { type Plan, resolveDecision } from "../../contract/plan.ts";
import { COMPONENTS } from "../../contract/registry.ts";
import type { Inventory } from "../../contract/types.ts";
import { normalize } from "../../skills/discover-docker-swarm/scripts/normalize.ts";
import { WIREGUARD_PORT, machineMac, parentId, subnetId, transportId, uplinkId, vniId, wireguardEndpointId, wireguardSubnetId, zoneId } from "../../skills/systemd-networkd/scripts/component.ts";
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
    expect(netdev).toContain("Name=mv-data_monitoring");
    expect(section(netdev, "MACVLAN")).toEqual([["Mode=bridge"]]);
    const parent = r.files[`${WRK}/${NET}/25-migration-parent-data_monitoring.network`] as string;
    expect(section(parent, "Match")).toEqual([["Name=eth1"]]);
    expect(parent).toContain("MACVLAN=mv-data_monitoring");
    expect(r.files[`${WRK}/${NET}/25-migration-mv-data_monitoring.network`]).toContain("Address=192.168.50.129/25");
    expect(r.files[`${WRK}/etc/systemd/nspawn/data_exporter.nspawn`]).toContain("MACVLAN=eth1");
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
