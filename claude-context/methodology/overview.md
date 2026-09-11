# claude-tpm — what it is & the opt-in activation model

> **Design north star.** This describes the TARGET shape of claude-tpm — a modular, opt-in framework.
> Some modules are still being built and the `claude-admin` → `claude-tpm` rename is pending, so read
> this as the directional vision the build serves, not a description of shipped reality. Mechanism
> lives in [`../dev/framework-config-design.md`](../dev/framework-config-design.md); this doc is the
> "what & why."

## What TPM is

**A modular, opt-in SDLC orchestration framework.** It runs Claude as a disciplined multi-agent system
where the main session is a **Technical Program Manager (TPM)**: it takes intent from the product owner
(you), decomposes it, delegates to worker / verifier / researcher subagents across parallel
workstreams, verifies the output, integrates it, and reports back. The name is the role: TPM, not
"admin."

## The opt-in activation model

Capabilities are **modules**, and you opt into them:

- **Modules:** `tasks` (task tracking), `workflow` (formal multi-agent rounds), `session` (session
  notes + boot), `hygiene` (drift sweeps), `motd` (boot greeting). More over time.
- **Config-gated:** each module has an `enabled` flag in `.claude/claude-tpm/config.json`.
- **A disabled module costs ZERO context** — its docs, skills, and reading-list entries never load.
  This is the framework-level token lever: you don't pay for machinery you're not using.
- **Everything is ON by default** — the full framework works out of the box; a project *disables* what
  it doesn't want, rather than opting in piece by piece.

The engine boots at **session open** (the `session` module's `open`): it reads config to learn which
modules are live, loads the small always-on core, pulls project state (latest notes + task queue),
surfaces the available capabilities, and gates before real work.

## Module opacity — a disabled module leaves no trace, not even awareness

"Zero context" is stronger than "don't load the module's own docs." **A disabled module must leave no
residual *awareness* of its concept in the orchestrator's context** — not a stray mention, not a
cross-reference, not a "when you're running a workflow…" aside buried in an always-loaded doc. If a
project disables `workflow`, its orchestrator should operate as though formal rounds, charters, and
verification *are not a thing that exists* — beyond, at most, seeing a few skill names it can't act on
(a skill's description may not be suppressible; its concepts still must not appear in any doc it reads).

- **The test.** With a module OFF, walk the orchestrator's entire live reading chain. The disabled
  module's vocabulary — "charter," "workflow round," "verifier," "pre-task questions" — should not
  appear *anywhere* in it. If it does, that's a leak to fix.
- **The design consequence: core/shared docs must be module-agnostic.** A doc on the always-on core
  list may describe only module-agnostic ground — the orchestrator's identity, read/write boundaries,
  shared conventions. **Every reference to a specific optional module moves into that module's own
  docs,** which load only when it's enabled. This is exactly why `orchestrator/handbook.md` gets carved:
  its general job-description stays core, but its charter / pre-task / plan-review / promotion material —
  all workflow-specific — moves into the `workflow` module, so a workflow-disabled orchestrator never
  reads the word "charter." Same reasoning splits `project-workspace.md` (general write-boundaries stay;
  the `dev/<task>/` layout moves to `workflow`).
- **Why it matters beyond tokens: awareness is behavior.** An orchestrator that *knows* charters exist
  reaches for them; one that has never heard of them just operates. Clutter isn't only cost — it's
  unwanted capability bleeding into a context that opted out. (This is charter secrecy one level up:
  a posture you can't see is a posture you can't drift into.)

## "Just operating" vs. "running a workflow"

The distinction that keeps the framework from being heavy-handed:

- **Just operating** — direct work: answering, a light edit, a quick script. LOW ceremony. No charters,
  no pre-task questionnaire, no automatic verification.
- **Running a workflow** — a formal round: scaffold a task folder, paste a charter into `plan.md`, spawn
  worker(s), spawn verifiers, reconcile. HIGH ceremony — earned, because it's a real round.

The workflow machinery is **triggered, not boot-default.** This is why the orchestrator should NOT
reflexively verify lightweight work — verification is a per-round decision, not a boot-time habit.

## Why this shape

- **Token-frugal** — the biggest cost lever is not loading what you're not using (a disabled module, a
  situational doc not yet triggered, a skill body read only on invocation).
- **Stays skimmable** — the same guardrail spirit as the task system: a lightweight tool for you and
  Claude to share, not a heavyweight process that reinvents enterprise tooling. When something outgrows
  "skimmable," that's a signal to graduate it, not to bloat the core.
- **Extensible** — consumer projects adopt claude-tpm and extend it (reading lists via the
  `<!-- include: claude-tpm -->` splice; per-project supplements) without forking the canon.
- **Asymmetric trust** — critical where the user can't see, relaxed where they can. The orchestrator is
  user-facing and self-correcting (the user redirects it), so its self-verification can be light;
  **subagents are user-invisible**, so the orchestrator keeps a critical eye on their output
  (trust-but-verify, the verifier pattern). Police the orchestrator↔subagent boundary, not the
  user↔orchestrator one.

## Where to go next

- **Mechanism / config shape:** [`../dev/framework-config-design.md`](../dev/framework-config-design.md).
- **Per-module design:** `../dev/task-process-design.md`, `../dev/workflow-design.md`,
  `../dev/session-skill-design.md`, `../dev/hygiene-redesign.md`.
- **Boot ritual:** the `session` module's `open` bootstraps the engine; the reading chain it walks is
  [`orchestrator/reading-list.md`](orchestrator/reading-list.md) (the SSOT).
