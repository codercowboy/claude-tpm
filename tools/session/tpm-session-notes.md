# `tpm-session-notes.js` — the ledger WRITE API

Writes the **current** session's `session-NNNN-log.md` — the append-only ledger: `## Decisions` and
`## Log`, plus the shared wayfinding header and the `SEALED <date>` trailer. Resolves "which session is
current" via `tpm-session-current.js`, so it never writes to a stale or arbitrary session by accident.

This is one of three writers behind a session's memory: `tpm-session-notes.js` owns the **ledger**
(`session-NNNN-log.md`, renamed from the former `session-notes.md`), `tpm-session-punchlist.js` owns
**`session-NNNN-punchlist.md`** (open/done work items), and `tpm-session-save.js` owns
**`session-NNNN-handoff.md`** (the pickup doc). All three files are prefixed with the four-digit session
number and carry a `tpm-session-version: 1.0` preamble in their shared header. The old `resume` and
`open` verbs are **retired** — RESUME moved to the handoff head, open items moved to the punchlist.

Every claim below was run against a disposable sandbox tree, never the live configured sessions dir.

## Purpose

The orchestrator supplies **content** — what got decided and why, what to log. This tool owns **format,
placement, and discipline**: the ledger is append-only (a decision or a log entry is a fact about the
past, not live state to edit), and it refuses casual edits to a sealed (past) session.

## Requirements / invocation shape

```
npx tpm session notes --sessions-dir <dir> [--edit-sealed <NNNN> --confirm] <verb> [args]
```

- `--sessions-dir <dir>` — **required on every invocation.** No default (per `tool-conventions.md`'s
  no-hardcoded-paths rule) — resolve it yourself, e.g. via `npx tpm session config --sessions-dir`.
- `--help`/`-h` prints usage and exits 0. A missing verb prints `a verb is required
  (init|log|decide|seal).` and exits 1.

## Verbs

| Verb | Effect | Zone |
|---|---|---|
| `init [--theme "<text>"] [--date <YYYY-MM-DD>]` | Creates the current session's `session-NNNN-log.md` skeleton (header + empty `## Decisions`/`## Log`) if it doesn't exist. **Idempotent**: a second `init` prints `… already exists — nothing to init.` and exits 0 — it does NOT overwrite or re-theme. | creates file |
| `log --status <TAG> "<text>"` | Appends one entry to `## Log`: `- [<TAG>] <text>  [<ISO-TZ>]`. `<TAG>` is **free text, not a validated enum** — the suggested set (`DONE`/`WIP`/`BLOCKED`/`HELD`/`PARKED`/`DROPPED`) is a convention the tool does not enforce. Both `--status` and the text arg are required. | Log (append-only) |
| `decide "<what>" --why "<why>"` | Appends one entry to `## Decisions`: `- **Decided:** <what> — <why>  [<ISO-TZ>]`. Both are required. | Decisions (append-only) |
| `seal` | Stamps `SEALED <date>` (today, `YYYY-MM-DD`) at the end of the note, and — **only when sealing the current session** (not via `--edit-sealed`) — marks the current-session pointer closed via `tpm-session-current.js`, so the next bare `tpm-session` opens a fresh session instead of reusing this one. | trailer + pointer |

Both `log` and `decide` stamp a trailing ISO-8601 timestamp with timezone (`2026-09-16T20:13:49-07:00`).
The timestamp is **trailing** — this is the new ledger shape, not the old inline `- [TAG] <ISO> — text`.

**Lazy file creation.** Every verb requires a session to already be open — calling any of them with no
session open fails with `session-notes: no session is currently open. Run \`tpm-session open\` first …`
(exit 1). What IS lazy: if a session is already open but its `session-NNNN-log.md` doesn't exist yet, the
first `log`/`decide` call creates the skeleton (header + `# SESSION NNNN — <today> — (untitled)` + empty
sections) automatically, then appends.

## Immutability guard — `--edit-sealed <NNNN> --confirm`

Every verb operates **only** on the current open session by default. To touch a different (sealed/past)
session, pass both flags together:

