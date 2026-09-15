# `/tpm-task` skill smoke checklist (G26)

A repeatable, example-based script the orchestrator runs to exercise the SKILL's judgment (routing,
selector interpretation, the confirm-before-destructive dialogue, the import collaboration flow) — the
way `/tpm-spawn` was exercised. This is NOT a unit-test suite (that's `${TPM_HOME}/tools/task/tests/`); it's a set
of cases with expected resolutions a human reads and confirms.

> **Phase note (G11):** while staged, run the tool as `node out/tools/task/tpm-task.js --tasks-dir <sandbox>`
> and read the skill files from `out/skills/tpm-task/`. Post-promotion the paths are `${TPM_HOME}/tools/task/tpm-task.js`
> and `.claude/skills/tpm-task/`. Use a throwaway sandbox store, never `claude-context/tasks/`.

## Routing / alias interpretation

| Input | Expected router resolution |
|---|---|
| `/tpm-task` (bare) | run `list` (no mode table) |
| `/tpm-task todos` | `list` |
| `/tpm-task remember to bump the version` | `add`, headline drafted from the phrase |
| `/tpm-task wip 1245` | `start 1245` |
| `/tpm-task done 1245 shipped it` | `finish 1245 --action "shipped it"` (echo id+headline, confirm) |
| `/tpm-task wontfix 1245 obsolete` | `drop 1245 --reason "obsolete"` |
| `/tpm-task nuke 1245` | ambiguous/unknown → show the mode table, do NOT guess a destructive mode |
| `/tpm-task open 1245` | collision rule: target present → `show 1245` |
| `/tpm-task open` | collision rule: no target → `list` |
| `/tpm-task mark 1245.A` | subtask sub-id + done-ish verb → `check 1245.A`, not `finish` |

Each should print `Reading "<arg>" as → mode: <mode>` before acting on any state change.

## Selector interpretation

| Input | Expected lowering |
|---|---|
| `show 214-218` | deterministic range → `show 214-218` |
| `export 12345-898` | descending range → the tool errors; relay it, don't "fix" it |
| `finish the auth ones` | semantic → read `list`, pick ids, ECHO the resolved id set, confirm, then `finish <ids>` |
| `export finished last week` | lower to `resolve --state finished --since 7d`, then `export <ids>` (G6) |

## Confirm-before-destructive dialogue

1. `/tpm-task remove 1245` → replies "stashed to removed, recoverable via reopen" and calls
   `remove 1245` (soft). Body survives.
2. `/tpm-task delete 1245 permanently, no stash` → warns *"permanently deletes #1245 with NO stash,
   unrecoverable — confirm?"*, and only on an explicit yes calls `remove 1245 --hard`.
3. With `allowHardDelete: false` in config → the tool refuses `--hard`; the skill relays the refusal.
4. `finish`/`drop` with `autoConfirm` true for that mode → skip the confirm dialogue; still echo the id.

## Import collaboration flow

1. Point `/tpm-task import <file>` at a free-form braindump → skill offers **piecemeal vs best-effort**.
2. Piecemeal presents candidates as ephemeral `1, 2, 3` handles (NOT real ids), each with a proposed
   headline / summary / inferred created date / epic detection; walks keep/edit/skip.
3. On confirm, writes ONE `import --from <payload>` (contiguous ids, single index update); warns on
   likely duplicates; leaves the source file untouched.

## Config gate

`tasks.enabled: false` → the skill replies one line ("task ledger disabled by config") and stops; no
tool call is made.
