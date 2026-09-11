# `session-notes.js` — session-notes WRITE API

Writes the **current** session's `session-notes.md`: the canonical format's RESUME block
(rewritten in place), Open items (rewritten in place), Decisions (append-only), and Log
(append-only), plus the `SEALED <date>` trailer. Resolves "which session is current" via
`lib/current-session.js` — it never writes to a stale or arbitrary session by accident.

Every claim below was run against a disposable sandbox tree
(`tmp/documentarian-r1/sandbox/sessions/`), never the live `claude-context/sessions/`.

## Purpose

The orchestrator (or a caller acting on its behalf) supplies **content** — what to say in RESUME,
which items are open, what got decided. This tool owns **format, placement, and discipline**: it
enforces the two-zone rule (STATE = RESUME + Open items, rewritten in place; LOG = Log +
Decisions, append-only) and refuses casual edits to a sealed (past) session.

## Requirements / invocation shape

```
node session-notes.js --sessions-dir <dir> [--edit-sealed <NNN> --confirm] <verb> [args]
```

- `--sessions-dir <dir>` — **required on every invocation.** No default (per
  `tool-conventions.md`'s no-hardcoded-paths rule) — resolve it yourself, e.g. via
  `node lib/config.js --sessions-dir`.
- With no args, or `--help`/`-h`: prints usage. **No args → exit 1. `--help` → exit 0.** Verified:
  bare invocation and `--help` both print the identical usage block; only the exit code differs.

## Verbs

| Verb | Effect | Zone |
|---|---|---|
| `init [--theme "<text>"] [--date <YYYY-MM-DD>]` | Creates the current session's `session-notes.md` skeleton if it doesn't exist. **Idempotent**: a second `init` call prints `... already exists — nothing to init.` and exits 0 — it does NOT overwrite or re-theme an existing file. | creates file |
| `resume --where "<text>" --next "<text>" [--in-flight "<text>"]` | Rewrites the `## RESUME` block **in place**. `--in-flight` defaults to `"Nothing in flight."` if omitted. Both `--where` and `--next` are required — omitting either errors `resume requires --where and --next.` (exit 1). | STATE (in place) |
| `open add --owner <name> "<text>"` | Appends a new open item: `- [ ] OPEN(<owner>) #<id>: <text>`. `<id>` is a monotonic per-note integer (max existing + 1, starting at 1) — stable across edits, not a line position. `<name>` is free text, no fixed enum. Both `--owner` and the text arg are required. | STATE (append) |
| `open done <id>` | Marks open item `#<id>` as checked (`[x]`). Errors `no open item #<id> found.` (exit 1) if no such id exists — including a non-numeric `<id>` (e.g. `abc`), which also reports "no open item #abc found." | STATE (in place) |
| `log --status <TAG> "<text>"` | Appends one entry to `## Log`: `- [<TAG>] <ISO-8601 timestamp> — <text>`. `<TAG>` is **free text, not a validated enum** — the design's suggested set (`DONE`/`WIP`/`BLOCKED`/`HELD`/`PARKED`/`DROPPED`) is a convention the tool does not enforce. Both `--status` and the text arg are required. | LOG (append-only) |
| `decide "<what>" --why "<why>"` | Appends one entry to `## Decisions`: `- **Decided:** <what> — <why>`. Both are required. | LOG (append-only) |
| `seal` | Stamps `SEALED <date>` (today, `YYYY-MM-DD`) at the end of the note, and — **only when sealing the current session** (not via `--edit-sealed`) — also marks the current-session pointer closed via `lib/current-session.js`'s `sealSession`, so the next bare `tpm-session` invocation opens a fresh session instead of reusing this one. | trailer + pointer |

**Verified quirk in the header docstring (not a doc bug in this file — flagged for the source):**
`session-notes.js`'s own top-of-file docstring says "every verb ... except `init`/`resume` (which
lazily open one)". This is **not what the code does.** Every verb — `init` and `resume` included —
requires a session to already be open; calling any of them with no session open (confirmed for
both `init` and `resume` directly) fails identically:
```
session-notes: no session is currently open. Run `tpm-session open` first, or pass --edit-sealed <NNN> --confirm to edit a past session.
```
exit 1. What genuinely IS lazy: if a session **is** already open but its `session-notes.md` file
doesn't exist yet, the first `resume`/`log`/`decide`/`open` call creates the skeleton file
automatically (confirmed: calling `log` with no prior `init` produced a fresh
`# SESSION 003 — <today> — (untitled)` skeleton with the log line appended). That is "lazily
create the file inside an already-open session," not "lazily open a new session" — the docstring's
wording overstates it. See `findings/HANDOFF.md` for this discrepancy.

## Immutability guard — `--edit-sealed <NNN> --confirm`

Every verb operates **only** on the current open session by default. To touch a different
(presumably sealed/past) session, pass both flags together:

