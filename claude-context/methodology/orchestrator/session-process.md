# Session Notes Process

This document defines how Claude keeps continuity across sessions using the configured sessions dir
(`session.notes.sessionsDir`; default `.claude/claude-tpm/sessions`, which this library overrides to
`claude-context/sessions`) — and it is a MECHANISM doc, not a set of manual steps: the `tpm-session`
skill + `tools/session/` own the actual work described below. Read this to understand what happens,
not as instructions to execute by hand.

Each session's memory now lives in **three files** in its `session-NNNN/` folder —
`session-NNNN-handoff.md`, `session-NNNN-punchlist.md`, and `session-NNNN-log.md` (the ledger, renamed
from `session-notes.md`). Every file is prefixed with the four-digit session number and opens with a
`tpm-session-version: 1.0` preamble; the tools read ONLY files carrying that preamble (no back-compat,
no `metadata.json`). See `claude-context/methodology/session-notes-format.md` for the full shape of each;
this doc covers the lifecycle around them.

## On start (boot)

`tpm-session open` (see `.claude/skills/tpm-session/modes-open.md`):
1. Allocates or confirms the current session via `tools/session/tpm-session-current.js --open`
   (idempotent — reuses the current session's number if one is already open this session; it does NOT
   create a `session-NNNN` folder).
2. Runs `tools/session/tpm-session-boot-read.js` to pull the PRIOR session's state into context. This is
   a **tool call, not the model choosing to open a file** — its stdout is the pickup payload. Because it
   runs after step 1's `--open`, it excludes the just-opened current session and iterates the priors
   descending, emitting the highest that reads as `tpm-session-version: 1.0`:
   - **v1.0 prior session:** the prior `session-NNNN-handoff.md` verbatim + its open punchlist items +
     the three prefixed file locations + the "log reads bottom-to-top" reminder.
   - **Pre-v1.0 / unversioned prior session:** IGNORED — boot-read skips it and keeps looking; it does
     not parse it or point at it (the old point-at-path tier was removed; no back-compat, no migration).
   - **No v1.0 prior session:** a clean "no prior session found — this looks like the first session" line.
   `boot-read` **always exits 0** — it can never crash boot.

## During a session

Checkpoint with `tpm-session save` (or bare `tpm-session` once a session is already open) whenever
there's a coherent state worth capturing. The punchlist and ledger verbs are **live** — usable any time,
not just at save: `punchlist add`/`close` as work items surface and finish, `notes log`/`notes decide`
as decisions and record-worthy events happen. `save` then snapshots the handoff and reconciles the
headers. See `session-notes-format.md` for exactly what belongs where.

## What `save` does — the gated 3-step ritual

**This is `tpm-session save`, not a manual "create a new numbered folder" step.** The skill body is a
FIXED 3-step ritual — one skill, no menu, so it reads as "do all three," not a set of options:

1. **Reconcile the punchlist.** `punchlist close <slug|id>` for finished items; `punchlist add "<text>"`
   for newly-surfaced ones. To pull forward a prior session's unfinished work, `punchlist carry <slug>`
   copies it into the current punchlist as OPEN; a prior-session `punchlist close <slug>` records a DONE
   copy forward — both preserve the origin number + slug + text and never edit the sealed source (#1093).
   Every one of these ops is also written to `session-NNNN-log.md`'s `## Log`, so the ledger carries a
   human-readable trail of the reconcile without any extra step. This punchlist is the single source of
   truth for open work — the handoff's "What remains" is rebuilt from it mechanically.
2. **Append any ledger lines.** `notes decide "<what>" --why "<why>"` for a landmarked decision; `notes
   log --status <TAG> "<text>"` for a record line. Append-only; skip if nothing new is worth logging.
3. **Write the gated handoff.** Compose a small JSON payload (`where` + `next` REQUIRED and non-empty;
   `in_flight` + `must_not_redo` optional) and run `save --payload <file.json>`. This is the mechanical
   gate — the one thing always true of a save is that `session-NNNN-handoff.md` is rewritten complete.

The tool talks back via exit code AND a message:
- **exit 1 — refused (hard error):** the payload failed the lint; **nothing was written**; the message
  names the offending field (e.g. `save: refused — "next" is required …`). Fix and re-run.
- **exit 2 — usage/parse:** a bad flag or unreadable/invalid JSON payload. Fix the invocation, re-run.
- **exit 0 — success:** `session-NNNN-handoff.md` rewritten, all three headers refreshed. `save` may also print a soft
  advisory that does NOT block — the **still-open NUDGE** (`still open: #1.1 …`, meaning those items are
  carried forward — close any that are actually done and re-save) or the **empty-punchlist warning**
  (`⚠ punchlist has 0 open items and none were added — is that intended?`). A warning confronts, it does
  not gate: a legitimate "just snapshot the progress so far" save still succeeds.

The gate lives on the handoff because that is the one thing that must be complete for pickup to be
reliable. The punchlist and ledger writes are judgment (the tool cannot know an item got done unless
told), so they are ritual + nudge, never a mechanical requirement that would false-fail a valid save.

## Session numbering + first save of a session

1. `save` resolves the CURRENT session (the one `open` established, via the pointer at
   `<sessionsDir>/.current-session.json`) — it does **NOT** create a new folder on every save. Repeated
   saves within one session rewrite the SAME `session-NNNN/session-NNNN-handoff.md` wholesale.
2. On the **first save of a session**, `save` creates all three files (each with a header carrying the
   `tpm-session-version: 1.0` preamble + empty sections) so any file a human opens reveals the other two.
3. A genuinely NEW session (no session currently open — a fresh `tpm-session open`, or the prior
   session's pointer was closed by `seal`) allocates the NEXT number: highest existing `session-NNNN` + 1,
   zero-padded to **four** digits, allocated automatically by `tpm-session-current.js`.
4. A prior session's files are **never** overwritten by a later one — `close`'s `seal` step marks the
   pointer closed and stamps `SEALED <date>` in `session-NNNN-log.md`, after which the write API refuses
   further edits without an explicit `--edit-sealed <NNNN> --confirm`.

**Numbering convention:** folders are `session-NNNN`, **four-digit** zero-padded, sequential
with no gaps, highest number = most recent session. Allocation still counts any surviving three-digit
`session-NNN` folder for continuity (so a workspace whose newest folder is `session-019` allocates
`0020` next, not `0001`), even though those pre-v1.0 folders are invisible to the readers. What the tool
owns is WHO allocates the number and WHEN (a genuinely new session, not every `save`/`close` within one).

## Wrap-up

`tpm-session close` (see `.claude/skills/tpm-session/modes-close.md`) runs the reap ritual, delegates to
the gated `save` for the final checkpoint (reconcile punchlist → append ledger lines → write the
handoff, honoring exit codes — a refused save wrote nothing, so fix and re-run before sealing), seals
`session-NNNN-log.md` and the session pointer, nudges `/export`, and signs off. See that file for the full
sequence.
