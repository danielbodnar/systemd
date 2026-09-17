// SPDX-License-Identifier: LGPL-2.1-or-later
//
// The components the drivers compose, in registry order; compose.ts sorts
// them by their `after` dependencies. Adding a systemd component means
// adding a skill under skills/systemd-<name>/ with scripts/component.ts and
// listing it here; the coverage test checks that every man page the
// catalogue knows is claimed by exactly one component or listed as not
// applicable.

import type { Component } from "./component.ts";
import { machinedComponent } from "../skills/systemd-machined/scripts/component.ts";
import { serviceComponent } from "../skills/systemd-service/scripts/component.ts";
import { credsComponent } from "../skills/systemd-creds/scripts/component.ts";
import { resourceControlComponent } from "../skills/systemd-resource-control/scripts/component.ts";
import { storageComponent } from "../skills/systemd-storage/scripts/component.ts";
import { networkdComponent } from "../skills/systemd-networkd/scripts/component.ts";
import { resolvedComponent } from "../skills/systemd-resolved/scripts/component.ts";
import { journaldComponent } from "../skills/systemd-journald/scripts/component.ts";
import { sysextComponent } from "../skills/systemd-sysext/scripts/component.ts";
import { portableComponent } from "../skills/systemd-portable/scripts/component.ts";

export const COMPONENTS: Component[] = [
  machinedComponent,
  serviceComponent,
  credsComponent,
  resourceControlComponent,
  storageComponent,
  networkdComponent,
  resolvedComponent,
  journaldComponent,
  sysextComponent,
  portableComponent,
];

export function componentById(id: string): Component | undefined {
  return COMPONENTS.find((c) => c.id === id);
}
