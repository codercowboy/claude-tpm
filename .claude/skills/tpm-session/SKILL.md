---
name: tpm-session
description: Use at the start of a session to boot (open), to checkpoint / write session notes mid-session (save), to wrap up (close), or to check current session status (info). Bare "tpm-session" is state-aware — not yet opened this session -> open; already open -> save. Supersedes the retired session-open / session-close skills. Invoke ONLY when the user explicitly runs it (this is the orchestrator's boot) — never auto-invoke it, because a subagent must never adopt the orchestrator role by tripping this on its own.
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

- `npx tpm session config --sessions-dir` — resolves the configured sessions directory
  (`.claude/claude-tpm/config.json` → `session.notes.sessionsDir`; default
  `.claude/claude-tpm/sessions`, which this library overrides to `claude-context/sessions`).
- `npx tpm session current --sessions-dir <dir> [--state|--open|--seal|--next-number]`
  — the current-session pointer (open-vs-not-opened; allocates the next `session-NNN`).
- `npx tpm session notes --sessions-dir <dir> <verb> [args]` — the ledger WRITE API
  (`init`/`log`/`decide`/`seal`). See its header docstring / `<tool>.md`.
- `npx tpm session punchlist --sessions-dir <dir> <verb> [args]` — the open/done work items
  (`add "<text>"`/`close <n|session.n>`/`list [--all]`/`reopen <id>`/`drop <id>`). The mini task-manager.
- `npx tpm session save --sessions-dir <dir> --payload <file.json>` — the gated, linted checkpoint:
  rewrites `handoff.md` (head from payload; What-remains pulled mechanically from `punchlist.md`) and
  refreshes the wayfinding header on all three files. Exit `0` ok · `1` refused (names the field, writes
  nothing) · `2` usage/parse.
- `npx tpm session boot-read [--sessions-dir <dir>]` — the boot-time pickup emit (prior session's
  handoff + open punchlist + file locations). Pure-read; ALWAYS exits 0 (never crashes boot).
- `npx tpm session review --sessions-dir <dir> --last N [...]` — the notes READ API.

All are self-contained (`%TPM_HOME%/tools/session/`, zero shared imports with `%TPM_HOME%/tools/workflow/` or
`%TPM_HOME%/tools/child-session/`, per `tool-conventions.md` Part I §2). Run every invocation from the project
root — every flag above is a real CLI flag, not a placeholder.

## Config gate

Read `session.enabled` (the whole skill) and `session.notes.enabled` (just the notes-writing
behavior) via `tpm-session-config.js --json`. `session.enabled: false` ⇒ this skill short-circuits with a
one-line "session lifecycle disabled by config" message and does nothing else. `notes.enabled:
false` ⇒ `open`/`close`/`save` still run their non-notes steps (reading chain, reap, MOTD, sign-off)
but skip every notes write — no `tpm-session-notes.js` call happens at all.

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
calling `tpm-session-current.js --state` (after config confirms `session.enabled`):

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

Resolve `sessionsDir` (`tpm-session-config.js --sessions-dir`) and confirm a session is open
(`tpm-session-current.js --state`). **If not open, say so and run `open` instead** — `save` never
silently opens a session on its own; that's bare invocation's job, not an explicit `save`'s. If
`session.notes.enabled` is false, skip the ritual and jump to the `info` block with a one-line "notes
disabled by config" note.

Then run the **FIXED 3-step ritual** — one skill, no menu: do all three in order, every save. The
punchlist/log steps are judgment (the tool cannot know an item got done unless told); the handoff is
the mechanical gate.

1. **Reconcile the punchlist.** For each work item finished since the last save, run
   `npx tpm session punchlist --sessions-dir <dir> close <n|session.n>`; for each newly-surfaced item,
   `punchlist add "<text>"`. Use `punchlist list` to see what's still open. This is the single source of
   truth for open work — the handoff's "What remains" is rebuilt from it mechanically, so tick things
   off HERE, not in prose.
2. **Append any ledger lines.** For a decision worth landmarking, `npx tpm session notes --sessions-dir
   <dir> decide "<what>" --why "<why>"`; for a plain record line, `notes log --status <TAG> "<text>"`.
   Append-only — skip this step if nothing new is worth logging.
3. **Write the gated handoff.** Compose a small JSON payload (`where` + `next` REQUIRED, non-empty;
   `in_flight` + `must_not_redo` optional — each accepts a string OR a list of strings) and run
   `npx tpm session save --sessions-dir <dir> --payload <file.json>`. Write `where`/`next` like you're
   leaving a note for a cold resume, not transcribing the turn. Handle the exit code:
   - **exit 1 (refused, hard error):** the payload failed the lint and **nothing was written** — the
     message names the offending field (e.g. `save refused — 'next' is required`). Fix that field and
     re-run; do NOT proceed as if the save landed.
   - **exit 2 (usage/parse):** a bad flag or unreadable/invalid JSON payload — fix the invocation, not
     the content, and re-run.
   - **exit 0 (success):** the handoff was rewritten and all three headers refreshed. The tool may also
     print a soft advisory you must reckon with (it does NOT block): the **still-open NUDGE**
     (`still open: #20.1 #20.3 — close any that are done`) means those items are carried forward — if any
     are actually done, close them (step 1) and re-save; and the **empty-punchlist warning**
     (`⚠ punchlist has 0 open items and none were added — is that intended?`) means the save recorded no
     open work, which is fine for a genuine "just snapshot progress" save but worth a second look.
4. Print the `info` block (below) so a save always shows where it landed.

**Rewrite, not append semantics:** repeated `save`s in one session keep rewriting the SAME
`session-NNN`'s `handoff.md` (wholesale each time; the ledger and punchlist are append/mark-only) —
never spawn a new session number. Only `open` allocates a new number.

## `info` (inline, writes nothing)

Resolve and print, in order:
1. Current session number + folder path (via `tpm-session-current.js --state`; "no session open yet" if
   `state: not-opened`).
2. Whether `session-notes.md` exists for it yet, and roughly when it was last modified.
3. Total session count (`ls <sessions-dir>/session-*/ | wc -l`-shaped, over the resolved sessions dir — or read
   `tpm-session-review.js`'s session listing).
4. The real Claude Code sessionId if `$CLAUDE_CODE_SESSION_ID` is readable (best-effort — see
   `%TPM_HOME%/tools/session/tpm-session-current.js`'s docstring on why this is diagnostic-only, not load-bearing).

This IS the universal footer every other mode ends with — `open`/`close`/`save` all call this same
rendering as their last step, they just have more state to report first.
