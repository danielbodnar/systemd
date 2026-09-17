<!-- SPDX-License-Identifier: LGPL-2.1-or-later -->

# `/etc/systemd-migration/stacks.d/` and `systemd-migration-generator`

The stack description is the only file this plugin asks an operator to edit after a migration is installed. It exists so a stack's membership, its slice, and its accounting are a configuration file rather than a rendered unit: `systemd-migration-generator` reads the descriptions on every boot and every `systemctl daemon-reload` and emits `<stack>.target`, `stack-<stack>.slice`, and the `.wants/` symlinks into the generator directory. Nothing it writes survives the next reload, which is what `systemd.generator(7)` requires of a generator's output.

## Where descriptions are read from

Highest priority first:

| Directory | For |
|---|---|
| `/etc/systemd-migration/stacks.d/` | What `install.sh` writes, and what an operator edits |
| `/run/systemd-migration/stacks.d/` | A description staged for this boot only (the integration test uses it) |
| `/usr/local/lib/systemd-migration/stacks.d/` | A local package |
| `/usr/lib/systemd-migration/stacks.d/` | A vendor package |

A file masks the same file name in the directories after it, so `/etc/systemd-migration/stacks.d/web.conf` replaces a `web.conf` in `/usr/lib/`. An empty file, or a symlink to `/dev/null`, masks the stack entirely: nothing is emitted for that file name at all. Only names ending in `.conf` are read, and a name containing anything other than letters, digits, `:`, `_`, `.`, `@`, and `-` is skipped with a message.

`$SYSTEMD_MIGRATION_STACKS_DIRS`, a colon-separated list, replaces the whole set. It exists for tests and for running the generator by hand against a scratch tree; the service manager never sets it.

## The file

Ini-like, one `[Stack]` section, one stack:

```ini
# Rendered by systemd-migration for swarm-wrk-1.
[Stack]
Name=web
Description=stack web
Units=web_app.service
Units=web_proxy.service
Units=web_app-health.timer
Slice=stack-web.slice
Accounting=yes
WantedBy=multi-user.target
```

Empty lines and lines whose first non-blank character is `#` or `;` are ignored. Blanks around a key and around a value are stripped, so `Name = web` and `Name=web` are the same. A section other than `[Stack]` is reported and its assignments are ignored, which leaves room for a later section without breaking an older generator.

### Keys

**`Name=`** — the stack. Required. It is embedded in two unit names (`<Name>.target` and, by default, `stack-<Name>.slice`), so it must be usable as part of a unit name: letters, digits, `:`, `_`, `.`, `-`, and `\` escapes, at most 200 characters, and no `@`, since the stack is never a template instance. A file whose `Name=` is missing or unusable is skipped.

**`Description=`** — `Description=` of the target. The slice gets the same text with ` slice` appended. Default `stack <Name>`, which is what the statically rendered units carry, so the two paths produce the same description.

**`Units=`** — a space-separated list of unit names. Each becomes one `Wants=` line on the target. This is a list setting in the sense of `systemd.unit(5)`: a repeated `Units=` appends to what came before, and `Units=` with an empty value resets the list, so a drop-in style edit can start over. A word that is not a unit name (no type suffix, a trailing dot, a character outside the unit-name set, longer than 255) is left out with a message and the rest of the list still lands.

**`Slice=`** — the slice unit to emit. Default `stack-<Name>.slice`. A value that does not end in `.slice`, or that is not a unit name, falls back to the default with a message. The generator does not check that the services actually reference this slice: the rendered units carry `Slice=` themselves, and an operator changing this key is expected to change theirs.

**`Accounting=`** — `yes`, `true`, `1`, or `on` puts `MemoryAccounting=yes` and `TasksAccounting=yes` in the slice's `[Slice]` section. `no`, `false`, `0`, `off`, or an absent key leaves the manager's `DefaultMemoryAccounting=` and `DefaultTasksAccounting=` from `systemd-system.conf(5)`. Anything else is reported and treated as `no`.

**`WantedBy=`** — a space-separated list of targets that should pull the stack in. For each, the generator creates `<target>.wants/<Name>.target` in its own output directory. It is a list setting like `Units=`. An empty value means nothing pulls the stack in at boot, which is how a stack is staged without starting it. A value that is not a `.target` unit name is left out with a message.

The emitted target carries no `[Install]` section: the `.wants/` symlink is the enablement, and it is rewritten on every reload. That is why `systemctl enable <stack>.target` and a `systemd.preset(5)` line both refuse a generated target, and why the component leaves them out of the preset file.

## What is emitted

For the description above, into `argv[1]`:

```
web.target
stack-web.slice
multi-user.target.wants/web.target -> ../web.target
```

```ini
# Automatically generated by systemd-migration-generator from /etc/systemd-migration/stacks.d/web.conf
# Edit that file and run "systemctl daemon-reload"; this unit is replaced on every reload.

