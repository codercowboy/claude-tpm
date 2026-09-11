# claude-admin methodology docs

Generic subagent-harness + investigation methodology. Project-agnostic by rule — consumer-specific
evidence belongs in a consumer's own supplement, never here.

## Start with a reading list, not this file

Which docs you read depends on which actor you are. Two lists own that:

- **[`orchestrator/reading-list.md`](./orchestrator/reading-list.md)** — the orchestrator's set, in
  session-open order. Includes the orchestrator-only docs.
- **[`subagent/reading-list.md`](./subagent/reading-list.md)** — the subagent's set: a base chain
  plus conditional blocks per spawn flavor (resume / shipping / live-system / verifier). This is the
  single source of truth for the step-zero reading chain, and `tools/workflow/lint-subagent-prompt.js`
  parses it directly, so the two cannot drift.

> ⚠️ **Subagents read only the subagent list.** The orchestrator list carries project-management
> process — most importantly the existence of two charters — that misleads a worker about what its
> round is for. The split is an honor-system fence, not access control; see the banner atop
> `orchestrator/reading-list.md`.

The orchestrator may freely read anything on either list. The reverse is the request to refuse.

## Full inventory

Every doc in this folder, by role. The reading lists say *when* to read them; this says *what they are*.

**Shared — both actors (root)**

| Doc | What it covers |
|---|---|
| [`project-workspace.md`](./project-workspace.md) | Read/write boundaries per actor, canonical `dev/<task>/` layout, scaffolder, naming conventions. |
| [`shared-conventions.md`](./shared-conventions.md) | Findings-doc format, terse-default communication, resumption protocol, reading heuristics. |
| [`tool-conventions.md`](./tool-conventions.md) | Copy-then-modify pattern, `tool-updates.md` / `tool-feedback.md` formats, no-hardcoded-paths directive. |
| [`troubleshooting.md`](./troubleshooting.md) | What to try when stuck; disaster recovery. |
| [`verification.md`](./verification.md) | Verifier ground rules (HARD RULE — verifiers never touch the live system under test), on-disk-only inspection, PASS/FAIL evidence format, reproducibility bar, decision logging. |

**⚠️ Orchestrator — never referenced in a spawn prompt**

| Doc | What it covers |
|---|---|
| [`orchestrator/handbook.md`](./orchestrator/handbook.md) | Plan-review gate, prompt-template registry, model selection, promotion criteria, cost tracking, disaster recovery. |
| [`orchestrator/reading-list.md`](./orchestrator/reading-list.md) | The orchestrator's session-open reading chain; the orchestrator-only doc set. |
| [`orchestrator/pre-task-questions.md`](./orchestrator/pre-task-questions.md) | The pre-task question ritual. Load into memory at session open. |
| [`orchestrator/session-open-questions.md`](./orchestrator/session-open-questions.md) | Self-quiz gate — the last step before real work. |
| [`orchestrator/session-process.md`](./orchestrator/session-process.md) | Session-notes process — where session notes live and how they're written. |

**Subagent**

| Doc | What it covers |
|---|---|
| [`subagent/handbook.md`](./subagent/handbook.md) | How a subagent operates — step-zero env ritual, scope, reporting. |
| [`subagent/reading-list.md`](./subagent/reading-list.md) | The subagent's step-zero reading chain; parsed by the lint. |

**Hygiene — periodic project-wide drift sweeps**

| Doc | What it covers |
|---|---|
| [`hygiene/checks.md`](./hygiene/checks.md) | The hygiene-run checklist — doc rot, stale tool indexes, superseded research. |
| [`hygiene/living-documents.md`](./hygiene/living-documents.md) | Framework for declaring + maintaining living reference docs. |
| [`hygiene/research-consolidation.md`](./hygiene/research-consolidation.md) | The periodic map-reduce harvest that sweeps a scattered corpus into canonical per-entity reference docs. |

**Workflow-setup — planning, spawning, and charters**

| Doc | What it covers |
|---|---|
| [`workflow-setup/plan-template.md`](./workflow-setup/plan-template.md) | Skeleton for `plan.md`. Don't hand-roll. |
| [`workflow-setup/subagent-orchestration.md`](./workflow-setup/subagent-orchestration.md) | Orchestrator-side, how to spawn & run a subagent: prompt composition (inline rationale, non-doc payload, negative directive, supplements), the prompt-template registry, the pre-spawn lint, model selection, and cost tracking. |
| [`workflow-setup/shipping-charter.md`](./workflow-setup/shipping-charter.md) / [`workflow-setup/research-charter.md`](./workflow-setup/research-charter.md) | Exactly one is pasted into every `plan.md`. Never both; never let a worker learn the other exists. |
| [`workflow-setup/prompt-templates/`](./workflow-setup/prompt-templates/) | Reusable spawn-prompt skeletons with `{{SLOT}}` placeholders — see its [`README.md`](./workflow-setup/prompt-templates/README.md) ([`docs-synthesis.md`](./workflow-setup/prompt-templates/docs-synthesis.md), [`static-analysis.md`](./workflow-setup/prompt-templates/static-analysis.md), [`verification-subagent-no-live-system.md`](./workflow-setup/prompt-templates/verification-subagent-no-live-system.md)). |

<!-- PORT-NOTE: the release line (release-methodology.md, release-shipping-charter.md, release-design-charter.md) is DEFERRED to Phase 2 per LOCKED-DECISIONS; its "assembling a release from many small rounds" addenda are not yet ported and are intentionally omitted from this index. -->

**Not in this folder — consumer-owned**

- **`reference-resources.md`** — pointers to per-project canonical resources (canonical input paths,
  reference-doc pool, project-specific tools). This library ships none by design; its content is entirely
  per-project. Required reading where it exists, skipped where it doesn't.

## Consumers

Consumer projects reach these docs via the CLAUDE.md chain-composition pattern documented in the
consumer project's own adoption docs (see `docs/CONSUMER-QUICKSTART.md`). A consumer's own
`claude-context/methodology/` folder holds supplements that extend — never contradict — these
canonical docs. See [`docs/CONSUMER-QUICKSTART.md`](../../docs/CONSUMER-QUICKSTART.md) for the
adoption path.

**Status of a well-adopted consumer (illustrative shape):** supplement-only — its
`claude-context/methodology/` holds a handful of `-<consumer-slug>` supplements plus the
project-owned `reference-resources.md`, with no full-fat copies of the canonical docs. Its CLAUDE.md
reads this library's docs directly from a sibling checkout (e.g. `../claude-admin/`).
