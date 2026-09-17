# The inventory contract

Every skill in the `systemd-dev-plugins` marketplace reads or writes the same inventory: a normalized description of a container estate (nodes, stacks, services, tasks, networks, volumes, secrets, configs) that `docker-swarm-to-inventory` produces and every rendering, planning, and verification skill consumes. The three files here define it.

- `inventory-schema.json`: the contract itself, JSON Schema 2020-12. Read it for a field's exact name, type, and meaning.
- `types.ts`: TypeScript types that mirror the schema, plus the duration helpers the scripts share. Bun scripts import from here rather than from a schema library.
- `schema.ts`: a dependency-free validator for the subset of JSON Schema the contract uses, so any script can check an inventory before trusting it.

This directory is the source. Other plugins carry a byte-for-byte copy under their own `contract/` directory because Claude Code installs each plugin into a separate cache and one plugin cannot read another's files. A `CHECKSUMS` file marks a vendored copy; `plugins/scripts/sync-contract.sh` refreshes every copy from this directory and `bun test` in the harness fails when a copy has drifted. Change the contract here, run the script, and commit the copies together.
