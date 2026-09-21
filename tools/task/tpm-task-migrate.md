# `tpm-task-migrate.js` — opt-in old→new task-store migrator (`#1114.B`)

Convert-on-demand tool that turns a WHOLE old markdown task store (the pre-JSON
`task-index.md` / `finished-tasks-index.md` / `removed-tasks-index.md` + thousand-bucketed
`bodies/<lo>-<hi>/task-<id>.md` landmark bodies) into the new canonical JSON store
(`bodies/<lo>-<hi>/task-<id>.json` envelopes + `tasks-index.json` incl. the `#1071` label
reverse-index + optionally the three derived human `.md` index views).

It **composes** the blessed base lib + the task kind modules and re-implements none of the
write/validate/index path: `envelope.writeEnvelope` (atomic) · `validate.validateEnvelope` +
`task-schema.validatePayload` · `task-model.reindex` / `bodyPathFor` / `loadTask` (round-trip check)
/ `writeIndexViews` · `task-converter.render` / `renderIndexView` (the `--emit-derived` files). The
old bodies are parsed by the SAME lenient parser that wrote them (`lib/legacy-task-format.js`, a
verbatim copy of the retired `tpm-task-format.js` — no second parser).

> **Detection and the "suggest migration" nudge are the DOCTOR's job** (`tpm-task-doctor.js`, `#1119`),
> not this tool. The migrator never scans, never auto-runs, never touches the live tasks dir.

Node-invokable, no `bin` (`#1121`): run via bare `node`. Zero third-party deps.

Format authorities (cross-referenced, not restated): [`../task-json-format-spec.md`](../task-json-format-spec.md)
(the JSON envelope + editable-vs-mechanical table + disk layout). Overview + file map: [`README.md`](README.md).

---

## Usage

```
node tpm-task-migrate.js --in <oldTasksDir> --out-dir <newTasksDir> \
    [--offset ±HH:MM] [--dry-run] [--emit-derived] [--force] [--now <iso>]
```

| Flag | Req | Meaning |
|---|---|---|
| `--in <dir>` | ✅ | old task store (`task-index.md` + `bodies/<lo>-<hi>/task-<id>.md`). **READ-ONLY** — never modified. |
| `--out-dir <dir>` | ✅ | where the JSON store is written. Must differ from `--in` and must not resolve inside a live `.claude/claude-tpm/tasks` tree. |
| `--offset ±HH:MM` | | the T-Q1 offset for the date→`T00:00:00` promotion (default: the runner-local offset, always recorded in a provenance note). |
| `--dry-run` | | parse + validate + report what *would* be written; write nothing. Lists ALL failures in one pass. |
| `--emit-derived` | | also write each `task-<id>.md` body + the three human index `.md` views. |
| `--force` | | overwrite existing target JSON bodies (otherwise refuse if any exist). |
| `--now <iso>` | | reference materialization stamp for `updatedAt` (default: now, local offset). Injectable so goldens are byte-stable. |
| `--help` | | show usage (exit `0`). |

No flag has a default path (tool-conventions "no hardcoded paths / no silent defaults for required inputs").

Exit codes: `0` success (or `--help` / a clean `--dry-run`) · `1` refusal / runtime error · `2` CLI arg error.

### Example (verified against a scratch store)

```
$ node tpm-task-migrate.js --in /tmp/old --out-dir /tmp/new --offset -07:00 --emit-derived
store /tmp/old → WROTE
  out:        /tmp/new
  bodies:     2 task(s) converted
  index:      /tmp/new/tasks-index.json (nextId 1150)
  derived md: 2 body view(s) + 3 index view(s)
  validation: PASS (schema 1.0.0, kind task)
  note:       offset: explicit --offset -07:00 used for every date promotion (T-Q1).
  note:       nextId floor: preserved the old '**Next ID:** 1150' marker from task-index.md (T-Q4).
  note:       task-1119: createdAt promoted from date-only '2026-09-19' → '2026-09-19T00:00:00-07:00' (T-Q1, offset -07:00).
  ...
# exit 0
```

The summary + every provenance note go to **stderr**; nothing renders to stdout.

---

## Strict all-or-nothing (T-Q4)

The migration unit is the **whole store**. If ANY body cannot be converted, the run REFUSES loud
naming EVERY offender and writes NOTHING (no partial store). `--dry-run` lists all failures in one
pass so a fix is one edit round, not whack-a-mole. Refusal reasons, all verified:

| Reason | Trigger |
|---|---|
| missing `- **Created:**` | a body carries no real date (see T-Q1 below) |
| missing the `# #<id> · <headline>` title | not a task body |
| id / filename mismatch | the title id disagrees with the filename id |
| state ∉ `open\|in-progress\|finished\|dropped\|removed` | an unknown state word |
| empty headline | the title has no text after `#<id> ·` |
| empty subtask text | a `- [ ] A.` line with no text |
| unreadable body | the `.md` cannot be read |

A body that fails `validateEnvelope` (validate-before-write) is a refusal too — an invalid
`task-<id>.json` is never written. A store that already holds any `task-<id>.json` body OR a
`tasks-index.json` is REFUSED before parsing (never half-convert — see `detectStore` below).

Verified — a no-`Created` body refuses the whole store:

