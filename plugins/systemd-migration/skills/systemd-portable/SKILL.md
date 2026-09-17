---
name: systemd-portable
description: The portable services and capsules component. A service the plan marks as portable is attached from an image under /var/lib/portables with portablectl and a security profile; a stack the plan marks as a capsule runs under its own per-stack manager started by capsule@.service. Use this whenever the user asks about portable services, portablectl, attach and detach, portable profiles, capsules, capsule@.service, or running a stack under its own service manager without a full machine.
---

# systemd-portable

A portable service is an image that carries its own units and `os-release`; `portablectl attach` copies the units onto the host with a profile that sandboxes them, and `detach` removes them again, which makes one artifact installable on many hosts. A capsule is a user manager for a purpose rather than a person: `capsule@<name>.service` starts it, and the units under `/var/lib/capsules/<name>/.config/systemd/user/` run as that manager's user units.

## Decisions it raises

- The engine's `form.service.<service>` offers `portable` as a form when `portablectl` is on the hosts; this component renders that form.
- `portable.capsule.<stack>`: `system` (default) or `capsule`.

## What it renders

- For a portable form: the `portablectl attach --now --profile=default` step in `install.sh`, and a decision note: the pulled OCI image has no units and no `os-release`, so the portable image has to be built from the rendered unit and the mount stack first (`systemd-repart` over the merged tree, as `make-ddi.sh` does, plus the unit and release file).
- For a capsule: a decision note with the move of the stack's units into the capsule's user directory and the start of `capsule@<stack>.service`.

## Files

- `scripts/component.ts`: the component module.
