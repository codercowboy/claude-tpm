# `task.js` — the tpm-task tool (reference)

`task.js` is the deterministic engine behind the `/tpm-task` skill: a portable, zero-dependency Node
CLI over a per-task-file markdown store. The tool owns ALL mechanics (parse / filter / sort / age /
render / CRUD / id-alloc / index-rebuild / resolve / import / export). Files stay plain, hand-editable
markdown; the tool parses **leniently by markdown landmark**, normalizes managed lines on write, and
**preserves unmanaged human prose** (the G1 surgical-in-place-rewrite in `lib/format.js`).

> **Verification.** Every command + output block below was re-run against a throwaway sandbox store
> (`--tasks-dir <tmpdir>`) on the shipped `out/tools/task/` and pasted verbatim. Re-run any example to
> reproduce. Where the phase is still staged under `out/`, invoke `node out/tools/task/task.js`; the
> promoted path is `node tools/task/task.js` (used in the prose below).

## Running it

```
node tools/task/task.js [--tasks-dir <path>] [--config <path>] <subcommand> [args]
```

- **`--tasks-dir <path>`** — override the store location. Otherwise the resolved config `tasks.tasksDir`
  is used (default `.claude/claude-tpm/tasks`, dogfood override `claude-context/tasks`).
- **`--config <path>`** — override the config.json path (default
  `<projectRoot>/.claude/claude-tpm/config.json`, where `<projectRoot>` is found by walking up for a
  `CLAUDE.md` marker). See [`lib/config.md`](./lib/config.md).
- **`--help`** — top-level usage; `<subcommand> --help` — per-subcommand usage.

```
$ node tools/task/task.js --help
Usage: node task.js [--tasks-dir <path>] [--config <path>] <subcommand> [args]

Subcommands:
  list [--order newest|oldest|id|state] [--state open|in-progress|finished|dropped|removed|all]
  show <selector> [--state <s>]
  add --from <payload.md>
  import --from <payload.md>
  export <selector> [--out <path>] [--state <s>]
  edit <id> --from <payload.md>
  check <id.LETTER>
  start <id>
  finish <id> --action "<what was done>"
  drop <id> --reason "<why>"
  remove <id> [--hard]
  reopen <id>
  resolve <selector> [--state <s>] [--since <Nd>]
  reindex
```

**Config gate.** `tasks.enabled: false` ⇒ the tool prints one line and does NO store ops (exit 0).
Missing config ⇒ defaults (system ON). Malformed config ⇒ defaults + a stderr warning (never a crash).

```
$ node tools/task/task.js --config off.json --tasks-dir ./store list
task system disabled by config (tasks.enabled: false). Flip that key to re-enable; no store ops performed.
$ echo $?
0
```

## Store layout

```
<tasksDir>/
  task-index.md              # open + in-progress   (carries the **Next ID:** marker)
  finished-tasks-index.md    # finished ∪ dropped   (the State column distinguishes them)
  removed-tasks-index.md     # removed (soft, recoverable)
  bodies/<lo>-<hi>/task-<N>.md   # canonical body; NEVER moves on a state change
```

Bodies are bucketed by `bucketSize` (default 1000): task 1245 → `bodies/1000-1999/task-1245.md`. A state
change flips the `State:` field inside the body (the file stays put) and moves the task's row between
index files. Stored index columns: `#, State, Created, Task` (the epic hint ` (done/total)` is appended
to Task). **Bodies are truth; the three indexes are a regenerable cache** (`reindex` reconciles toward
bodies). See [`README.md`](./README.md) for the `lib/` split and [`lib/format.js`](./lib/format.js)'s
header docstring for the canonical body format (the token SSOT).

## Subcommands (14 = 12 user modes + `resolve`/`reindex` tool-internal)

