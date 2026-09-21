---
name: tpm-session
description: Use at the start of a session to boot (open), to checkpoint / write session notes mid-session (save), to wrap up (close), or to check current session status (info). Bare "tpm-session" is state-aware — not yet opened this session -> open; already open -> save. Supersedes the retired session-open / session-close skills. Invoke ONLY when the user explicitly runs it (this is the orchestrator's boot) — never auto-invoke it, because a subagent must never adopt the orchestrator role by tripping this on its own.
---

> In this file, `%TPM_HOME%` is the claude-tpm **installation home** — it is NOT always
> `<project>/node_modules/@codercowboy/claude-tpm`. If you need its actual value, run `npx tpm resolve-home`.

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
  `.claude/claude-tpm/sessions`, which this library overrides to `claude-context/sessions`). Also
  `--json` (whole `session` section), `--get <dotted.key>`, and `--modules` (the cross-module ENABLED
  map for the boot MOTD).
- `npx tpm session current --sessions-dir <dir> [--state|--open|--seal|--next-number]`
  — the current-session pointer (open-vs-not-opened; allocates the next `session-NNNN`; `--open` is
  idempotent, `--seal` marks the pointer closed).
- `npx tpm session <verb> --sessions-dir <dir> --session <NNNN> [args]` — the notes WRITE surface.
  These write verbs are TOP-LEVEL session verbs (the old `ops` grouping was flattened away — call each
  directly). One canonical `session-NNNN.json` + a derived `session-NNNN.md`; every write is atomic and
  the `.md` is regenerated from the JSON. Verbs:
  - `open --session-id <id> [--tpm-version v] [--prior-session-path <json>]` — mint the session record.
  - `note (--log --status <TAG> --text "<text>" | --decision --what "<what>" --why "<why>")` — the
    append-only ledger.
  - `punchlist --action add|close|reopen|drop|carry-in` — the open/done work items (`add --text "…"
    [--slug s]`; `close/reopen/drop --item <id|slug>`; `carry-in --from <prior json> --item <id|slug>`).
    There is **no `list`** — read open items from the derived `.md` `## Punchlist` section or `export`.
  - `import-handoff (--json-file <f> | --txt-file <f> --next "…"|--next-file <f> [--in-flight "…"]…
    [--must-not-redo "…"]…)` — REPLACE the handoff. Fails loud (exit `1`) if the required `next` is
    absent or the JSON is unreadable; success writes the JSON + `.md`.
  - `save` — re-persist + re-render the current record (no content args).
  - `close` — the seal: **REFUSES (exit `1`, naming what's missing) unless a handoff AND at least one
    punchlist item are present**; otherwise stamps `meta.closedAt`.
  - `import-log` / `import-punchlist` — file-based append/add (`#1115`).
- `npx tpm session boot-read [--sessions-dir <dir>]` — the boot-time pickup emit (prior session's
  handoff verbatim + open punchlist headlines + the JSON/`.md` file locations). Pure-read; ALWAYS
  exits 0 (never crashes boot); a missing/corrupt/unknown-schema prior session degrades to one clean line.
- `npx tpm session export --sessions-dir <dir> (--last N | --session NNNN[,NNNN]) --style json|human|both`
  — the notes READ API (default `--style json` to stdout; pass `--out <dir|file>` to write a file).

All are self-contained (`%TPM_HOME%/tools/session/`, zero shared imports with `%TPM_HOME%/tools/workflow/` or
`%TPM_HOME%/tools/child-session/`, per `tool-conventions.md` Part I §2). Run every invocation from the project
root — every flag above is a real CLI flag, not a placeholder.

## Config gate

Read `session.enabled` (the whole skill) and `session.notes.enabled` (just the notes-writing
behavior) via `npx tpm session config --json`. `session.enabled: false` ⇒ this skill short-circuits with a
one-line "session lifecycle disabled by config" message and does nothing else. `notes.enabled:
false` ⇒ `open`/`close`/`save` still run their non-notes steps (reading chain, reap, MOTD, sign-off)
but skip every notes write — no `session open`/`save`/`note`/`punchlist`/`close`/`import-*` write happens at all.

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
calling `npx tpm session current --state` (after config confirms `session.enabled`):

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

Resolve `sessionsDir` (`npx tpm session config --sessions-dir`) and confirm a session is open
(`npx tpm session current --state`). **If not open, say so and run `open` instead** — `save` never
silently opens a session on its own; that's bare invocation's job, not an explicit `save`'s. If
`session.notes.enabled` is false, skip the ritual and jump to the `info` block with a one-line "notes
disabled by config" note.

Then run the **FIXED 3-step ritual** — one skill, no menu: do all three in order, every save. The
punchlist/log steps are judgment (the tool cannot know an item got done unless told); the handoff is
the mechanical gate.

1. **Reconcile the punchlist.** For each work item finished since the last save, run
   `npx tpm session punchlist --sessions-dir <dir> --session <NNNN> --action close --item <id|slug>`;
   for each newly-surfaced item, `session punchlist --action add --text "<text>"`. There is no `list` verb —
   read what's still open from the derived `session-NNNN.md` `## Punchlist` section (or `export`). This
   is the single source of truth for open work — the handoff's "In flight" carries it forward, so tick
   things off HERE, not in prose.
2. **Append any ledger lines.** For a decision worth landmarking, `npx tpm session note --sessions-dir
   <dir> --session <NNNN> --decision --what "<what>" --why "<why>"`; for a plain record line,
   `session note --log --status <TAG> --text "<text>"`. Append-only — skip this step if nothing new is worth logging.
3. **Write the handoff, then persist.** Replace the handoff with `npx tpm session import-handoff
   --sessions-dir <dir> --session <NNNN>` — either `--json-file <f>` (a handoff object, or a full record
   whose `.handoff` is extracted) or `--txt-file <f> --next "<next>" [--in-flight "…"]… [--must-not-redo
   "…"]…` (the text file becomes `where`; `next` is required and cannot be invented). Write `where`/`next`
   like you're leaving a note for a cold resume, not transcribing the turn. Then `session save` re-persists
   and re-renders the record. Handle the exit code:
   - **exit 1 (refused):** `import-handoff` fails loud when the required `next` is missing/empty or the
     JSON is unreadable — **nothing was written**; the message names what's wrong. Fix and re-run; do
     NOT proceed as if the handoff landed.
   - **exit 0 (success):** the canonical `session-NNNN.json` was written and the derived `session-NNNN.md`
     regenerated from it.
4. Print the `info` block (below) so a save always shows where it landed.

**Rewrite, not append semantics:** `import-handoff` REPLACES the handoff wholesale each time (the ledger
and punchlist are append/mark-only); repeated `save`s in one session keep updating the SAME
`session-NNNN` record — never spawn a new session number. Only `open` (via `current --open`) allocates
a new number.

## `info` (inline, writes nothing)

Resolve and print, in order:
1. Current session number + folder path (via `npx tpm session current --state`; "no session open yet" if
   `state: not-opened`).
2. Whether the `session-NNNN.json` (+ derived `session-NNNN.md`) exists for it yet, and roughly when it
   was last modified.
3. Total session count (`ls <sessions-dir>/session-*/ | wc -l`-shaped, over the resolved sessions dir — or read
   `tpm session export`'s listing).
4. The real Claude Code sessionId if `$CLAUDE_CODE_SESSION_ID` is readable (best-effort — see
   the current-session pointer tool's docstring — `npx tpm session current` — on why this is diagnostic-only, not load-bearing).

This IS the universal footer every other mode ends with — `open`/`close`/`save` all call this same
rendering as their last step, they just have more state to report first.
