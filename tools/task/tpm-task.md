# `tpm-task.js` — task verbs (#1106/#1107/#1109/#1111)

The node-invokable task **verb** tool for `kind:"task"` records (P06). It operates off the canonical
JSON: every mutating verb loads → mutates via the model → `saveTask`, which writes the canonical
`task-<id>.json` **atomically first**, then regenerates the derived body `.md`, the machine
`tasks-index.json`, and the three human index `.md` views. It composes `lib/task-model.js` +
`lib/task-converter.js` + `tpm-task-config.js` — re-implements none of the model/converter/IO.

Format authorities (cross-referenced, not restated here):
[`../task-json-format-spec.md`](../task-json-format-spec.md) (the JSON envelope + editable-vs-mechanical
table) and [`../task-export-spec.md`](../task-export-spec.md) (the human render). Overview + file map:
[`README.md`](README.md). Export/search: [`tpm-task-export.md`](tpm-task-export.md).

**Run:**
```
node tpm-task.js <verb> --tasks-dir <dir> [flags]
```
Programmatic callers `require('./tpm-task')` for `opAdd / opEdit / opImport / opAddSubtask / opCheck /
opTransition / opReindex / opHistory / opList / opShow` (each mutating op returns the persisted record).

## Common flags
| Flag | Meaning |
|------|---------|
| `--tasks-dir <dir>` | the task store (a SCRATCH or real dir). **Required for every store op — never defaults to the live store.** |
| `--config <path>` | `config.json` for the #1109 history gate (default: `<projectRoot>/.claude/claude-tpm/config.json`). |
| `--history on\|off` | override the history gate for this run (wins over config). |
| `--now <iso>` | reference time for `list`/`show` ages (default: now, local offset). |

Bare `tpm-task.js` (no args) prints usage and exits `1`; `--help` prints usage and exits `0`. An unknown
verb or bad flag exits `2`; a runtime failure (missing task, illegal transition, close-guard) exits `1`.

