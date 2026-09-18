# The contract

Every skill in the `systemd-migration` plugin reads or writes the same inventory, plans against the same directive catalogue, and renders through the same component interface. The files here define all three.

- `inventory-schema.json`: what an adapter produces, JSON Schema 2020-12. A normalized description of a container estate (nodes, stacks, services, tasks, networks, volumes, secrets, configs, image configuration). `discover-docker-swarm` writes it today; `discover-podman` will write the same shape.
- `types.ts`: TypeScript types mirroring the schema, plus the duration helpers the scripts share.
- `schema.ts`: a dependency-free validator for the subset of JSON Schema the contract uses.
- `directives.json`: the directive catalogue, generated from this tree's `man/` pages by `skills/migration-planner/scripts/build-catalog.ts`. For every unit type, file format, and tool it lists the documented directives, line types, options, and verbs with the version each was added in. The catalogue is the plugin's definition of "what systemd ships": a component may only render a directive the catalogue documents.
- `catalog.ts`: the lookup over the catalogue, plus `checkUnitText()`, which parses a unit-style file and reports every undocumented directive and the minimum systemd version the file needs.
- `unit.ts`: the unit-file builder and the value conversions (quoting, path escaping, sizes, quotas, image names) every component uses.
- `placement.ts`: constraint evaluation and host placement, shared by every renderer.
- `component.ts`: the component interface. A systemd component (networkd, machined, creds, ...) is a module that declares what it needs from the hosts, which decisions it needs from the plan, and how it contributes files and unit directives to a host's tree. The render driver composes the registered components at run time according to the plan.
- `plan.ts` and `plan-schema.json`: `plan.yaml`, the planner's output and the user's approval surface: host capabilities, decisions with their options and chosen values, variables (address plans, names), and where each secret lives.
- `registry.ts`: the list of component modules the drivers compose.

There is one copy of these files. Skills are direct children of `skills/` and import the contract by relative path; the harness imports it the same way, so a change here is a change everywhere.