[Unit]
Description=stack web
SourcePath=/etc/systemd-migration/stacks.d/web.conf
Wants=web_app.service
Wants=web_proxy.service
Wants=web_app-health.timer
```

`SourcePath=` is the description, as `systemd.generator(7)` asks, so `systemd-delta` and `systemctl cat` point an operator at the file to edit and the manager can warn when it changed on disk.

`argv[1]` is the normal generator directory, which loses to `/etc/systemd/system/` and wins over `/usr/lib/systemd/system/`. That is the default `systemd.generator(7)` recommends: a native unit an administrator wrote for the same name still overrides what was generated. The early and late directories stay empty. Called with one argument, the generator puts everything there, which is the test invocation the man page describes.

## Diagnostics

Every problem goes to stderr, prefixed with the generator's name and, where a line is to blame, with `<file>:<line>:`. The manager records stderr in the journal, so `journalctl -b -u init.scope` (or `systemd-analyze log-level debug` before a reload) shows them. Nothing here is fatal: the generator skips the description it cannot use, carries on with the rest, and exits 0. The only non-zero exit is being called with no output directory at all, which the service manager never does.

| Message | Effect |
|---|---|
| `not a key=value line; skipping the file` | The whole file is skipped |
| `malformed section header; skipping the file` | The whole file is skipped |
| `assignment before any section; skipping the file` | The whole file is skipped |
| `Name= is missing or is not usable as a unit name` | The whole file is skipped |
| `<name>.target was already generated from another description` | The second description of a stack is skipped; the first wins |
| `section [X] is not known and is ignored` | Its assignments are ignored |
| `key X= is not known and is ignored` | That line is ignored |
| `"X" in Units= is not a unit name and is left out` | That unit is left out; the rest land |
| `WantedBy=X is not a target and is left out` | No symlink for that one |
| `Slice=X does not end in .slice` | `stack-<Name>.slice` is used |
| `Accounting=X is not a boolean` | The manager's default is left |
| `file name is not plain; skipping it` | That file is not read |
| `stopped early with status N` | Something unexpected went wrong; the exit status is still 0 |

## Checking a change before reloading

```
dir=$(mktemp -d)
/usr/lib/systemd/system-generators/systemd-migration-generator "$dir" "$dir" "$dir"
find "$dir"
systemd-analyze verify "$dir"/*.target "$dir"/*.slice
rm -rf "$dir"
```

Then `systemctl daemon-reload` and `systemctl show -p Wants <stack>.target` to see what the manager loaded. `test/units/TEST-95-CONTAINER-MIGRATION.generator.sh` does exactly this against the committed fixture.

## Why a generator and not a rendered unit

Both are supported, and `generator.stacks.estate` is the choice. The generator is worth it when the estate expects membership to change between renders: adding a unit to a stack is a line in a `.conf` and a reload, with no rendered tree to reconcile and no stale grouping unit left behind under `/etc/systemd/system/` when a service leaves the stack. The rendered files are worth it when the host should carry nothing but unit files, when the tree is the audit record, or when `systemd-analyze verify` over the rendered tree is expected to see every unit the estate has, which it cannot do for generated ones.
