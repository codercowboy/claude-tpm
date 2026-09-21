# `tpm-session open` — boot the TPM engine

## Purpose

`tpm-session open` boots the TPM engine: it reads config for enabled modules, loads the core reading
list + project state, surfaces available capabilities, and gates before any load-bearing work.

**You are the ORCHESTRATOR for this scope.** Booting the engine adopts the orchestrator/TPM role: you
drive the multi-agent system — walking the orchestrator reading list, holding project state, and
directing subagents — rather than doing scoped worker tasks yourself. (A plain worker follows its own
`plan.md`, not this — but nested orchestration IS allowed; charter secrecy is enforced per-round by
the workflow module, not by gatekeeping who may boot.)

## Boot sequence

1. **Allocate/confirm the session.** Call `npx tpm session current --sessions-dir
   <dir> --open` (idempotent — if a session is already open this session, it returns the SAME number
   rather than minting a new one). This is what fixes the old "every close mints a new folder" bug:
   the folder is established HERE, once, and `save`/`close` only ever update it.

2. **Read config** — get the module-enablement map with `npx tpm session config --modules`. It
   returns a JSON object of every module's ENABLED state, e.g.
   `{ "session": true, "workflow": true, "tasks": true, "hygiene": false }` (every module is ON by
   default; a section is disabled only when its `enabled` is explicitly `false`). This one call
   decides what loads below (step 4) and what the MOTD lists (step 5) — you no longer hand-read raw
   `config.json` for enablement. For the resolved *session* section specifically (notes dir, MOTD
   flags), use `npx tpm session config --json`. The reader is lenient: a malformed config never
   crashes boot (it degrades to all-enabled + a warning) — surfacing a malformed config is the
   doctor's job (`npx tpm install --check`), not boot's.

3. **Walk the core reading list** — fetch the orchestrator reading-list manifest with
   `npx tpm doc claude-context/methodology/orchestrator/reading-list.md` (it prints the doc with the
   bundle path resolved). It is the single source of truth — read it FRESH (it evolves), walk its Tier-1
   in order; do not paraphrase from memory. (`CLAUDE.md` is
   harness-auto-injected context, not a thing you "read" as a step here.)

4. **Load project state — module-gated:**
   - **Prior session pickup** (only if `session.notes.enabled`): call `npx tpm session boot-read`
     (it self-resolves the sessions dir via `npx tpm session config --sessions-dir`; pass
     `--sessions-dir <dir>` explicitly if you already resolved it). This runs AFTER step 1's
     `current --open`, so it emits the highest **PRIOR** session (never the just-opened current one):
     its `handoff.md` verbatim (READ IT FULLY — where we are, next action, what NOT to redo), its open
     `punchlist.md` items (what remains), the three file locations, and the reminder that the notes log
     reads bottom-to-top. This is your "previous session" pickup — pulled into context by the tool, not
     by you choosing which file to open. It degrades gracefully (old/partial/unrecognized prior session
     → points at the path to read directly) and **always exits 0** — it never crashes boot. If it
     reports no prior session, start fresh.
   - **The task queue** (only if `tasks` module enabled): blocking breadcrumbs and queued work.

5. **Surface capabilities — the open MOTD** (gated by `session.showTPMOpenMessage`): list the
   **ENABLED** `tpm-*` skills with one-liners — the "here's what you can reach for" menu, e.g.
   `tpm-session → save session notes` · `tpm-task → task management` · `tpm-workflow → run a
   workflow` · `tpm-reap → clean up strays`. Only enabled modules (from step 2's `--modules` map)
   appear. The `workflow` module fronts several skills (`tpm-workflow`, `tpm-spawn`,
   `tpm-spawn-team`, `tpm-reap`) — list the ones relevant to the menu. **`hygiene` is ON by default
   in config but ships no `tpm-hygiene` skill yet — do NOT list it** until the module is built.
   Then the consumer's `session.additionalOpenMessage` file content, if set, appended AFTER.

6. **Print the session #** — the universal `tpm-session` footer (`SKILL.md`'s `info` block:
   "you are in session NNN").

## In a consumer project

If running inside a consumer project (not claude-tpm itself), the consumer's config +
supplements drive, resolved via the `<!-- include: claude-tpm -->` splice. Details: the extensibility
model. If the wiring is unclear, **ASK** — don't invent a resolution mechanism.

## Rules

- **If a task was already dropped this session**, read the docs relevant to it first, then backfill
  the rest as you go. Don't stall on reading if there's actionable work — but the module-gated
  pre-flight gates each module still owns (e.g. the workflow module's pre-flight gate, if that module is
  in play) still apply before anything load-bearing in that module.
- **Don't skip the reading chain silently.** If you're mid-turn and realize you skipped a step, say so
  and read it before proceeding.

## What this step does NOT do (moved elsewhere, not silently dropped)

- **The pre-flight gate** — the workflow module walks the pre-task questions
  (`%TPM_HOME%/claude-context/methodology/orchestrator/pre-task-questions.md`) before spawn/plan/
  scaffold, not at boot.
- **Drift detection** (methodology docs unreachable from a reading list; operational paths named but
  missing on disk) — planned for the hygiene module (enabled in config by default, but not yet built —
  no `hygiene/` methodology docs ship yet), to run on a periodic sweep rather than every boot.
- **The CLAUDE.md-vs-skill tiebreaker** — obsolete: the reading-list manifest is the single source of
  truth and this skill no longer duplicates its content, so there is nothing left to disagree with.
