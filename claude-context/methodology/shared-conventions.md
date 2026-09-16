# Shared conventions

Module-agnostic conventions both the orchestrator and subagents follow: default communication style, when
to grep vs. full-read. These hold regardless of which claude-tpm modules are enabled.

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

## Documentation deliverables — voice & anti-pattern check

When a round delivers **prose** for humans (a README, a guide, any human-facing doc), writing
quality is part of the definition of done — and the verifier gets an explicit **voice remit**: read
the delivered doc against the **consuming project's own writing-style + anti-pattern guidance** (if
it has a house voice / "tells to avoid" doc), and flag off-voice phrasing and generic LLM-tells —
meta-editorializing ("the interesting part"), over-hedged sincerity ("basically / honestly"), the
"not just X — it's Y" reframe, em-dash overuse — for removal before the doc is promoted. Pull those
out of the delivered document; don't ship them.

claude-tpm ships **no house voice of its own** (it's project-agnostic) — this convention is the
*hook* that lets a consuming project enforce theirs. Absent such a guide, the verifier still flags
obvious LLM-isms.

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
