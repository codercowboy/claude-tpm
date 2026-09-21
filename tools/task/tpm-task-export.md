# `tpm-task-export.js` — export + search (#1092)

`tpm task export` and `tpm task search` on ONE selector core (P07). `buildSelector` parses the identical
selector set once; `selectCandidates` evaluates it against `tasks-index.json` (the fast path — a body
`task-<id>.json` is opened only when a predicate needs it: `--match` prose, `--closed-since` / `--by
closed` for `endedAt`). BOTH verbs call the same selector core; **export emits the RECORDS, search emits
`id·file·line·snippet` POINTERS**. It composes `lib/task-model.js` + `lib/task-converter.js` +
`lib/base.js` (`export-scaffold`) — re-implements no filter/combine/dispatch machinery.

Format authorities (cross-referenced, not restated here):
[`../task-export-spec.md`](../task-export-spec.md) (the export/search surface + decisions E1–E4) and
[`../task-json-format-spec.md`](../task-json-format-spec.md) (the envelope). Overview: [`README.md`](README.md).

**Run:**
```
npx tpm task <export|search> --tasks-dir <dir> [SELECTORS…] [SHAPE…]
```
`export` is the default mode when no mode token leads. Programmatic callers `require('./tpm-task-export')`
for `buildSelector / selectCandidates / matchesRow / runExport / runSearch / pointerFor`.

## Common flag
| Flag | Meaning |
|------|---------|
| `--tasks-dir <dir>` | the task store to read. **Required — never defaults to the live store.** |
| `--now <iso>` | reference time for relative windows AND human-render ages (default: now; makes runs deterministic). |

## Selectors (AND together)
| Selector | Meaning |
|----------|---------|
| `<id\|LO-HI>…` | explicit ids and/or ranges; also the comma form `"1112,1119"` (feeds #1125). |
| `--state <s>[,<s>]` | by state (`open`,`in-progress`,`finished`,`dropped`,`removed`). |
| `--open` | sugar: `open` + `in-progress`. |
| `--closed` | sugar: `finished` + `dropped`. |
| `--label <l>` | by label (repeatable; AND). |
| `--match <text>` | ci substring over `headline` + `summary` + `context` (opens bodies). |
| `--opened-since <win>` | `createdAt` ≥ window (also `--opened-after`, `--opened-before <date>`). |
| `--updated-since <win>` | `updatedAt` ≥ window. |
| `--closed-since <win>` | `endedAt` ≥ window (opens bodies). |
| `--last <N> [--by updated\|created\|closed]` | the N most-recent matching (default order `updated`). |

A window is a relative `<Nd\|Nh\|Nw>` OR a `YYYY-MM-DD` date. An **invalid window / id / flag is an EXIT-2
usage error** (`#1092-I`), never a silent empty result. Runtime failures (bad store, missing dir) exit
`1`. A valid selection that matches nothing is NOT an error (export prints nothing to stderr; search
prints `(no matches)`), exit `0`.

## Shape (export)
| Flag | Effect |
|------|--------|
| `--json` / `--human` | machine records vs. rendered bodies (default `--human` to stdout, OQ4; both repeatable). |
| `--combined` *(default)* | one stream/file. |
| `--per-file --out <dir>` | one `task-<id>.{json,md}` per task. |
| `--thin` | drop `history[]` via `model.stripHistory` (NOT the base `trimNonEditable`). Default JSON is FULL incl. history. |
| `--out <dir\|file>` | write here instead of stdout (a single output to a `.json`/`.md` path writes that file; otherwise `--out` is a directory). |

**Combined JSON shape:** a multi-task match is a **bare array of envelopes** `[ {…}, … ]` (no wrapper,
matches session's multi shape); a **single-task match collapses to a bare envelope object** (no length-1
array) — the base scaffold's one-vs-many dispatch. Combined human repeats each body's full
`# #<id> · …` header.

## `search` output
The SAME selectors; emits `id·file·line·snippet` pointers as plain text (default) or `--json`. `file` is
the body's store-relative path (from the index row); for a `--match` run the pointer is the first
body-file line containing the term, otherwise the headline line. Reads the raw body once only for the
line/snippet.

## Examples
```
npx tpm task export --tasks-dir /tmp/t --state open --json          # open tasks, full records
npx tpm task export --tasks-dir /tmp/t --open --human               # human dump, open + in-progress
npx tpm task export --tasks-dir /tmp/t --closed --json --thin       # recently closed, history dropped
npx tpm task export --tasks-dir /tmp/t 1000-1500 --json --per-file --out ./out
npx tpm task export --tasks-dir /tmp/t --last 1 --by created --json
npx tpm task search --tasks-dir /tmp/t --match router              # id·file·line·snippet pointers
npx tpm task search --tasks-dir /tmp/t --match router --json
```

Real invalid-window guard (EXIT 2, not a silent empty result):
```
$ npx tpm task export --tasks-dir /tmp/t --opened-since garbage
tpm-task-export: invalid window 'garbage' — expected a relative window (Nd | Nh | Nw) or a date (YYYY-MM-DD)
# exit 2
```

Real search pointer:
```
$ npx tpm task search --tasks-dir /tmp/t --match router
#1000  bodies/1000-1999/task-1000.json:6  "headline": "Wire the router",
```

Tests: `tests/tpm-task-export.test.js` (auto-discovered by `tests/run-all.js`).
