# `tpm config` — layered config reader/writer

The `config` suite is the user- and skill-facing porcelain over claude-tpm's layered config. It reads the
**resolved** config across all sections and writes a single value into a chosen layer, without hand-editing
JSON. It calls the same in-process overlay lib (`tools/lib/tpm-config-overlay.js`) the per-suite resolvers
call — the CLI is the porcelain, the function call is the plumbing.

Run: `tpm config <get|set|list> [...]`.

## The three layers (lowest → highest precedence)

1. **Shipped defaults** — `tools/config/defaults.json` (inside the bundle). Every section's built-ins.
2. **Project config** — `<project>/.claude/claude-tpm/config.json`. What a project checks in.
3. **User config** — the file named by `$CLAUDE_TPM_USER_CONFIG` (machine-local, per operator). Unset, or a
   missing file, is skipped; a present-but-invalid file warns to stderr and is ignored (never fatal).

A later layer wins per value. Plain objects deep-merge key-by-key; scalars, objects, and arrays REPLACE
(arrays concat+dedup only for the explicit additive allowlist, which is empty today). Per-value flag/env
precedence (`--sessions-dir`, `TPM_TASKS_DIR`, …) still wins on top of all three, in the suite resolvers.

## Verbs

### `config get <path> [--layer defaults|project|user] [--config <file>]`
Print one value as JSON. Without `--layer`, the **overlaid** value (all three layers). With `--layer`, that
single layer's value at `<path>`. `<path>` is dotted and may index arrays with `name[i]`:

```
tpm config get session.notes.sessionsDir
tpm config get workflow.verifyLoopCap --layer defaults
tpm config get workflow.subagentConfigs[1].name        # -> "builder"
```

Note: `config get workflow.subagentConfigs[i].charterFile` reports the stored **bundle-relative** path (the
generic overlay does not apply the workflow resolver's absolutize transform). The absolute path a workflow
consumer actually sees comes from `tpm workflow config --get subagentConfigs.1.charterFile` (or `--json`).

### `config set <path> <value> [--user | --default] [--config <file>]`
Write `<value>` into one layer's **raw** file (comments and sibling sections round-trip), creating the file
if absent. `<value>` is JSON-coerced: `true`/`false`/numbers/JSON literals parse; anything else stays a
string. `<path>` supports `name[i]` (set element i) and `name[+]` (append).

- no flag → the **project** `config.json`.
- `--user` → `$CLAUDE_TPM_USER_CONFIG` (errors if the env var is unset).
- `--default` → the shipped `tools/config/defaults.json`. **⚠ This edits the install-global shipped file and
  can clobber shipped defaults for every project using this bundle — use it deliberately.**

```
tpm config set tasks.maxOpenWarn 100
tpm config set tasks.defaultListState[+] done --user
tpm config set tasks.allowHardDelete true
```

### `config list [--config <file>]`
Print the whole resolved config (all sections, comment keys stripped) as JSON.

## Project root

Resolved like every tpm tool: `$TPM_PROJECT_ROOT`, else walk up from the current folder for the
`.claude/claude-tpm/` marker. `--config <file>` names the project `config.json` explicitly.

## See also

- `docs/config-guide.md` — the per-section reference (what each key does).
- `tools/lib/tpm-config-overlay.js` — the overlay lib this suite and the resolvers share.
