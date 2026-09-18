---
name: systemd-resource-control
description: The resource-control component. A stack becomes a slice and a service's limits and reservations become control group properties on its unit (CPUQuota=, CPUWeight=, MemoryMax=, MemoryLow=, TasksMax=), with accounting on the slice. Use this whenever the user asks how container CPU and memory limits map onto systemd, about slices, cgroup v2 properties, systemd.resource-control, oomd, or how to see per-stack resource usage.
---

# systemd-resource-control

Docker's `resources.limits` and `resources.reservations` are cgroup settings applied by the runtime; systemd applies the same settings from `systemd.resource-control(5)` directives on the unit, and groups units into slices so a whole stack can be bounded and observed together.

## Decisions it raises

`resource-control.accounting.estate`: whether every `stack-<name>.slice` turns on `MemoryAccounting=` and `TasksAccounting=` (default yes) or leaves the manager's defaults.

## What it renders

| Inventory field | Directive |
|---|---|
| `stack` | `Slice=stack-<stack>.slice` on each unit; `stack-<stack>.slice` with accounting |
| `resources.limits.nano_cpus` | `CPUQuota=<percent>%` |
| `resources.reservations.nano_cpus` | `CPUWeight=` scaled from the reservation |
| `resources.limits.memory_bytes` | `MemoryMax=` |
| `resources.reservations.memory_bytes` | `MemoryLow=` |
| `resources.limits.pids` | `TasksMax=` |

Reservations are soft in both systems: `MemoryLow=` protects the service under pressure rather than pre-allocating. A stack-wide bound is a hand edit on the slice (`MemoryMax=` on `stack-<stack>.slice`), which the planner lists when the source had a per-stack limit in its compose file.

## Files

- `scripts/component.ts`: the component module.
