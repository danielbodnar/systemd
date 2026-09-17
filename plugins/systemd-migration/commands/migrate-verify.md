---
name: migrate-verify
description: Verify rendered units (dry-run) or an installed stack (live) on this host against rendered/expected.json.
---

Verify this host against the plan.

1. Locate `rendered/expected.json` in the migration directory (`${user_config.inventory_dir}` or `.systemd-migration/`).
2. Choose the mode from the arguments: `live` after installation, otherwise dry-run against `rendered/hosts/$(hostname)/etc/systemd/system` (and `etc/containers/systemd` when the host runs Quadlet units). Arguments: $ARGUMENTS. The only value read from them is the word `live`; anything else is ignored, and nothing from them is passed to a shell.
3. Invoke the cutover-verifier agent with the mode, the expected file, and the units directory; the script picks the native or Quadlet engine from the host's entry in `expected.json`. Relay its verdict unchanged, failures first, each with the reproduction command and proposed fix.
4. Do not apply fixes on the host. Offer to change the decision in `plan.yaml` and re-render instead.
