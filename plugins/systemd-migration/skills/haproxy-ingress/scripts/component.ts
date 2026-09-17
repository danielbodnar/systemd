// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The HAProxy adapter target: the load balancer a publish decision can pick
// when the networkd component's own mechanisms (multipath routes, socket
// units spread with ReusePort=, systemd-socket-proxyd) do not fit. It renders
// a hardened haproxy.service per host with a configuration built from the
// plan's backends and health checks. HAProxy is not a systemd page, so the
// component claims none and is listed under "adapters" in coverage.json.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";

export const haproxyComponent: Component = {
  id: "haproxy",
  title: "HAProxy (adapter target for published ports)",
  covers: [],
  after: ["service", "machined", "networkd"],

  decide(_ctx: PlanContext): DecisionSpec[] {
    // Filled in by the load balancing work stream (PLAN.md section 10.2).
    return [];
  },

  render(_ctx: RenderContext): void {},
};
