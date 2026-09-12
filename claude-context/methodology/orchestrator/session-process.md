<!-- STAGED — apply where: claude-context/methodology/orchestrator/session-process.md (NEW file — was
     confirmed MISSING on disk despite being referenced by live CLAUDE.md and methodology/README.md;
     this promotion also fixes that dangling reference). See findings/promote/PROMOTION-CHECKLIST.md. -->

# Session Notes Process

This document defines how Claude keeps continuity across sessions using the
`claude-context/sessions/` folder — and it is now a MECHANISM doc, not a set of manual steps: the
`tpm-session` skill + `tools/session/` own the actual work described below. Read this to understand
what happens, not as instructions to execute by hand.

## On start (boot)

`tpm-session open` (see `.claude/skills/tpm-session/modes-open.md`):
1. Allocates or confirms the current session via `tools/session/tpm-session-current.js --open`
   (idempotent — reuses the current session's number if one is already open this session).
2. Loads the notes from the HIGHEST-numbered `claude-context/sessions/session-NNN/` folder — checking
   `session-notes.md` first, falling back to `notes.md` for the legacy pre-tool sessions (001–007).
   That is the "previous session" — it carries forward context, decisions, and open threads. If no
   session folders exist yet, there is no prior context; start fresh.

## During a session

Checkpoint with `tpm-session save` (or bare `tpm-session` once a session is already open) whenever
there's a coherent state worth capturing — RESUME rewritten in place, open items added/closed,
decisions landmarked, log lines appended. See
`claude-context/methodology/session-notes-format.md` for exactly what belongs where (the two-zone
rule: state is rewritten in place, the log is append-only).

## When asked to store / checkpoint session notes

**This is now `tpm-session save`, not a manual "create a new numbered folder" step.**

1. `save` resolves the CURRENT session (the one `open` established this session, via the pointer at
   `<sessionsDir>/.current-session.json`) — it does **NOT** create a new folder on every save. Repeated
   saves within one session update the SAME `session-NNN/session-notes.md`.
2. A genuinely NEW session (no session currently open — e.g. a fresh `tpm-session open`, or the prior
   session's pointer was closed by `seal`) allocates the NEXT number: highest existing `session-NNN` +
   1, zero-padded to three digits. This still holds the old numbering invariant — sequential, no gaps,
   highest = most recent — it's just allocated automatically by `tools/session/tpm-session-current.js`
   instead of by hand.
3. A prior session's notes are **never** overwritten by a later one — `close`'s `seal` step marks the
   pointer closed and stamps `SEALED <date>` in the note, after which the write API refuses further
   edits without an explicit `--edit-sealed <NNN> --confirm`.

**Numbering convention (unchanged):** folders are `session-NNN`, three-digit zero-padded, sequential
with no gaps, highest number = most recent session. What changed is WHO allocates the number (the
tool, not a manual "create a new folder every time you're asked" step) and WHEN a new one is
allocated (a genuinely new session, not every `save`/`close` call within one).

## Notes contents

See `claude-context/methodology/session-notes-format.md` for the full canonical shape (`## RESUME` /
`## Open items` / `## Decisions` / `## Log`, the tokens, the two-zone discipline). In brief, a note
should always let a cold resume answer: what did the session accomplish, what decisions were made and
why, what's still open / drifting, and anything a future session needs to avoid re-deriving.

## Wrap-up

`tpm-session close` (see `.claude/skills/tpm-session/modes-close.md`) runs the reap ritual, delegates
to `save` for the final notes update, seals the session, nudges `/export`, and signs off. See that
file for the full sequence.
