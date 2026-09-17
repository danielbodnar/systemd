---
name: swarm-verify
description: Verify rendered units (dry-run) or an installed stack (live) on this host against rendered/expected.json.
---

Verify this host against the plan.

1. Locate `rendered/expected.json` in the inventory directory (`${user_config.inventory_dir}` or `.swarm-migration/`).
2. Choose the mode from the arguments: `live` after installation, otherwise dry-run against `rendered/hosts/$(hostname)/etc/containers/systemd`. Arguments: $ARGUMENTS
3. Invoke the cutover-verifier agent with the mode, the expected file, and the units directory. Relay its verdict unchanged, failures first, each with the reproduction command and proposed fix.
4. Do not apply fixes on the host. Offer to update the rendered tree and re-render instead.
