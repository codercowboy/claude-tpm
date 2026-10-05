<!-- tpm:if !session.enabled -->
tpm-session is disabled by config (`session.enabled: false`) — say "session lifecycle disabled by config" and do nothing else.
<!-- tpm:endif -->
<!-- tpm:if session.enabled -->
## `tpm-session open` — boot the TPM engine

**You are the ORCHESTRATOR for this scope.** Booting the engine adopts the orchestrator/TPM role: you drive the multi-agent system — walking the orchestrator reading list, holding project state, and directing subagents — rather than doing scoped worker tasks yourself. **A subagent must never run this skill:** if you were spawned as a subagent, STOP and follow your spawn prompt + `plan.md` instead.

Boot sequence — do these in order:

1. **Allocate/confirm the session.** Run `tpm session current --open` (idempotent — if a session is already open it returns the SAME number rather than minting a new one). The folder is established HERE, once; `save`/`close` only ever update it.

2. **Walk the core reading list.** Run `tpm reading-list orchestrator`. It prints a leading `tpm resolve-home` line, then one ready-to-run `tpm doc <bundle-relpath>` line per Tier-1 doc, in order. Run those emitted lines top to bottom and read each doc. Take the chain FRESH every boot; do not paraphrase from memory. (`CLAUDE.md` is harness-auto-injected, not a step here.)
<!-- tpm:inject reading-extras -->

3. **Load project state — module-gated:**
<!-- tpm:if session.notes.enabled -->
   - **Prior session pickup:**

<!-- tpm:inject pickup -->

     Read the handoff FULLY — where we are, next action, what NOT to redo. If it reports no prior session, start fresh. (`tpm session boot-read` always exits 0 and never crashes boot.)
<!-- tpm:endif -->
<!-- tpm:if tasks.enabled -->
   - **The task queue:** blocking breadcrumbs and queued work (`tpm task list`).
<!-- tpm:endif -->

<!-- tpm:if session.showTPMOpenMessage -->
4. **Surface capabilities — the open MOTD.** Show the user this menu:

<!-- tpm:inject motd -->

<!-- tpm:inject additional -->
<!-- tpm:endif -->

5. **Print the footer** (below). It is the LAST thing you emit.

<!-- tpm:inject footer -->

Rules:
- If a task was already dropped this session, read the docs relevant to it first, then backfill the rest as you go. Don't stall on reading if there is actionable work — but the module-gated pre-flight gates each module owns (e.g. the workflow module's pre-flight gate) still apply before anything load-bearing in that module.
- Don't skip the reading chain silently. If you realize mid-turn you skipped a step, say so and read it before proceeding.
- In a consumer project, the consumer's config + supplements drive. If the wiring is unclear, ASK — don't invent a resolution mechanism.

Tools for this mode: `tpm session config --json` (resolved session section; `--get <dotted.key>`; `--modules` = the ENABLED map of every module), `tpm session current --state|--open`, `tpm session boot-read`, `tpm reading-list orchestrator`.

<!-- tpm:inject tools-common -->
<!-- tpm:endif -->
