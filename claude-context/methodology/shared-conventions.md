# Shared conventions

Module-agnostic conventions both the orchestrator and subagents follow: default communication style, when
to grep vs. full-read. These hold regardless of which claude-tpm modules are enabled.

> **⚠️ Carve note (2026-08-27).** The round-specific conventions that used to live here — "your charter
> governs your round", the **resumption protocol / `findings/HANDOFF.md`** format, the **findings-doc**
> format, and the **acceptance-test catalog** — were `workflow`-module machinery and have been **carved out
> to the workflow module** (staged at `tmp/workflow-redesign/legacy/docs/shared-conventions.md` until the
> module is built). Per the **module-opacity principle** ([`./overview.md`](./overview.md) §"Module
> opacity"), a project with `workflow` disabled shouldn't read round machinery here.

> **Reading order on first encounter:**
> - **Orchestrator:** see [`reading-list.md`](./orchestrator/reading-list.md).
> - **Subagent** (when the `workflow` module is enabled): see [`reading-list.md`](./subagent/reading-list.md)
>   — base chain plus the conditional blocks for the spawn flavor.

---

## Default communication style — terse

Default to **terse** status updates: one-sentence "what changed and what's next" per turn. Detailed
reasoning goes into durable docs, not chat. Verbose / narrative communication is opt-in — if a task is
exploratory or the user wants the walk-through, it's stated explicitly. Otherwise: terse by default.

Specifically:
- End-of-turn summary = 1-2 sentences max.
- Don't recap what's in a doc you just wrote.
- State decisions directly; skip "I will now…" preambles before tool calls.
- Long tables and itemizations are fine when surfacing options for the user to pick from; otherwise prefer
  a prose-bullet hybrid.

Applies equally to subagent output reports.

---

## When stuck or blocked

See [`./troubleshooting.md`](./troubleshooting.md) — what to try before declaring a dead-end (static
analysis, manual/external escalation) and disaster recovery.

---

## Tools conventions

All tool-related conventions — the read-before-building rule, the copy-then-modify pattern for forking
project-level tools, the "build reusable tools by default" bar, the no-hardcoded-paths directive, and the
tool-feedback conventions — live in [`./tool-conventions.md`](./tool-conventions.md). Every actor that
touches tooling reads it.

---

## Reading heuristics — when to grep vs when to read fully

**Default: grep-and-skim** for big reference docs. Use specific search terms to locate relevant sections,
read only those in full.

**Force full-read** in these cases:
- **First-encounter docs** — when reading something for the first time, read all of it so caveats and
  open-questions don't get missed. Subsequent visits can grep.
- **The methodology docs themselves** (and your project's `CLAUDE.md`, if it has one) — read fully at session open / first spawn. They're the
  rules of the road; missing a section means missing a rule.
- **Any doc you're about to cite as authoritative** in a finding or report. Don't claim it says X without
  confirming it.

Skim-and-grep is fine for: code lookups, "where does symbol X live", locating a known routine, sampling
session notes for one specific event.

**Reach for existing tools before hand-work.** When a question is shaped like something a project tool
already answers, check for that tool first — see [`./tool-conventions.md`](./tool-conventions.md).

---

## Reading-order recap

- **Orchestrator:** see [`reading-list.md`](./orchestrator/reading-list.md).
- **Subagent** (workflow module enabled): see [`reading-list.md`](./subagent/reading-list.md) — base chain
  plus the conditional blocks for the spawn flavor.