- `--edit-sealed <NNN>` alone → refused: `--edit-sealed <NNN> requires --confirm as well —
  refusing the casual path to a non-current session.` (exit 1). No partial/casual override exists.
- `--edit-sealed <NNN> --confirm` against a **canonical** (tool-written) sealed note → succeeds,
  still enforcing the two-zone rule (verified: a `log` call landed a new line in an already-sealed
  session, after its `SEALED <date>` trailer stayed correctly at the end).
- `--edit-sealed <NNN> --confirm` against a **legacy freeform** note (pre-canonical-format,
  `notes.md` with no `# SESSION NNN — ...` title) → refused with an `ENOTCANONICAL`-coded error:
  `... does not look like a canonical-format note (no "# SESSION NNN — ..." title found) — this
  tool refuses to auto-rewrite a freeform legacy note into the new structure.` (exit 1). It does
  NOT attempt to shoehorn prose into the new structure.

## Exit codes

| Code | When |
|---|---|
| `0` | Verb succeeded, or `--help` was passed. |
| `1` | No args passed; `--sessions-dir` missing; no verb given; unknown verb; missing required flags for a verb (e.g. `resume` without `--next`); no session open and no `--edit-sealed --confirm` override; `--edit-sealed` given without `--confirm`; `open done <id>` for a nonexistent id; `--edit-sealed --confirm` against a non-canonical (legacy) note. |

All error paths print a single-line `session-notes: <message>` to stderr (verb/arg-parsing errors
additionally print the full usage block) — no stack trace, no double-prefixing observed in any
case exercised above.

## Worked example — a full session lifecycle (run against the sandbox)

```
$ node tools/session/lib/current-session.js --sessions-dir "$SDIR" --open
{ "number": "001", "sessionId": "...", "isNew": true, "pointerPath": "...sessions/.current-session.json" }

$ node tools/session/session-notes.js --sessions-dir "$SDIR" init --theme "Documentarian sandbox verification"
session-notes: created .../session-001/session-notes.md

$ node tools/session/session-notes.js --sessions-dir "$SDIR" resume \
    --where "Verifying session-notes.js" --next "write session-review.js checks"
session-notes: RESUME updated in .../session-001/session-notes.md

$ node tools/session/session-notes.js --sessions-dir "$SDIR" open add --owner jason "review the config-guide patch"
session-notes: added open item #1 in .../session-001/session-notes.md

$ node tools/session/session-notes.js --sessions-dir "$SDIR" open add --owner claude "write the tool docs"
session-notes: added open item #2 in .../session-001/session-notes.md

$ node tools/session/session-notes.js --sessions-dir "$SDIR" open done 1
session-notes: marked open item #1 done in .../session-001/session-notes.md

$ node tools/session/session-notes.js --sessions-dir "$SDIR" log --status WIP "wrote lib/format.js"
session-notes: appended [WIP] log entry in .../session-001/session-notes.md

$ node tools/session/session-notes.js --sessions-dir "$SDIR" decide \
    "single pointer, not a sessionId map" --why "env var unreliable outside subagents"
session-notes: appended decision in .../session-001/session-notes.md

$ node tools/session/session-notes.js --sessions-dir "$SDIR" seal
session-notes: sealed .../session-001/session-notes.md (2026-08-30)
```

Resulting `session-001/session-notes.md` (verified byte-for-byte, one `## RESUME` block, both open
items present with #1 checked, one decision, two log lines, sealed trailer):

```
# SESSION 001 — 2026-08-30 — Documentarian sandbox verification

## RESUME
**Where we are:** Verifying session-notes.js
**Next action:** write session-review.js checks
**In flight:** Nothing in flight.

## Open items
- [x] OPEN(jason) #1: review the config-guide patch
- [ ] OPEN(claude) #2: write the tool docs

## Decisions
- **Decided:** single pointer, not a sessionId map — env var unreliable outside subagents

## Log
- [WIP] 2026-08-30T08:58:58.972Z — wrote lib/format.js
- [DONE] 2026-08-30T08:58:59.063Z — docs verified
```

(the `[DONE]` line above came from a second `log` call in the same verification pass, omitted
from the command list above for brevity — every command actually run is logged in
`findings/HANDOFF.md`).

After `seal`, `lib/current-session.js --state` reports `not-opened` and `--next-number` returns
the following number — confirming a bare invocation right after close correctly opens a NEW
session rather than resuming the sealed one.

## See also

- `tools/session/session-review.md` — the read side (same token format).
- `tools/session/lib/format.js` — the header docstring there is the canonical format spec (the
  exact headings/regexes this tool writes and `session-review.js` parses).
- `tools/session/lib/current-session.js` — resolves "what session is current" for this tool.
- `out/skills/tpm-session/SKILL.md` + `modes-open.md` / `modes-close.md` — how the `tpm-session`
  skill drives this tool end-to-end.
