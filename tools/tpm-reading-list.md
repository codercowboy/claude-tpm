# `tpm reading-list` — emit a role's methodology reading chain

Print the ordered reading chain for an actor **in anchor form**: a leading `npx tpm resolve-home` line
(its printed path IS the bundle root) followed by one `npx tpm doc <bundle-relpath>` line per entry.
The reader runs the block top to bottom and every doc resolves — no manual `../`-link walking.

The chain is derived from the live reading-list manifests, so it never drifts from the source of truth:

- `orchestrator` → `claude-context/methodology/orchestrator/reading-list.md` (the Tier-1 boot core).
- `subagent` → `claude-context/methodology/subagent/reading-list.md` (the base every-round list).

## Usage

```
npx tpm reading-list <role>      # role: orchestrator | subagent
npx tpm reading-list --help
```

Exit codes: `0` printed · `1` manifest unreadable under the bundle · `2` usage / unknown role
(prints the known roles).

## How it works

It self-locates the bundle (the shared `bundleRoot()` primitive — no env var, no hook, every
permission mode), reads the role's manifest out of the bundle, parses the machine markers, translates
each entry's manifest-relative markdown link to a bundle-root-relative path, and emits the anchor-form
block.

Marker spellings accepted (both, so the emitted chain and the enforced chain cannot drift):

- `<!-- reading-list:begin <id> -->` … `<!-- reading-list:end -->` (orchestrator manifest).
- `<!-- lint:begin <id> -->` … `<!-- lint:end -->` (subagent manifest — the same block the
  subagent-prompt lint parses).

## Example

```
$ npx tpm reading-list orchestrator
# Reading list — orchestrator (3 docs, in order).
# Run the anchor first (its printed path IS the bundle root); then read each doc under it:
npx tpm resolve-home
npx tpm doc claude-context/methodology/project-workspace.md
npx tpm doc claude-context/methodology/orchestrator/handbook.md
npx tpm doc claude-context/methodology/shared-conventions.md
```

## Tests

The dedicated suite lives at `tests/tpm-reading-list.test.js` (marker parsing in both spellings,
`../`→bundle-relpath resolution, both roles end-to-end, exit codes) and is wired into
`tools/tests/run-all.js` (run everything with `node tools/tests/run-all.js`).