## Verbs
| Verb | Args / flags | Effect |
|------|--------------|--------|
| `list` | `[--state open\|in-progress\|finished\|dropped\|removed\|all\|wip\|active]` | render the human index view for a state set (default `open`+`in-progress`; `wip`=in-progress, `active`/`open+wip`=open+in-progress, `all`=every state). To stdout. |
| `show` | `<id>` | render the derived body `.md` for a task to stdout. |
| `add` | `--headline "…"` (required) `[--label L]… [--labels "a,b"] [--summary …] [--context …] [--body-txt-file <f> --field summary\|context] [--id <id>]` | mint a task; id allocated from the store high-water unless `--id`. #1107: `--body-txt-file` reads a raw file verbatim into summary\|context (field default `summary`). |
| `edit` | `<id> [--headline …] [--label L]… [--labels …] [--summary …] [--context …] [--body-txt-file <f> --field …]` | rewrite ONLY the supplied editable scalars (mechanical fields never touched). |
| `import` | `<id> (--file <f> \| stdin) [--prune]` | #1106 JSON apply: sets ONLY editable fields, IGNORES mechanical (id/state/timestamps/history/endAction); subtasks bulk-replace-by-key, **KEEP-MISSING by default** (OQ1) — a key absent from the incoming set is kept, not dropped; `--prune` opts into dropping missing keys. Accepts a bare editable-fields object OR a full exported record. A `null` `summary`/`context` is accepted (F3-lenient). |
| `import` | `--template` | emit a blank editable-fields JSON skeleton to stdout (safe to fill + re-import). |
| `add-subtask` | `<id> --text "…" [--key K]` | append an OPEN subtask; auto-mints the next spreadsheet key (A, B, …) unless `--key`. |
| `check` | `<id> <key>` (or `--key K`) | flip a subtask to `done` (mechanical). |
| `start` | `<id>` | open → in-progress (stamps `startedAt`). |
| `finish` | `<id> [--action "…"] [--note "…"] [--ref "…"]…` | {open,in-progress} → finished. `--action`/`--note`/`--ref` fill the #1074 `endAction` (`--ref` repeatable). **#1111 close-guard: REFUSED while any subtask is `open`, naming the blockers.** |
| `drop` | `<id> [--reason "…"] [--note "…"] [--ref "…"]…` | {open,in-progress} → dropped (`--reason` aliases `endAction.action`). |
| `remove` | `<id> [--hard]` | Without `--hard`: → removed (soft-stash; recoverable; no `endedAt`). With `--hard`: PURGES the canonical body (+ derived `.md`) and reindexes — UNRECOVERABLE. `--hard` is CONFIG-GATED: it refuses unless `tasks.allowHardDelete` is `true` (default OFF/safe, #1086), naming the key. The reindex preserves the nextId high-water so a purged id is never reissued. |
| `reopen` | `<id>` | {finished,dropped,removed} → open (clears the close). |
| `reindex` | — | rebuild `tasks-index.json` + the three human views from the `*.json` bodies. |
| `history` | `<id> [--json]` | read-only #1109 events (plain lines, or the raw array with `--json`). |

Illegal lifecycle moves are rejected loud (G3); a `redundantFrom` move (already in the target lane) is an
idempotent no-op. Mutating verbs print a one-line confirmation to **stderr**; rendered output (`list`,
`show`, `history`, `import --template`) goes to **stdout**.

## The mutation contract
Every mutation writes `task-<id>.json` atomically FIRST, then regenerates the five derived files. Import
NEVER trusts a mechanical field from the JSON (verified: importing `{"state":"finished","id":"9999"}`
against an open task 1500 left it `state=open id=1500`). State moves ONLY via the lifecycle verbs. A
supplied `null` `summary`/`context` is accepted and stored `null` (F3-lenient — never coerced, never a
crash, never flagged by the doctor).

`endAction` shape (T-Q3): a NON-NULL `endAction` from `finish`/`drop` ALWAYS carries `refs` as an array
(`[]` when none), so a closed task's machine shape is uniform — `{ action?, note?, refs:[] }`. A bare
`finish`/`drop` with nothing supplied leaves `endAction: null`. Verified: `finish 1000 --action shipped
--ref PR#42 --ref "commit abc"` stored `{"action":"shipped","refs":["PR#42","commit abc"]}`; a bare
`finish` stored `null`.

## History gate (#1109)
`--history off` (or a config `tasks.history.enabled: false`) makes every history append a no-op — nothing
is written and `history <id>` reports `(no history events)`. Default is ON. Config-resolution failure
never breaks a store op (it falls back to ON).

## Examples
```
node tpm-task.js add --tasks-dir /tmp/t --headline "Wire the router" --label infra --summary "port it"
node tpm-task.js list --tasks-dir /tmp/t --now 2026-09-20T15:00:00-07:00
node tpm-task.js start --tasks-dir /tmp/t 1000
node tpm-task.js add-subtask --tasks-dir /tmp/t 1000 --text "first sub"
node tpm-task.js check --tasks-dir /tmp/t 1000 A
node tpm-task.js finish --tasks-dir /tmp/t 1000 --action "shipped in PR 42" --ref "PR#42"
node tpm-task.js import --template > patch.json      # fill it in, then:
node tpm-task.js import --tasks-dir /tmp/t 1500 --file patch.json
node tpm-task.js history --tasks-dir /tmp/t 1500 --json
node tpm-task.js reindex --tasks-dir /tmp/t
```

Real close-guard refusal (open subtask `A` blocks `finish`):
```
$ node tpm-task.js finish --tasks-dir /tmp/t 1000
tpm-task: finishTask: refused — 1 open subtask(s) block close (#1111): A. Check or remove them first.
# exit 1
```

Tests: `tests/tpm-task-ops.test.js` + `tests/integration-e2e.test.js` (auto-discovered by
`tests/run-all.js`).
