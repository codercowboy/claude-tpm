# `tpm-session-review.js` — session READ API (look back over the last N sessions)

Extracts the tokened parts of the last N sessions cheaply, without loading every file into context —
powers "look back over the last N sessions: what open items did we never get back to?" It reads the
three-file format through `tpm-session-format.js` (the same SSOT the writers use), pulling each concern
from its home file: the overview from `session-NNNN-handoff.md`, open items from
`session-NNNN-punchlist.md`, decisions and log from `session-NNNN-log.md` (the ledger).

**Version read-gate (no back-compat).** `review` considers **only** sessions that read as
`tpm-session-version: 1.0` — a pre-v1.0 (three-digit, unprefixed, or unversioned) session is simply
**invisible**: it is not listed, not flagged, not "pointed at." There is no `metadata.json` and no legacy
tier. A window whose sessions are all pre-v1.0 renders `No sessions found.`

This is the **on-demand** look-back query. It is distinct from `tpm-session-boot-read.js`, which is the
mechanical pickup emit at `open`. `review` is for the human/orchestrator asking a question; it is not part
of the write lifecycle.

Every claim below was run against a disposable sandbox tree, never the live configured sessions dir.

## Purpose

Read-only. Writes nothing. Lists the v1.0 sessions newest-first by folder number (`session-NNNN`, sorted
descending) — filtering out pre-v1.0 folders first — loads up to `--last N` of what remains, and renders
either a one-block-per-session overview or a filtered view, optionally further restricted by `--since` or
`--grep`.

## Requirements / invocation shape

```
npx tpm session review --sessions-dir <dir> --last N [--open-items|--decisions] [--since <date>] [--grep <term>] [--json] [--help]
```

- `--sessions-dir <dir>` and `--last <N>` are **both required** for any real output. Missing either (or a
  non-numeric `--last`) prints `tpm-session-review.js: --sessions-dir and --last <N> are required.` plus
  usage, **exit 1**.
- `--help`/`-h` alone prints usage and exits **0**, independent of the required flags.
- A `--sessions-dir` that doesn't exist on disk is **not an error** — it resolves to `No sessions found.`,
  exit 0.

## Flags

| Flag | Effect |
|---|---|
| `--last N` | How many of the highest-numbered **v1.0** sessions to include (before any other filter). Required. |
| `--open-items` | Print only the OPEN punchlist items across the selected sessions, one line each: `session-NNNN — #<id> · <text>  [<slug>, <created>]`. Closed items are excluded; sessions with no open items contribute nothing. |
| `--decisions` | Print the ledger decisions: `session-NNNN — Decided: <what> — <why>`. |
| `--since <YYYY-MM-DD>` | Keeps only sessions whose title date is `>=` the given date. (Only v1.0 sessions are in scope to begin with.) |
| `--grep <term>` | Case-insensitive substring filter across the handoff Where/Next/In-flight text, open-item text, and the ledger's Decisions + Log. A session survives if any of those matches. |
| `--json` | Emits the selected/filtered session objects as JSON (shape below) instead of prose. Combines with the other flags. |
| `--help` / `-h` | Usage, exit 0. |

With no `--open-items`/`--decisions`/`--json`, the default is the **overview** render: one block per
session — a title line (`session-NNNN — <date> — <theme>[ [SEALED <date>]]`) plus, from
`session-NNNN-handoff.md`, `Where:` / `Next:` lines. **Fallback:** a v1.0 session with no handoff yet
(e.g. a ledger written before the first save) shows a `Decided:` (latest decision) and/or `Log:` (latest
log line) from its ledger instead. (There is no legacy-format render — a pre-v1.0 session is invisible,
not flagged.)

## Exit codes

| Code | When |
|---|---|
| `0` | Any successful run, including zero results (`No sessions found.` etc.) and `--help`. |
| `1` | `--sessions-dir` missing, `--last` missing, or `--last` not a valid integer. |

