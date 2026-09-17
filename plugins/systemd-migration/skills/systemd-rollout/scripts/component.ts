// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The rollout component: what docker service update, docker stack deploy,
// rollback, and node drain become on a systemd host. It renders a rollout
// specification per stack from the source's update_config and
// rollback_config and a POSIX sh controller per host that drives systemctl,
// the versioned image directories (systemd.v), and the health units through
// a rolling update with the source's parallelism, delay, order, failure
// action, and monitor window.

import type { Component, DecisionSpec, PlanContext, RenderContext } from "../../../contract/component.ts";

export const rolloutComponent: Component = {
  id: "rollout",
  title: "Rollouts, rollback, and drain (systemctl, systemd-run, systemd.v)",
  covers: ["systemctl", "systemd-run", "systemd-run-generator", "systemd.offline-updates"],
  after: ["service", "machined"],

  decide(_ctx: PlanContext): DecisionSpec[] {
    // Filled in by the rollout work stream (PLAN.md section 10.4).
    return [];
  },

  render(_ctx: RenderContext): void {},
};
