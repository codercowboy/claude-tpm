# Orchestrator reading list

**The complete set of methodology docs the orchestrator reads.** Walked at session open by the
`tpm-session` skill (`tpm-session open`).

> ## ⚠️ Never point a subagent at this list, or at any doc in the "Orchestrator-only" section below.
>
> Every subagent receives `CLAUDE.md` in its context automatically — the harness injects project
> instructions into every agent and there is no way to withhold it. The separation between this list
> and [`reading-list.md`](../subagent/reading-list.md) is therefore the **primary mechanism**
> keeping orchestrator-only process out of worker contexts. It works by workers never being pointed
> at these files, not by any access control.
>
> The specific thing this protects: **a worker must never learn that two charters exist.** A worker
> that knows a research posture is available can reason its way into it — especially while reading
> sibling rounds written in survey voice — and the round ends with an excellent write-up of why the
> thing is hard instead of a working artifact. See
> [`handbook.md`](./handbook.md) §"Charters" for the full rationale.
>
> **The user may ask the orchestrator to read more — that direction is always safe.** The reverse
> ("have the worker read the orchestrator docs too") is the one request to push back on: it costs a
> round.

---

## Tier 1 — Read at boot, in order (the CORE, always on)

The small set you read at every session open, regardless of which modules are enabled. Small on purpose.

<!-- reading-list:begin tpm-session-open -->
1. **[`project-workspace.md`](../project-workspace.md)** — read/write boundaries per actor + naming conventions. (Its `dev/<task>/` layout half is workflow-module machinery — a split is pending; see `dev/workflow-design.md`.)
2. **[`handbook.md`](./handbook.md)** — ⚠️ orchestrator-only. Your job description: plan-review gate, model selection, promotion criteria, cost tracking, disaster recovery. (Its round-specific parts belong to the workflow module — split pending.)
3. **[`shared-conventions.md`](../shared-conventions.md)** — shared conventions you and every worker follow.
4. **[`session-open-questions.md`](./session-open-questions.md)** — ⚠️ orchestrator-only. The boot self-quiz gate. Answer each silently; if fuzzy on any, re-read that question's referenced doc first.
<!-- reading-list:end -->

Then the project-state reads outside `methodology/` — `docs/tasks.md`, the latest
`claude-context/sessions/session-NNN/session-notes.md` (or `notes.md` for a legacy pre-`tpm-session`
folder), and `tools/README.md`. The `tpm-session` skill (`open` mode) walks THIS list; neither it nor
`CLAUDE.md` re-states these docs (a second copy is what drifts).

## Tier 2 — Shared situational shelf (know it exists; read WHEN THE TRIGGER FIRES)

Not read at boot. Both are also on the worker's shelf.
- **[`tool-conventions.md`](../tool-conventions.md)** — *trigger: building or maintaining a tool.*
- **[`troubleshooting.md`](../troubleshooting.md)** — *trigger: stuck / disaster recovery.* (Live-system access, if the project has a live SUT, is per-project — this library ships no canonical live-system doc, and you are its default driver.)

`verification.md` is **subagent-facing — NOT on the orchestrator list.** You see it via the worker
reading list, where it's conditional under `--shipping` / `--verifier`. (This is why the orchestrator
should NOT treat verification as an automatic step — see `dev/workflow-design.md`.)

## Modules — pointers, loaded ONLY when the module is enabled (see `dev/framework-config-design.md`)

Each module owns its own reading list; this boot list POINTS at it rather than enumerating, and only
when config enables the module. **Disabled module ⇒ its docs never load** (the framework-level token
lever). Do NOT re-list a module's docs here.

- **Workflow module** (⚠️ orchestrator-only; **charter-secret** — never pointed at a worker) — the
  formal multi-agent round machinery: `pre-task-questions.md` (the 13-Q ritual + `🛑 DO NOT START`
  pre-check), `workflow-setup/shipping-charter.md` + `research-charter.md` (paste exactly one into
  `plan.md`; default shipping; a worker must never learn the other exists), `workflow-setup/plan-template.md`,
  `workflow-setup/subagent-orchestration.md`, `workflow-setup/prompt-templates/`. Read ONLY when running
  a workflow. Planned SSOT: `workflow-setup/reading-list.md` — see `dev/workflow-design.md`.
- **Hygiene module** — periodic drift sweeps: `hygiene/checks.md`, `hygiene/living-documents.md`,
  `hygiene/research-consolidation.md`. Read only on a hygiene sweep. See `dev/hygiene-redesign.md`.

<!-- PORT-NOTE: The source listed release-line addenda here — `release-shipping-charter.md`, `release-design-charter.md`, and `release-methodology.md`. The release layer is DEFERRED this pass (LOCKED-DECISIONS §Release layer); those docs are not ported, so their bullets are removed rather than left dangling. Restore them when the release line is ported. (release-line addenda: not yet ported) -->

## Also read by workers

You read everything on [`reading-list.md`](../subagent/reading-list.md) too — that's how you
know what a worker knows. Notably `handbook.md`, which tells you what a worker expects to be
told.

## Operational, outside `methodology/`

- **[`tools/README.md`](../../tools/README.md)** — canonical tool index.
- **[`docs/project structure.md`](../../docs/project%20structure.md)** — flat repo inventory.
</content>
