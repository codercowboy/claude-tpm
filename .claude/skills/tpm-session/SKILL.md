---
name: tpm-session
description: Use at the start of a session to boot (open), to checkpoint / write session notes mid-session (save), to wrap up (close), or to check current session status (info). Bare "tpm-session" is state-aware — not yet opened this session -> open; already open -> save. Supersedes the retired session-open / session-close skills. Auto-invoke on the first substantive turn if `tpm-session open` hasn't run yet this session.
---

`tpm-session` is the unified session-lifecycle skill — `open` (boot), `close` (wrap-up), `save`
(checkpoint the notes), `info` (status, writes nothing). It supersedes the two legacy skills
`session-open` / `session-close`. This file is the thin router: mode dispatch, the bare-invocation
state check, and the two small mode bodies (`save`, `info`) live here inline. `open` and `close` are
the large/heavy modes — their bodies live in sibling files, loaded ONLY when that mode runs (same
progressive-disclosure shape as `tpm-workflow`'s `modes-*.md` split):

| Mode | Aliases | Body |
|---|---|---|
| **`open`** | start, begin, boot | [`modes-open.md`](./modes-open.md) |
| **`close`** | end, finish, wrap | [`modes-close.md`](./modes-close.md) |
| **`save`** | write, store, checkpoint, snapshot, record, note | inline, below |
| **`info`** | status, current, which, where, show | inline, below |

## Tools this skill calls (promoted paths)

- `node ${TPM_HOME}/tools/session/lib/config.js --sessions-dir` — resolves the configured sessions directory
  (`.claude/claude-tpm/config.json` → `session.notes.sessionsDir`, defaulting to
  `claude-context/sessions` for this library).
- `node ${TPM_HOME}/tools/session/lib/current-session.js --sessions-dir <dir> [--state|--open|--seal|--next-number]`
  — the current-session pointer (open-vs-not-opened; allocates the next `session-NNN`).
- `node ${TPM_HOME}/tools/session/session-notes.js --sessions-dir <dir> <verb> [args]` — the notes WRITE API
  (`resume`/`open add|done`/`log`/`decide`/`seal`). See its header docstring / `<tool>.md`.
- `node ${TPM_HOME}/tools/session/session-review.js --sessions-dir <dir> --last N [...]` — the notes READ API.

All four are self-contained (`${TPM_HOME}/tools/session/`, zero shared imports with `${TPM_HOME}/tools/workflow/` or
`${TPM_HOME}/tools/child-session/`, per `tool-conventions.md` Part I §2). Run every invocation from the project
root — every flag above is a real CLI flag, not a placeholder.

## Config gate

Read `session.enabled` (the whole skill) and `session.notes.enabled` (just the notes-writing
behavior) via `lib/config.js --json`. `session.enabled: false` ⇒ this skill short-circuits with a
one-line "session lifecycle disabled by config" message and does nothing else. `notes.enabled:
false` ⇒ `open`/`close`/`save` still run their non-notes steps (reading chain, reap, MOTD, sign-off)
but skip every notes write — no `session-notes.js` call happens at all.

## Interpreting the mode token (forgiving)

1. **Normalize** — lower-case, collapse whitespace, strip punctuation.
2. **Intent-match** — the aliases table above; obvious misspellings still resolve (`opn`, `clos`,
   `stat`, `sav`).
3. **Confidence gate** — resolve only when confident. Empty/ambiguous/unmatched arg → show the mode
   table and stop; do NOT guess. A "reap"-shaped input (reap, clean up strays, kill, sweep) redirects
   to `/tpm-reap` directly — there is no `tpm-session reap` mode (would be a redundant second name for
   the same skill).
4. **Echo before acting** — `Reading "<arg>" as → mode: <mode>` so a mis-parse is a visible line to
   correct before anything runs.

## Bare invocation — state-aware default

**Bare `tpm-session` (no argument) is NOT an error and does NOT show the mode table.** Resolve it by
calling `current-session.js --state` (after config confirms `session.enabled`):

- `state: "not-opened"` → run **`open`**.
- `state: "open"` → run **`save`**.

This is the exact mechanism [`modes-open.md`](./modes-open.md) and `save` (below) already use to
detect their own current session — bare invocation costs nothing extra, it just decides which of the
two to run first.

## Universal rule — every mode prints the session # LAST

Whatever the mode does, the **final** line it emits is the info footer (see `info`, below) — so every
`tpm-session` invocation ends with an unmistakable "you are in session NNN" line. `open`'s footer
comes after its whole reading-chain sequence; `close`'s after reap/notes/export; `save`/`info` end
there directly.

---

## `save` (inline)

1. Resolve `sessionsDir` (`lib/config.js --sessions-dir`) and confirm a session is open
   (`current-session.js --state`). **If not open, say so and run `open` instead** — `save` never
   silently opens a session on its own; that's bare invocation's job, not an explicit `save`'s.
2. If `session.notes.enabled` is false: skip to step 4 with a one-line "notes disabled by config"
   note instead of a save summary.
3. Compose the update — this is judgment work, not mechanical: decide what belongs in `## RESUME`
   (rewrite in place via `resume --where … --next … [--in-flight …]`), what's a new/completed open
   item (`open add`/`open done`), what's a decision worth landmarking (`decide … --why …`), and what's
   simply a log line for the record (`log --status <TAG> …`). A save is a **coherent latest-state
   synthesis**, not a mechanical dump — write RESUME like you're leaving a note for a cold resume, not
   transcribing the turn.
4. Print the `info` block (below) so a save always shows where it landed.

**Update, not append semantics:** repeated `save`s in one session keep rewriting the SAME
`session-NNN`'s `## RESUME` (via `resume`, which overwrites in place) — never spawn a new session
number. Only `open` allocates a new number.

## `info` (inline, writes nothing)

Resolve and print, in order:
1. Current session number + folder path (via `current-session.js --state`; "no session open yet" if
   `state: not-opened`).
2. Whether `session-notes.md` exists for it yet, and roughly when it was last modified.
3. Total session count (`ls claude-context/sessions/session-*/ | wc -l`-shaped — or read
   `session-review.js`'s session listing).
4. The real Claude Code sessionId if `$CLAUDE_CODE_SESSION_ID` is readable (best-effort — see
   `${TPM_HOME}/tools/session/lib/current-session.js`'s docstring on why this is diagnostic-only, not load-bearing).

This IS the universal footer every other mode ends with — `open`/`close`/`save` all call this same
rendering as their last step, they just have more state to report first.
