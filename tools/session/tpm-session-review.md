# `tpm-session-review.js` — session-notes READ API

Extracts the tokened sections of the last N session-notes cheaply, without loading every note into
context — powers "look back over the last N sessions: what open items did we never get back to?"
Shares `tpm-session-format.js`'s token parser with `tpm-session-notes.js` (write side), so read and write
cannot drift apart.

Every claim below was run against a disposable sandbox tree
(`tmp/documentarian-r1/sandbox/sessions/`), containing two canonical (tool-written) sessions
(`session-001`, `session-002`) and one legacy freeform session (`session-000`, plain prose, no
canonical headings) — mirroring the live project's actual mix (001–007 legacy, 008+ canonical).

## Purpose

Read-only. Writes nothing. Lists sessions newest-first by folder number (`session-NNN`, sorted
descending), loads up to `--last N` of them, and renders either a one-block-per-session overview or
a filtered view (open items only / decisions only), optionally further restricted by `--since` or
`--grep`.

## Requirements / invocation shape

```
npx tpm session review --sessions-dir <dir> --last N [--open-items|--decisions] [--since <date>] [--grep <term>] [--json] [--help]
```

- `--sessions-dir <dir>` and `--last <N>` are **both required** for any real output. Missing either
  (or a non-numeric `--last`) prints `tpm-session-review.js: --sessions-dir and --last <N> are
  required.` plus usage, **exit 1**.
- `--help`/`-h` alone prints usage and exits **0**, independent of the other required flags.
- A `--sessions-dir` that doesn't exist on disk is **not an error** — it resolves to zero sessions
  found, printed as `No sessions found.` (overview mode), exit 0.

## Flags

| Flag | Effect |
|---|---|
| `--last N` | How many of the highest-numbered sessions to include (after listing, before any other filter). Required. |
| `--open-items` | Print only the Open items across the selected sessions, one line each: `session-NNN — [x|  ] OPEN(<owner>) #<id>: <text>`. Legacy (non-canonical) sessions contribute nothing here — they carry no parseable open items — and are silently skipped, not shown as an error. If nothing matches: `No open items found in the selected sessions.` |
| `--decisions` | Same shape for Decisions: `session-NNN — Decided: <what> — <why>`. Legacy sessions skipped the same way. Empty case: `No decisions found in the selected sessions.` |
| `--since <YYYY-MM-DD>` | Keeps only sessions whose title date is `>=` the given date. **Verified:** a legacy session (no machine-parseable date) is always kept regardless of `--since` — it is unfilterable, not excluded by default. |
| `--grep <term>` | Case-insensitive substring filter across Resume text, Open-item text, Decision what/why, and Log text. A session survives the filter if *any* of those fields matches; **verified gotcha below** — the plain overview render does not surface which field matched. |
| `--json` | Emits the selected/filtered session objects as JSON (see shape below) instead of prose. Combines with every other flag above. |
| `--help` / `-h` | Usage, exit 0. |

With no `--open-items`/`--decisions`/`--json`, the default is the **overview** render: one block
per session — title line (`session-NNN — <date> — <theme>[ [SEALED <date>]]`) plus `Where:`/`Next:`
lines when present. A legacy session renders as
`session-NNN — (legacy format — not token-parseable) — <path>` (or `— no notes file found` if the
folder exists but has neither `session-notes.md` nor `notes.md`).

**Verified gotcha:** `--grep` matching a **Log** entry still only re-renders the overview's title +
Resume lines (not the Log line itself) — because a non-matching Resume block is blanked to empty
strings by the grep filter, so `Where:`/`Next:` simply don't print, and the overview renderer never
prints Log lines at all (only `--open-items`/`--decisions` do line-level output). Confirmed: `--grep
"grep target"` (a substring that exists only in a Log line) returned just the session's title/seal
line with no `Where:`/`Next:` — the match itself is not visible in overview mode. To see *why* a
session matched a Log-text grep, combine with `--json` or inspect the file directly.

## Exit codes

| Code | When |
|---|---|
| `0` | Any successful run, including zero results (`No sessions found.` / `No open items found...` / `No decisions found...` are exit 0, not errors) and `--help`. |
| `1` | `--sessions-dir` missing, `--last` missing, or `--last` not a valid integer. |

## `--json` output shape

One object per included session, newest first:
```json
{
  "number": "002",
  "filePath": ".../session-002/session-notes.md",
  "legacy": false,
  "parsed": {
    "title": "# SESSION 002 — 2026-08-31 — second sandbox session",
    "number": "002", "date": "2026-08-31", "theme": "second sandbox session",
    "resume": { "whereWeAre": "...", "nextAction": "...", "inFlight": "Nothing in flight." },
    "openItems": [ { "done": false, "owner": "jason", "id": 1, "text": "..." } ],
    "decisions": [],
    "log": [ { "status": "WIP", "date": "2026-08-30T08:59:19.646Z", "text": "..." } ],
    "sealedAt": "2026-08-30",
    "raw": "<the full file content>"
  }
}
```
A legacy session's `"legacy"` is `true`, `"parsed".number/date/theme/title` are all `null`, every
array is empty, and `"parsed".raw` holds the untouched prose (verified against `session-000`'s
freeform `notes.md`).

## Worked example (run against the sandbox — two canonical sessions + one legacy)

```
$ npx tpm session review --sessions-dir "$SDIR" --last 3
session-002 — 2026-08-31 — second sandbox session [SEALED 2026-08-30]
  Where: second session state
  Next:  none pending
session-001 — 2026-08-30 — Documentarian sandbox verification [SEALED 2026-08-30]
  Where: Verifying tpm-session-notes.js
  Next:  write tpm-session-review.js checks
session-000 — (legacy format — not token-parseable) — .../session-000/notes.md

$ npx tpm session review --sessions-dir "$SDIR" --last 5 --open-items
session-002 — [ ] OPEN(jason) #1: check the grep filter
session-001 — [x] OPEN(jason) #1: review the config-guide patch
session-001 — [ ] OPEN(claude) #2: write the tool docs

$ npx tpm session review --sessions-dir "$SDIR" --last 5 --decisions
session-001 — Decided: single pointer, not a sessionId map — env var unreliable outside subagents

$ npx tpm session review --sessions-dir "$SDIR" --last 5 --since 2026-08-31
session-002 — 2026-08-31 — second sandbox session [SEALED 2026-08-30]
  Where: second session state
  Next:  none pending
session-000 — (legacy format — not token-parseable) — .../session-000/notes.md
```
(`session-001`, dated 2026-08-30, is correctly excluded by `--since 2026-08-31`; the legacy
`session-000` is correctly kept regardless, per the unfilterable-date rule above.)

## See also

- `tools/session/tpm-session-notes.md` — the write side (same token format, same `--sessions-dir` flag).
- `tools/session/tpm-session-format.js` — the canonical format's token/regex source of truth this tool parses with.
- `out/skills/tpm-session/SKILL.md` — the skill's `info` mode is a thin wrapper over
  `tpm-session-current.js --state` plus a session count, not this tool directly; `save`/`open`/`close`
  call `tpm-session-notes.js`, not `tpm-session-review.js` — this tool is for the human/orchestrator
  "look back" query, not part of the write lifecycle.