## `--json` output shape

One object per included session, newest first (verified):

```jsonc
{
  "number": "0001",
  "filePath": ".../session-0001/session-0001-log.md",      // the ledger
  "handoffPath": ".../session-0001/session-0001-handoff.md",
  "punchlistPath": ".../session-0001/session-0001-punchlist.md",
  "parsed": {                       // from session-NNNN-log.md (parseNote), or null
    "title": "# SESSION 0001 — 2026-09-17 — (untitled)",
    "number": "0001", "date": "2026-09-17", "theme": "(untitled)",
    "decisions": [ { "what": "...", "why": "...", "ts": "2026-09-17T09:00:44-07:00" } ],
    "log": [ { "status": "DONE", "text": "...", "ts": "2026-09-17T09:00:44-07:00" } ],
    "sealedAt": "2026-09-17",
    "raw": "<the full session-NNNN-log.md content>"
  },
  "handoff": {                      // from session-NNNN-handoff.md (parseHandoff), or null
    "number": "0001", "date": "2026-09-17",
    "where": "...", "next": "...", "inFlight": "Nothing in flight.",
    "whatRemains": [ { "session": 1, "n": 1, "id": "1.1", "text": "...", "slug": "79qdq4", "created": "..." } ],
    "mustNotRedo": ["..."],
    "raw": "<the full session-NNNN-handoff.md content>"
  },
  "open": [                         // open items from session-NNNN-punchlist.md
    { "done": false, "session": 1, "n": 1, "id": "1.1", "text": "...", "slug": "79qdq4", "created": "...", "closed": null }
  ]
}
```

There is **no `legacy` field** — the legacy tier was removed with the no-back-compat cut (verified: the
JSON keys are `number, filePath, handoffPath, punchlistPath, parsed, handoff, open`). A v1.0 session with
a ledger but no handoff yet has `"handoff": null` and `"open": []`, with `parsed` populated from the
ledger.

## Worked example (run against the sandbox — one saved+sealed session)

```
$ npx tpm session review --sessions-dir "$SDIR" --last 2
session-0001 — 2026-09-17 — (untitled) [SEALED 2026-09-17]
  Where: Toolbar button shipped and wired to exportCsv(); backend endpoint still pending.
  Next:  Add the backend export endpoint.

$ npx tpm session review --sessions-dir "$SDIR" --last 2 --open-items
session-0001 — #1.1 · Add the backend export endpoint  [79qdq4, 2026-09-17T09:00:21-07:00]

$ npx tpm session review --sessions-dir "$SDIR" --last 2 --decisions
session-0001 — Decided: Use the existing exportCsv() helper — avoids duplicating CSV escaping logic

$ npx tpm session review --sessions-dir "$SDIR" --last 2 --grep exportCsv
session-0001 — 2026-09-17 — (untitled) [SEALED 2026-09-17]
  Where: Toolbar button shipped and wired to exportCsv(); backend endpoint still pending.
  Next:  Add the backend export endpoint.
```

A v1.0 session with only ledger lines (no handoff yet) falls back to the ledger in overview:

```
$ npx tpm session review --sessions-dir "$OTHER" --last 1
session-0001 — 2026-09-17 — Wire up CSV export [SEALED 2026-09-17]
  Decided: Use the existing exportCsv() helper — avoids duplicating CSV escaping logic
  Log:   [DONE] Wired the toolbar button to exportCsv()
```

A sessions dir holding only pre-v1.0 folders (or an empty/absent dir) prints `No sessions found.`
(exit 0) — verified.

## See also

- `tools/session/tpm-session-boot-read.md` — the mechanical pickup emit at `open` (not this tool).
- `tools/session/tpm-session-save.md` / `tpm-session-punchlist.md` / `tpm-session-notes.md` — the writers
  whose files this tool reads.
- `claude-context/methodology/session-notes-format.md` — the canonical three-file format spec.
