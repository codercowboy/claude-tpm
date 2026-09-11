# `tpm-session open` — boot the TPM engine

Loaded ONLY when `SKILL.md` resolves mode `open` (explicit `tpm-session open` or bare invocation with
no session currently open). This is the LARGE body — the whole reading-chain sequence — split out of
the router per progressive disclosure (same shape as `tpm-workflow`'s `modes-plan.md` etc).

## Purpose

`tpm-session open` boots the TPM engine: it reads config for enabled modules, loads the core reading
list + project state, surfaces available capabilities, and gates before any load-bearing work.

Booting the engine puts you in orchestrator/TPM mode for your scope. (A plain worker follows its own
`plan.md`, not this — but nested orchestration IS allowed; charter secrecy is enforced per-round by
the workflow module, not by gatekeeping who may boot.)

## Boot sequence

1. **Allocate/confirm the session.** Call `node ${TPM_HOME}/tools/session/lib/current-session.js --sessions-dir
   <dir> --open` (idempotent — if a session is already open this session, it returns the SAME number
   rather than minting a new one). This is what fixes the old "every close mints a new folder" bug:
   the folder is established HERE, once, and `save`/`close` only ever update it.

2. **Read config** — `.claude/claude-tpm/config.json` via `${TPM_HOME}/tools/session/lib/config.js --json`
   (session section) and the project's other module resolvers as needed → which modules are enabled.
   This decides what else loads below.

3. **Walk the core reading list** — the orchestrator reading-list manifest
   (`${TPM_HOME}/claude-context/methodology/orchestrator/reading-list.md`) is the single source of truth. Read it
   FRESH (it evolves), walk its Tier-1 in order; do not paraphrase from memory. (`CLAUDE.md` is
   harness-auto-injected context, not a thing you "read" as a step here.)

4. **Load project state — module-gated:**
   - **Latest session notes** (only if `session.notes.enabled`): the HIGHEST-numbered
     `claude-context/sessions/session-NNN/` folder — check for `session-notes.md` first (008+, this
     build's canonical format), falling back to `notes.md` if absent (001–007, the legacy freeform
     format — read it as prose, it predates the tool). This is your "previous session" — it carries
     forward decisions and open threads. If no session folders exist, start fresh.
   - **The task queue** (only if `tasks` module enabled): blocking breadcrumbs and queued work.

5. **Surface capabilities — the open MOTD** (gated by `session.showTPMOpenMessage`): list the
   **ENABLED** `tpm-*` skills with one-liners — the "here's what you can reach for" menu, e.g.
   `tpm-session → save session notes` · `tpm-task → task management` · `tpm-workflow → run a
   workflow` · `tpm-reap → clean up strays`. Only enabled modules appear. Then the consumer's
   `session.additionalOpenMessage` file content, if set, appended AFTER.

6. **Print the session #** — the universal `tpm-session` footer (`SKILL.md`'s `info` block:
   "you are in session NNN").

## In a consumer project

If running inside a consumer project (not claude-admin/claude-tpm itself), the consumer's config +
supplements drive, resolved via the `<!-- include: claude-tpm -->` splice. Details: the extensibility
model. If the wiring is unclear, **ASK** — don't invent a resolution mechanism.

## Rules

- **If a task was already dropped this session**, read the docs relevant to it first, then backfill
  the rest as you go. Don't stall on reading if there's actionable work — but the module-gated
  pre-flight gates each module still owns (e.g. the workflow module's self-quiz, if that module is
  in play) still apply before anything load-bearing in that module.
- **Don't skip the reading chain silently.** If you're mid-turn and realize you skipped a step, say so
  and read it before proceeding.
- **A subagent must never run this skill.** A worker is spawned with a tight prompt pointed at the
  SUBAGENT reading list (`${TPM_HOME}/claude-context/methodology/subagent/reading-list.md`) — a different, smaller
  chain that withholds orchestrator-only material. If you were spawned as a subagent and somehow
  reached this file, STOP and follow your spawn prompt instead.

## What this step does NOT do (moved elsewhere, not silently dropped)

- **The self-quiz** — relocated to the workflow module's pre-flight gate (fires before spawn/plan/
  scaffold, not at boot).
- **Drift detection** (methodology docs unreachable from a reading list; operational paths named but
  missing on disk) — moved to the hygiene checklist (`${TPM_HOME}/claude-context/methodology/hygiene/checks.md`
  check #23), run on a periodic sweep, not every boot.
- **The CLAUDE.md-vs-skill tiebreaker** — obsolete: the reading-list manifest is the single source of
  truth and this skill no longer duplicates its content, so there is nothing left to disagree with.