- `--edit-sealed <NNNN>` alone → refused: `--edit-sealed <NNNN> requires --confirm as well — refusing the
  casual path to a non-current session.` (exit 1). No partial override exists.
- `--edit-sealed <NNNN>` must be a **four-digit** number — a three-digit id is refused with
  `--edit-sealed 001: session number must be four digits (e.g. 0007). Refusing to write to an invalid
  session id.` (exit 1). **Verified.** There is no path to a pre-v1.0 (three-digit) session.
- `--edit-sealed <NNNN> --confirm` against a **canonical** (tool-written) sealed note → succeeds, still
  appending and keeping the `SEALED <date>` trailer at the end.
- `--edit-sealed <NNNN> --confirm` against a **non-canonical** note (no `# SESSION NNNN — …` title) →
  refused with an `ENOTCANONICAL`-coded error rather than shoehorning prose into the new structure.

## Exit codes

| Code | When |
|---|---|
| `0` | Verb succeeded (including an idempotent `init`), or `--help` was passed. |
| `1` | `--sessions-dir` missing; no/unknown verb; missing required flags for a verb; no session open and no `--edit-sealed --confirm` override; `--edit-sealed` without `--confirm`; `--edit-sealed` with a non-four-digit id; `--edit-sealed --confirm` against a non-canonical note. |

All error paths print a single-line `tpm-session-notes.js: <message>` (or `session-notes: <message>`) to
stderr — no stack trace.

## Worked example (run against the sandbox)

```
$ npx tpm session current --sessions-dir "$SDIR" --open
{ "number": "0001", "sessionId": "...", "isNew": true, "pointerPath": "...sessions/.current-session.json" }

$ npx tpm session notes --sessions-dir "$SDIR" init --theme "Wire up CSV export"
session-notes: created .../session-0001/session-0001-log.md

$ npx tpm session notes --sessions-dir "$SDIR" log --status DONE "Wired the toolbar button to exportCsv()"
session-notes: appended [DONE] log entry in .../session-0001/session-0001-log.md

$ npx tpm session notes --sessions-dir "$SDIR" decide \
    "Use the existing exportCsv() helper" --why "avoids duplicating CSV escaping logic"
session-notes: appended decision in .../session-0001/session-0001-log.md

$ npx tpm session notes --sessions-dir "$SDIR" seal
session-notes: sealed .../session-0001/session-0001-log.md (2026-09-17)
```

Resulting `session-0001/session-0001-log.md` (verified byte-for-byte):

```markdown
<!-- tpm-session: 0001 · 2026-09-17 · tpm-session-version: 1.0 · files: session-0001-handoff.md, session-0001-punchlist.md, session-0001-log.md -->
> **Session 0001 memory — three files in this folder.  THIS FILE: log.**
> • **session-0001-handoff.md** — READ FIRST: where we are, next action, what NOT to redo.
> • **session-0001-punchlist.md** — open/done work items (numbered).
> • **session-0001-log.md** — append-only ledger: Decisions + Log (log reads **bottom-to-top**).

# SESSION 0001 — 2026-09-17 — Wire up CSV export

## Decisions
- **Decided:** Use the existing exportCsv() helper — avoids duplicating CSV escaping logic  [2026-09-17T09:01:00-07:00]

## Log
- [DONE] Wired the toolbar button to exportCsv()  [2026-09-17T09:01:00-07:00]

SEALED 2026-09-17
```

After `seal`, `tpm-session-current.js --state` reports `not-opened` — confirming a bare invocation right
after close opens a NEW session rather than resuming the sealed one.

## See also

- `tools/session/tpm-session-save.md` — the handoff writer (the pickup doc). What used to be RESUME.
- `tools/session/tpm-session-punchlist.md` — the open/done work items. What used to be Open items.
- `tools/session/tpm-session-review.md` — the read side (Decisions + Log come from here).
- `claude-context/methodology/session-notes-format.md` — the canonical three-file format spec.
- `tools/session/tpm-session-current.js` — resolves "what session is current" for this tool.
- `.claude/skills/tpm-session/SKILL.md` + `modes-open.md` / `modes-close.md` — how the `tpm-session`
  skill drives this tool end-to-end.
