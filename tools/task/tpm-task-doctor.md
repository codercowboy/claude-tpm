# `tpm-task-doctor.js` — read-only task-store validator + drift detector (`#1119`)

The task **doctor**: a strictly READ-ONLY health check over a task store. It validates every
canonical `bodies/<bucket>/task-<id>.json`, detects derived-file **drift** (the JSON changed since
its body `.md` was rendered), checks the **label reverse-index**, and detects an **old-format**
markdown store and SUGGESTS the migrator. It never writes, mutates, migrates, or re-renders anything.
There is no `--fix`.

The task-side mirror of `../../20260919-session-features/session-tooling/tpm-session-doctor.js`.
Node-invokable, no `bin` (`#1121`): run via bare `node`. Zero third-party deps.

Format authority (cross-referenced, not restated): [`../task-json-format-spec.md`](../task-json-format-spec.md).
Overview + file map: [`README.md`](README.md). The old-format detector + migrate command:
[`tpm-task-migrate.md`](tpm-task-migrate.md).

---

## Usage

```
npx tpm task doctor --tasks-dir <dir> [--json]
```

| Flag | |
|---|---|
| `--tasks-dir <dir>` | **REQUIRED**, no default. The task store root (`bodies/<bucket>/task-<id>.json` in the nested bucket layout + `tasks-index.json`). READ-ONLY. |
| `--json` | Emit the structured report as JSON instead of human text. |
| `--help` | Show usage (exit `0`). |

Programmatic callers `require()` it for `runDoctor(opts) -> report`.

---

## The four checks

Bodies are discovered by `task-model.listBodyPaths` — the NESTED `bodies/<bucket>/task-<id>.json`
layout, the store's real shape (a task store is a single dir, so detection is whole-store, not the
session doctor's per-subdir sweep).

1. **Schema validation.** Each body runs the canonical load path, stage-labeled so a failure names
   the stage instead of crashing the run:
   - `readCanonicalSync` throws → **FAIL [read]** (unreadable / corrupt JSON).
   - `version.migrate` throws → **FAIL [migrate]** (unknown, newer-than-code `schemaVersion`).
   - `validateEnvelope` + `task-schema.validatePayload` throws → **FAIL [validate]** (the exact violation).
   - all pass → **OK**.

2. **Hash-drift (read-only).** The derived body `.md` carries a `<!-- generated from: <12hex> -->`
   banner that is `hash.hashRecord(record)` stamped at render time. The doctor recomputes
   `hashRecord` over the CURRENT on-disk JSON and compares to the banner. A mismatch means the **JSON
   changed** since the body was rendered (a save that skipped the re-render, or a hand-edited JSON) →
   **DRIFT**. It recomputes + string-compares only; it never re-renders. Because the hash is over the
   record content, not the clock, there are no `now`-relative false positives. (Editing the `.md`
   text without changing its banner does not register — the check is JSON-vs-banner, not
   render-vs-`.md`.)

3. **Label-index consistency.** `tasks-index.json.labels` is the `#1071` label→ids reverse index the
   model keeps in lockstep with the rows. The doctor recomputes `model.deriveLabelIndex(index.tasks)`
   and compares to the stored `index.labels`:
   - `OK` — the two match.
   - `MISMATCH` — they differ → **SUGGEST `tpm task reindex`** (never rebuilds).
   - `MISSING` — bodies exist but there is no `tasks-index.json` → SUGGEST reindex.
   - `CORRUPT` — `tasks-index.json` is unparseable / has no `tasks` array → SUGGEST reindex.
   - `NONE` — empty store (no index, no bodies): nothing to check.

4. **Old-format detect.** Imports the migrator's `detectStore` (the ONE old-format detector, NOT
   re-implemented). Probed FIRST: a clean markdown-only store has no JSON bodies to validate, so when
   one is detected the doctor reports it + **SUGGESTS `tpm task migrate`** and stops. A `MigrateError`
   refusal means "not a clean old store" → falls through to checks 1–3. Never migrates.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean store — no problems. Advisories (`UNSTAMPED`, a missing `.md`) are allowed and do NOT flip it. |
| `1` | Problems found — an invalid record, hash-drift, a label-index `MISMATCH`/`MISSING`/`CORRUPT`, OR a detected old-format store. Still report-only; nothing is written. |
| `2` | Usage error — bad/unknown flag, missing `--tasks-dir` value, or an unreadable/non-directory store dir. |

The advisory posture, verified: a body whose `.md` sibling is **missing** → `drift NONE`, exit
unchanged (`0`); a `.md` with **no banner** → **UNSTAMPED** advisory, exit unchanged (`0`). Neither
is a hard problem. (There is no `--strict` — the task exit contract lumps every real finding as
nonzero, so a strict/advisory split would only muddy it.)

---

## Report shape

- **Human (default):** a header (`N task(s) · X valid · Y invalid · Z drift [· W unstamped] ·
  label-index <status>`), one line per body (`OK` / `FAIL [stage]: …` / `OK · DRIFT (banner … ·
  current … — …)` / `OK · UNSTAMPED (…)`), then the label-index suggestion block (on
  MISMATCH/MISSING/CORRUPT) and a closing `Clean — no problems found` on exit 0. An old-format store
  prints its own block with the migrate suggestion.
- **`--json`:** `{ tasksDir, oldFormat, bodies:[{file, id, validate:{status,stage?,problem?},
  drift:{status,bannerHash?,currentHash?}}], labelIndex:{status,…}, summary:{bodies, valid, invalid,
  drift, unstamped, labelIndex, oldFormat}, exitCode }`.

Verified runs against scratch stores:

```
$ npx tpm task doctor --tasks-dir <clean>
task doctor · <clean>
2 task(s) · 2 valid · 0 invalid · 0 drift · label-index OK
  bodies/1000-1999/task-1000.json  OK
  bodies/1000-1999/task-1119.json  OK

Clean — no problems found. (Read-only: the doctor never writes.)
# exit 0

$ npx tpm task doctor --tasks-dir <json-hand-edited>
2 task(s) · 2 valid · 0 invalid · 1 drift · label-index OK
  bodies/1000-1999/task-1119.json  OK · DRIFT (banner 855e551c5933 · current e981f136e25d — body out of date; re-save via `tpm task`)
# exit 1

$ npx tpm task doctor --tasks-dir <old-markdown-store>
OLD-FORMAT task store detected (2 markdown body(ies), Next ID marker 1150).
  → SUGGEST migrate (the doctor never converts):
      npx tpm task migrate --in "<old-markdown-store>" --out-dir "<choose-an-output-dir>"
# exit 1
```

---

## Composition (re-implements nothing)

`lib/base.js` → `io.readCanonicalSync` · `version.migrate` · `validate.validateEnvelope` ·
`envelope.KNOWN_KINDS` · `hash.hashRecord` (the SHARED content hash the converter stamps into the
banner) · `task-schema.validatePayload` · `task-model.listBodyPaths` / `deriveLabelIndex` /
`indexPathFor` · `tpm-task-migrate.detectStore` / `MigrateError`. Zero third-party deps.

---

## Read-only guarantee (tested)

`tests/task-doctor.test.js` builds a scratch fixture store (valid, schema-invalid, drifted,
unstamped, missing-`.md`, label-mismatch, old-format), snapshots every file before/after `runDoctor`
in all modes, and asserts every file is byte-identical and none was created or deleted. The validate
and drift checks are mutation-proven (blanking a headline turns `invalid` 0→1; a JSON hand-edit turns
`drift` 0→1 with `bannerHash != currentHash`). Exit-code rows live in `tests/exit-code.test.js`. Both
run via `tests/run-all.js`.