```
$ node tpm-task-migrate.js --in <old-with-no-Created-body> --out-dir <scratch>
tpm-task-migrate (refused): refusing to migrate '…': 1 of 1 body(ies) cannot be converted (STRICT
all-or-nothing whole-store; NO partial write). Fix by hand, then re-run:
  - task-1200 (…/task-1200.md): task-1200: missing '- **Created:**' — T-Q1 refuses a body with no
    real date (a timestamp is never fabricated). Add the Created date by hand, then re-run.
# exit 1
```

### nextId floor (T-Q4)

`detectStore` reads the `**Next ID:**` marker from `task-index.md` and seeds it as the prior
high-water mark before `reindex` recomputes the index, so the new store floors `nextId` at
`max(marker, max(bodyId)+1, startId)` — an id is never reused, even if the marker is stale-low. A
marker of `1150` over bodies `1000`/`1119` yields `nextId 1150` (marker wins); a marker below
`max(bodyId)+1` loses to the body floor. No marker → the note says `nextId will floor at
max(bodyId)+1`.

---

## T-Q1 — date-only → ISO-TZ promotion (the load-bearing ruling)

Old bodies carry only `- **Created:** YYYY-MM-DD` (date granularity — no time, no offset), but the
schema needs `timestamps.createdAt` as a non-null local-offset ISO-8601 value. Task granularity IS
coarser (the render itself shortens to `YYYY-MM-DD`), so the date is the real datum and only
display-precision is absent. So:

- the real date is promoted to `<date>T00:00:00<offset>`, where `<offset>` is an explicit `--offset`
  or (default) the runner-local offset, recorded in a provenance note;
- `Started`/`Ended`/`Reopened` get the same date→ISO promotion (nullable — absent stays `null`);
- `updatedAt` is stamped with the REAL materialization time (`--now`, else `nowIsoTz()`), never promoted;
- a body with **no `Created` at all is REFUSED** — the required `createdAt` has no real value, and
  nothing beyond this one date-promotion is ever fabricated.

This is a **deliberate, documented divergence** from the session migrator's "never synthesize a
timestamp" rule: session had no real date to promote; tasks do.

Other mapping notes: old `- **End action:** <text>` → `endAction: { action: <text>, refs: [] }`
(T-Q3 shape — `refs` always present; old data carries no refs). Each migrated task seeds a single
`history: [{ at: createdAt, op: "create" }]` event (T-Q5), matching `openTask`. The old store has no
labels, so `labels: []` (and the index `labels` reverse-map is `{}`).

---

## Safety rails

- **Convert-on-demand, whole store per run.** No scan-and-auto-convert; nothing runs without explicit flags.
- **Read-only on `--in`; write-only under `--out-dir`.** `--out-dir` == / inside `--in` is refused;
  an `--out-dir` inside a live `.claude/claude-tpm/tasks` tree is refused.
- **Validate-before-write** + **round-trip proof.** Every assembled record runs through
  `validateEnvelope` before any write, and every written body is re-loaded through `loadTask`
  (read → migrate → validate) so the output is provably canonical.
- **`--dry-run`** validates + reports and writes nothing; an existing output is refused without `--force`.

All verified:

```
$ node tpm-task-migrate.js --in <old> --out-dir <old>/sub
tpm-task-migrate (refused): --out-dir '…/old/sub' is (or is inside) --in '…/old'; write output somewhere else.   # exit 1

$ node tpm-task-migrate.js --in <old> --out-dir <new>          # target already has bodies, no --force
tpm-task-migrate (refused): output already holds 2 target body file(s) (e.g. …/task-1000.json) — pass --force to overwrite.   # exit 1
```

---

## Programmatic API

```js
const { runMigration, parseOldBody, detectStore, MigrateError } = require('./tpm-task-migrate');
```

- `runMigration(opts)` — full convert (`inDir`, `outDir`, `offset?`, `dryRun?`, `emitDerived?`,
  `force?`, `now?`, `loadTask?`). Returns `{ inDir, outDir, marker, offset, records, count, total,
  refusals, notes, written, valid, indexPath, bodyPaths, mdPaths, index?, refusalMessage? }`.
- `parseOldBody({ raw, id?, offset?, now? })` → `{ record, notes }` (parse + assemble one body, no write).
- **`detectStore(inDir)`** → `{ inDir, bodies:[{id, path}], marker }` or throws `MigrateError`. The
  ONE old-format detector: recognises a CLEAN old store (`.md` bodies, no JSON body, no
  `tasks-index.json`), returns the bodies sorted by numeric id and the `**Next ID:**` marker
  verbatim (`null` when absent). Refuses a partly-migrated / non-store / empty dir. **The doctor
  imports this** as its old-format check — the detector is not re-implemented.

A refusal is always a `MigrateError` (a clean refuse, not a crash).

---

## Tests

`tests/task-migrate.test.js` (run: `node tests/task-migrate.test.js`, or via `tests/run-all.js`),
plus the migrate exit-code rows in `tests/exit-code.test.js`. Fixtures under
`tests/fixtures/legacy-tasks/` (clean / refuse-no-created / refuse-partial copies of real bodies);
output always goes to `os.tmpdir()`. Covers the T-Q4 marker-wins + stale-low-floor pair, the T-Q1
date promotion + no-`Created` refusal, one test per refusal reason, and the safety rails, all
mutation-proven.
