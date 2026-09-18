---
name: systemd-generator
description: The generators and presets component. Stack grouping units (<stack>.target, stack-<stack>.slice) can be files under /etc/systemd/system or emitted at boot by systemd-migration-generator from a declarative description under /etc/systemd-migration/stacks.d/, and a preset file can decide which rendered units are enabled. Use this whenever the user asks about systemd generators, systemd.generator, writing a unit generator, presets, systemd.preset, systemctl preset, how stack targets reach a host, or how to change a stack's membership without re-rendering.
---

# systemd-generator

A Swarm stack is a grouping the orchestrator holds in its own state. On systemd it is two units: `<stack>.target`, which wants every unit of the stack, and `stack-<stack>.slice`, which holds them in one control group. Those two units are the only thing in a rendered tree that is pure bookkeeping: nothing in them comes from a service's definition, they only list what the other components produced. That makes them the natural candidate for `systemd.generator(7)`, which turns a non-native description into units at boot and on every `daemon-reload`.

Enabling is the same kind of question. `systemctl enable` writes symlinks that then live on the host; `systemd.preset(5)` states the policy in a file and `systemctl preset` applies it, so the enable state is reviewable next to everything else the migration rendered.

## Decisions it raises

`generator.stacks.estate`: how the stack targets and slices reach the host.

- `static` (default): both are files under `/etc/systemd/system/`, written by the service and resource-control components and installed by `install.sh`.
- `generator`: `install.sh` writes one `/etc/systemd-migration/stacks.d/<stack>.conf` and installs `systemd-migration-generator` into `/usr/lib/systemd/system-generators/`. The service and resource-control components then skip their target and slice files, and the manager emits them on every boot and every `daemon-reload`. Changing a stack's membership, its slice, or its accounting is an edit to the description and a `daemon-reload`, with no re-render and no new unit file on the host.

`generator.preset.estate`: whether a preset file decides the enable state.

- `no` (default): `install.sh` runs `systemctl enable` over the stack targets.
- `yes`: `/usr/lib/systemd/system-preset/80-systemd-migration.preset` carries one `enable` line per rendered unit that has an `[Install]` section, plus a `disable` line per service the estate defines and runs no replica of. `install.sh` runs `systemctl preset` over exactly those units. It is never `preset-all`, which would re-apply the host's whole policy as a side effect of installing one migration.

The two decisions are independent, except that a generated target has no `[Install]` section (the generator writes the `multi-user.target.wants/` symlink itself from `WantedBy=`), so with `generator` chosen the stack targets appear in neither the preset file nor a `systemctl enable` line.

## The description format

One file per stack under `/etc/systemd-migration/stacks.d/`, ini-like, with a single `[Stack]` section:

```ini
[Stack]
Name=web
Description=stack web
Units=web_app.service
Units=web_proxy.service
Slice=stack-web.slice
Accounting=yes
WantedBy=multi-user.target
```

| Key | Meaning |
|---|---|
| `Name=` | The stack. Required, and the only required key; it names `<Name>.target`. A value that cannot be part of a unit name skips the file. |
| `Description=` | `Description=` of the target, and, with ` slice` appended, of the slice. Default `stack <Name>`. |
| `Units=` | Space-separated unit names, each emitted as one `Wants=` on the target. A repeated assignment appends and an empty one resets, as a list setting does in `systemd.unit(5)`. A word that is not a unit name is left out with a message. |
| `Slice=` | The slice unit to emit. Default `stack-<Name>.slice`; a value that is not a `.slice` unit name falls back to that. |
| `Accounting=` | `yes` puts `MemoryAccounting=yes` and `TasksAccounting=yes` on the slice; `no` (the default) leaves `DefaultMemoryAccounting=` and `DefaultTasksAccounting=` from `systemd-system.conf(5)`. |
| `WantedBy=` | Space-separated targets that get a `<target>.wants/<Name>.target` symlink. Empty means nothing pulls the stack in at boot. |

The generator reads `/etc/systemd-migration/stacks.d`, `/run/systemd-migration/stacks.d`, `/usr/local/lib/systemd-migration/stacks.d`, and `/usr/lib/systemd-migration/stacks.d`, in that order of priority: a file masks the same file name in the directories after it, and an empty file (or a symlink to `/dev/null`) masks the stack entirely. `references/stacks-d.md` has the full grammar, the masking rules, and the diagnostics.

## What it renders

| Decision | Files | Install steps |
|---|---|---|
| `generator.stacks.estate=generator` | `etc/systemd-migration/stacks.d/<stack>.conf` per stack on the host; `usr/lib/systemd/system-generators/systemd-migration-generator` (mode 0755) | `install -D -m 0755` for the generator before the engine's `systemctl daemon-reload`, then a `systemctl cat` check that the targets appeared |
| `generator.preset.estate=yes` | `usr/lib/systemd/system-preset/80-systemd-migration.preset` | `install -D -m 0644` for the preset file, then `systemctl preset` over the rendered units |
| `generator.preset.estate=no` | none | `systemctl enable <stack>.target` per stack, unless the targets are generated |

`expected.json` lists the stack targets and slices either way, so the live verifier checks them on the host whichever decision was taken.

## Running the generator by hand

```
dir=$(mktemp -d)
SYSTEMD_LOG_LEVEL=debug /usr/lib/systemd/system-generators/systemd-migration-generator "$dir" "$dir" "$dir"
find "$dir"
systemd-analyze verify "$dir"/*.target "$dir"/*.slice
```

`$SYSTEMD_MIGRATION_STACKS_DIRS`, a colon-separated list, replaces the four directories above, which is how the tests and the integration subtest point it at a temporary tree.

## Limits worth knowing

- A dry-run verifier cannot see generated units. `systemd-analyze verify` over a rendered tree finds no `<stack>.target` because the target does not exist until the manager reloads. The rendered notes say so, and `skills/systemd-verify` should learn to run the generator into a temporary directory before reporting a target missing.
- Generator output lives only until the next reload. It is not configuration for other programs, and nothing else should be written from a generator, as `systemd.generator(7)` says.
- Everything the generator writes is in `argv[1]`, the normal generator directory. That keeps a native unit of the same name under `/etc/systemd/system/` winning, which is the overriding rule `systemd.generator(7)` recommends as the default choice.
- A generator must not fail the boot. This one logs every problem to stderr, which the manager records in the journal, skips the description it cannot use, and always exits 0 once it has an output directory.

## Files

- `scripts/component.ts`: the component module.
- `scripts/systemd-migration-generator`: the generator, POSIX `sh`, installed to `/usr/lib/systemd/system-generators/`.
- `references/stacks-d.md`: the description format in full, with the masking rules and every diagnostic.