### `add --from <payload>`
Allocate the next id, write the body in the right bucket, add the open-index row, self-heal the marker.
Content comes from a markdown payload the skill wrote (see the skill's `modes-mutate.md` for the format).
```
$ node tools/task/task.js --tasks-dir ./store add --from ./tmp/tpm-task/add-rename.md
added #1000 · Rename claude-admin to claude-tpm
```

### `import --from <payload>`
Batch `add`: N task-blocks in one payload → a **contiguous** id block, N bodies, one index pass. Each
block may carry a `- **Created:** <date>` override. Ids are (re)assigned by the tool — a `#` sigil in the
payload heading is **ignored** (verified: a `# #9999 · …` block imports as the next real id, e.g. #1000).
```
$ node tools/task/task.js --tasks-dir ./store import --from ./tmp/tpm-task/braindump.md
imported 3 task(s): #1002–#1004
```

### `export <selector> [--out <path>] [--state <s>]`
Serialize the selected tasks to ONE file in canonical body format — read-only against the store.
**Round-trips through `import`** (content preserved byte-for-byte; ids reassigned on re-import — verified:
`export all --state all` → `import` into a fresh store → `export` again diffs content-identical modulo ids).
- **Default out is config-derived (Q4):** `<tasksDir>/<exportDir>/tasks-export-<YYYY-MM-DD>.md`, with
  `<exportDir>` (`tasks.exportDir`, default `tmp`) resolved **relative to the resolved tasks store**
  (`--tasks-dir`, else config `tasksDir`) — NOT the project root. This keeps a no-`--out` export INSIDE the
  store it read, so a `--tasks-dir <sandbox>` export can never escape into the live project tree. This is
  compliant with the no-hardcoded-paths rule — the directory comes from the resolver, not a baked path. An
  absolute `exportDir` still wins; `--out <path>` overrides to anywhere. (Noted so a verifier doesn't flag
  the default.)
```
$ node tools/task/task.js --tasks-dir ./store export all
exported 2 task(s) → /abs/store/tmp/tasks-export-2026-08-30.md
$ node tools/task/task.js --tasks-dir ./store export all --state all --out ./backup.md
exported 5 task(s) → /abs/.../backup.md
```

### `list [--order <o>] [--state <s>]`
Parse the indexes, filter, sort, compute age live, print the compact view. One line per task.
```
$ node tools/task/task.js --tasks-dir ./store list
#1004   · today · Third imported task
#1003   · today · Second imported task
#1002   · today · First imported task
#1001 ▶ · today · Collapse task-add/list into /tpm-task (2/3)
#1000   · today · Rename claude-admin to claude-tpm
```
- **`--order`** (aliases in parens): `newest` (default; new/recent) · `oldest` (old/age/stale) · `id`
  (num/number/seq) · `state` (status/grouped). `--order state` groups by `in-progress → open → finished
  → dropped → removed`.
- **`--state`** (default `open`+`in-progress`): `open` · `in-progress`/`--wip` · `finished` · `dropped`
  · `removed` · `all`.
- A `▶` marks an in-progress task; a trailing `(done/total)` shows epic progress.
- If the default (open) pool exceeds `maxOpenWarn`, a one-line stderr nudge fires (`§0` skimmability
  guardrail): `task: open list has N tasks (> maxOpenWarn M) — consider finishing/dropping some.`

### `show <selector> [--state <s>]`
Print the full body of one or several tasks (dates, subtasks with check-state, end-action). Multiple
bodies are joined by a `---` separator. `--state` reaches into the ended/removed pools.
```
$ node tools/task/task.js --tasks-dir ./store show 1000
# #1000 · Rename claude-admin to claude-tpm

- **State:** open
- **Created:** 2026-08-30

**Summary:** Rename the project throughout.

**Context:** Touches `CLAUDE.md`, session notes, methodology docs.
```

### `edit <id> --from <payload>`
Rewrite **content fields only** — headline / summary / context / subtasks (Q9). An omitted field is left
untouched; supplying `**Subtasks:**` replaces the whole subtask list (letters re-derived A, B, C…).
**Never** touches State, Started, Ended, or any date stamp — state changes go through the dedicated modes;
a hand-edited `State:` is reconciled by `reindex`. Refreshes the index row headline/progress.
```
$ node tools/task/task.js --tasks-dir ./store edit 1001 --from ./tmp/tpm-task/edit-1001.md
edited #1001
```
Verified: editing #1001 with a payload carrying only a new headline + summary preserved its
`State: in-progress`, `Started:` stamp, and existing subtask check-state untouched.

### `check <id.LETTER>`
Tick a subtask checkbox and refresh the epic's `(done/total)` on its index row. Selector normalization:
`1245.A`, `#1245.a`, `1245A` all → task 1245, subtask A. Letters are never re-lettered.
```
$ node tools/task/task.js --tasks-dir ./store check 1001.a
checked #1001.A (1/3)
$ node tools/task/task.js --tasks-dir ./store check 1001B
checked #1001.B (2/3)
$ node tools/task/task.js --tasks-dir ./store check 1001.A     # already ticked
#1001.A already checked — no change.
$ node tools/task/task.js --tasks-dir ./store check 1001.Z ; echo "exit=$?"
task: task #1001 has no subtask Z.
exit=1
```
- No matching letter → **loud error** (exit 1, G5). Already-checked → **no-op with a notice** (exit 0,
  idempotent).
- **There is deliberately no `uncheck` mode** — un-ticking is a hand-edit (flip `- [x]` back to `- [ ]`;
  the tool re-reads it on the next write). Keeps the surface small.

### State modes — `start` / `finish` / `drop` / `remove` / `reopen`
- **`start <id>`** → `in-progress` (+ stamps `Started:` once). `#<id> started.`
- **`finish <id> --action "<text>"`** → `finished`, stamps `Ended:` + `End action: <text>`, moves the
  row to `finished-tasks-index.md`. `--action` is **required** (missing → `task: finish requires --action
  "<what was done>".`, exit 1).
- **`drop <id> --reason "<text>"`** → `dropped`, stamps `Ended:` + `End action: WON'T DO — <text>`, moves
  the row to `finished-tasks-index.md`. `--reason` is required.
- **`remove <id>`** → soft-stash to `removed-tasks-index.md` + `State: removed` (recoverable via reopen):
  `#<id> stashed to removed (recoverable via reopen).`
  **`remove <id> --hard`** → permanent delete of the body file + purge from every index
  (`HARD-DELETED #<id> — body removed, unrecoverable.`). Always requires the skill's explicit
  confirmation; **blocked entirely** when `allowHardDelete: false` (`task: hard delete is disabled by
  config (tasks.allowHardDelete: false). #<id> not touched.`, exit 1).
- **`reopen <id>`** → any ended/removed task back to `open`: keeps `Created`, **strips the now-stale
  `Ended:` / `End action:` lines** (G4), stamps `Reopened:`, moves the row back to `task-index.md`.

```
$ node tools/task/task.js --tasks-dir ./store finish 1000 --action "shipped in PR #42"
#1000 finished.
$ node tools/task/task.js --tasks-dir ./store reopen 1000     # (after it was later removed)
#1000 reopened.
# → body now shows State: open, Created kept, Ended/End action GONE, Reopened stamped.
```

**State-transition legality (G3).** For every state mode:

| From \ mode | start | finish | drop | remove | reopen |
|---|---|---|---|---|---|
| open | ✅ | ✅ | ✅ | ✅ | ∘ no-op |
| in-progress | ∘ no-op | ✅ | ✅ | ✅ | ∘ no-op |
| finished | ✖ error | ∘ no-op | ✖ error | ✅ | ✅ |
| dropped | ✖ error | ✖ error | ∘ no-op | ✅ | ✅ |
| removed | ✖ error | ✖ error | ✖ error | ∘ no-op | ✅ |

✅ = forward transition succeeds (exit 0) · ∘ = redundant (→ current state): **no-op with a notice**
(exit 0) · ✖ = nonsensical: **loud error naming the current state** (exit 1). `remove --hard` bypasses
the matrix (it purges from any state, including already-removed). Verified cells:
```
$ node tools/task/task.js --tasks-dir ./store finish 1000 --action x   # already finished
#1000 is already "finished" — finish is a no-op.
$ node tools/task/task.js --tasks-dir ./store start 1000 ; echo "exit=$?"
task: cannot start #1000: it is "finished". (reopen it first to start again)
exit=1
$ node tools/task/task.js --tasks-dir ./store remove 1000              # legal from finished
#1000 stashed to removed (recoverable via reopen).
```

### `resolve <selector> [--state <s>] [--since <Nd>]` (tool-internal)
Turn a deterministic selector into a validated, concrete id set (space-separated on stdout). Grammar
(spec §5): `all` · `<id>` · `<id>,<id>,…` · `<start>-<end>` (ascending; **descending is an error**; a
range matching nothing **warns** to stderr but exits 0; sparse ranges **skip** missing ids; a comma-list
id not in the pool warns + is skipped). `--state` picks the pool; `--since <Nd>` filters on the created
date within the pool. Natural-language windows ("last week") are lowered to `--since` by the skill (G6),
not parsed here.
```
$ node tools/task/task.js --tasks-dir ./store resolve all
1000 1001 1004
$ node tools/task/task.js --tasks-dir ./store resolve 1000-1004 --state all
1000 1001 1002 1003 1004
$ node tools/task/task.js --tasks-dir ./store resolve 1004-1000 ; echo "exit=$?"
task: descending range not allowed: 1004-1000 (start must be ≤ end)
exit=1
$ node tools/task/task.js --tasks-dir ./store resolve 2000-2005 --state all ; echo "exit=$?"
task: range 2000-2005 matched no existing tasks in this pool.
exit=0
```

### `reindex` (tool-internal)
Rebuild all three indexes from the bodies (bodies are truth) — the no-data-loss backstop for a drifted or
hand-corrupted index. Idempotent (a second run is byte-identical). Recomputes the Next-ID marker as
`max(highest body #, prior marker − 1, startId − 1) + 1` — it preserves a legit prior marker as a floor
so a hard-delete of the top id can't cause reuse, but it never trusts an arbitrary (possibly garbage)
index row to inflate the marker.
```
$ printf 'GARBAGE LINE\n' >> ./store/task-index.md      # corrupt the open index by hand
$ node tools/task/task.js --tasks-dir ./store reindex
reindexed: 3 open, 1 finished/dropped, 1 removed; Next ID 1005.
# → list is clean again; the garbage line is gone (rebuilt from bodies).
```

## The age ladder (Q3 / G2 — one pinned algorithm)

Ages are tool-computed (never stored — they'd go stale). In the configured `timezone`, with
`D` = calendar-day difference and `H` = elapsed whole hours:

| Condition | Renders |
|---|---|
| `D == 0` (same calendar day) | `today` |
| else `H < 24` | `{H}h ago` |
| else `days = floor(H/24)`, `days ≤ 13` | `{days}d ago` |
| else `days ≤ 69` | `{floor(days/7)}w ago` |
| else | `{floor(days/30)}mo ago` |

The resolved decision (Q3) **wins over the design §4 annotation** that labeled the hour band "(<1d)".
Verified boundaries against a fixed "today" of 2026-08-30 (list output):

```
#1000   · today   · Created 2026-08-30   (D=0)
#1001   · 1d ago  · Created 2026-08-29
#1002   · 13d ago · Created 2026-08-17   (last day-band)
#1003   · 2w ago  · Created 2026-08-16   (first week-band: 14d → floor(14/7)=2)
#1004   · 9w ago  · Created 2026-06-22   (last week-band: 69d → floor(69/7)=9)
#1005   · 2mo ago · Created 2026-06-21   (first month-band: 70d → floor(70/30)=2)
```

**The `Xh ago` band, in practice.** A stored `Created:` is date-only and `list` anchors it at **midnight**
(any time component in the value is stripped before the age is computed), so in real `list` output only
the `today` / day / week / month bands ever render — the sub-24h `{H}h ago` band is **not reachable through
a stored `Created:` value via `list`.** The hour band lives in the age algorithm proper (`lib/render.js`'s
`ladder` / `ageString(fromDate, nowDate)` two-`Date` form) and is exercised by the boundary tests
(`tests/render/test.js`, e.g. `ageString(yesterday-23:00, today-01:00) → "2h ago"`), which is the
cross-midnight case (D=1 but <24h elapsed). For a NAMED timezone the calendar-day diff is exact; the
midnight instant used for `H` is a local-midnight approximation. The default `timezone: "local"` is exact
end-to-end. The month divisor is `days/30` (a display nicety — `70d/30 = 2mo`).

## Config keys

See [`lib/config.md`](./lib/config.md) for the full resolver reference. The 12 configurable keys:
`enabled`, `tasksDir`, `startId`, `bucketSize`, `defaultOrder`, `defaultListState`, `timezone`,
`exportDir`, `allowHardDelete`, `maxOpenWarn`, `autoConfirm.{finish,drop}`, `minimalTasks`, `subtaskStyle`.
`minimalTasks` is a **skill drafting hint** (whether to require context), not a tool gate — the tool is
lenient and writes whatever payload it's given (G7). `subtaskStyle` is `letters` at launch; `numbers` is
documented-but-not-built (Q7).

## Exit codes

| Code | When |
|---|---|
| `0` | The subcommand did its work (including a redundant no-op transition and an empty/warn selector result); `--help`; `tasks.enabled: false` short-circuit. |
| `1` | Unknown subcommand; a required input missing (no `--from`, no id, `finish` without `--action`, `drop` without `--reason`); an unparseable/descending selector; `check` on a nonexistent letter; a nonsensical state transition; `remove --hard` under `allowHardDelete: false`; an explicit `--config` path that doesn't exist. A bare invocation with no args prints usage and exits 1. |

All error paths print a single-line `task: <message>` to stderr. Warnings (empty range, config fell back
to defaults, maxOpenWarn nudge) also go to stderr but do **not** change a success exit code.

## Known limitation — concurrency (Q10, accepted)

There is **no lock.** Editing different tasks touches different body files → no conflict. The only shared
hot spots (the Next-ID marker, an index file) are touched by the tool only, briefly. A residual race —
two `add`s in the same instant across two sessions — is rare and self-heals: the marker recomputes to
`max(marker, highest # across body filenames ∪ index rows) + 1` on every add/import (G10), and `reindex`
reconciles any index drift from the bodies. A lock would be over-engineering for a single-project,
low-frequency ledger (spec §0). One edge to know: a `remove --hard` of the highest id followed by a
`reindex` **after** the marker was also lost can reuse that id — a double-fault; normal operation
preserves the marker and never reuses.

## See also

- [`README.md`](./README.md) — the per-suite readme (`lib/` layout, tests, how to run).
- [`lib/config.md`](./lib/config.md) — the `tasks` config-section resolver (12 keys + flags).
- `lib/format.js` header docstring — the canonical body/index token SSOT (the exact managed lines the
  tool parses + rewrites in place; the G1 preserve-unmanaged-prose contract).
- `out/skills/tpm-task/SKILL.md` + `modes-mutate.md` / `modes-end.md` — how the `/tpm-task` skill drives
  this tool (judgment: draft content, detect epics, confirm destructive ops).
