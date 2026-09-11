# CLAUDE.md

`claude-admin` is a project-agnostic Claude Code setup for running Claude as a
disciplined multi-agent system (orchestrator + researcher/worker/verifier
subagents). This file is the boot entry point. See `README.md` for what the
project is.

## On boot — read this first

**If you are the ORCHESTRATOR (the main session):**

1. Walk **`claude-context/methodology/orchestrator/reading-list.md`** — the
   authoritative, single-source-of-truth reading chain for the orchestrator side.
   It is **tiered**: **Tier 1** is the short set you read at boot, in order; **Tier
   2** is a situational shelf you read only when its trigger fires. The manifest
   itself flags what to **load into memory** and what the **final gate** is. Walk
   it; do NOT work from a copy. This file and the `tpm-session` skill deliberately
   do NOT re-list the manifest's contents — a second copy is exactly what drifts.
2. Run **`tpm-session open`** — it applies the **session-notes process** documented in
   **`claude-context/methodology/orchestrator/session-process.md`** for you:
   - **On start:** it reads the latest session notes — the highest-numbered folder
     in `claude-context/sessions/` (e.g. `session-001`, then `session-002`, …) — and
     allocates/confirms the current session (idempotent within one session; never mints a
     new folder on a repeat `save`/`close`).
   - **When asked to checkpoint or store session notes:** run **`tpm-session save`** (or bare
     `tpm-session`, which is state-aware and calls `save` once a session is already open). It
     updates the SAME current session's notes in place — never overwrites a prior, SEALED
     session's notes.

**If you are a SUBAGENT:** ignore the orchestrator sections of this file (see
the fence below). Obey only your spawn prompt + your working folder's `plan.md`.

---

## Orchestrator / subagent honor-system fence (charter secrecy)

> **⚠️ SUBAGENTS: the "orchestrator" sections of this file are ORCHESTRATOR-ONLY
> directives.** If you are a subagent, ignore them entirely — obey only the
> directives in your own spawn prompt + your working folder's `plan.md`.
>
> **Orchestrator, read this fence carefully.** Every subagent the Agent tool
> spawns receives this entire file in its context — the harness injects project
> instructions into every agent, and there is no mechanism to withhold it. The
> subagent banner above is an **honor-system fence, not an access control.** Two
> consequences you own:
>
> 1. **Never put orchestrator-only content below the fence.** Anything an
>    orchestrator-only section contains is effectively broadcast to every worker.
>    The charter split in particular (`orchestrator/handbook.md` §"Charters" —
>    workers must never learn a second charter exists) survives only because it
>    lives in files subagents aren't pointed at. Don't summarize it here.
> 2. **A fence is not a substitute for a spawn prompt.** Subagents skip the
>    orchestrator sections by instruction, so they do NOT inherit the
>    session-open ritual, the reading chain, or any convention stated above.
>    Everything a subagent must do goes in its spawn prompt explicitly — that is
>    the entire reason the "Subagent prompts: required directives" section below
>    exists.

---

## Subagent prompts: required directives (the reading chain lives in the manifest)

Every subagent gets a fresh context and **skips this file's orchestrator sections
by instruction**, so it inherits nothing stated above. Everything a worker must
do goes in its spawn prompt, explicitly.

**The reading chain lives in
[`claude-context/methodology/subagent/reading-list.md`](claude-context/methodology/subagent/reading-list.md),
not here.** That manifest is the single source of truth: a base chain every
subagent reads, plus conditional blocks per spawn flavor (resume / shipping /
live-system / verifier). `tools/workflow/lint-subagent-prompt.js` parses the
same file to derive its checks, so the documented chain and the enforced chain
cannot drift. Don't re-enumerate the chain here — that duplication is exactly
what drifted before.

Use the **`spawn-subagent` skill**, which composes the prompt from the manifest.
Beyond the chain, every prompt MUST also carry:

1. **The env-source ritual as step zero**, before any doc reads — ONE bash call,
   anchored at the project root:
   ```
   cd '<ABSOLUTE_PROJECT_ROOT>' && \
     set -a && source 'dev/<task>/tmp/subagent.env' && set +a && \
     env | sort > 'dev/<task>/tmp/worker-env.md'
   ```
   Chain with `&&` — do NOT split into two tool calls; each Bash call is a fresh
   shell and the vars won't persist. `cd` to the project root — running from the
   task folder gives exit 127 on most tool invocations. Substitute
   `<ABSOLUTE_PROJECT_ROOT>` with the project's actual absolute path (run `pwd`);
   never hardcode it.
2. **The working folder**, as an unambiguous path from the repo root.
3. **The model**, on the `Agent` call's `model` param — the fast/cheap default
   tier by default; a premium reasoning tier only when the user's task
   description asked for it; verifiers stay on the default tier unless the user
   qualifies. Name a current model rather than baking a version.
4. **Any project-specific constants** the subagent can't derive from disk —
   live-system endpoints/handles, current round numbers, and the like.

**Then lint it:** `node 'tools/workflow/lint-subagent-prompt.js' --file draft-prompt.md`
(add `--live-system` / `--verifier` / `--shipping` / `--resume` as applicable).

⚠️ **Never point a subagent at a doc from `orchestrator/reading-list.md`.** Most
importantly the two charters — a worker that learns a research posture exists can
reason its way into it and end the round with a write-up instead of a working
artifact. See `orchestrator/handbook.md` §"Charters". If a worker seems to need
something from the orchestrator list, the content is misfiled: promote the
generic part into a doc on the subagent list instead.

---

## Layout

- `claude-context/methodology/` — the methodology library. Root holds
  **shared/common** docs (`project-workspace.md`, `shared-conventions.md`,
  `tool-conventions.md`, `troubleshooting.md`, `verification.md`); subfolders are
  role/function-specific:
  - `orchestrator/` — orchestrator-only: `handbook.md` (start), `reading-list.md`,
    `pre-task-questions.md`, `session-open-questions.md`, `session-process.md`.
  - `subagent/` — what subagents read: `handbook.md`, `reading-list.md`.
  - `hygiene/` — periodic upkeep: `checks.md`, `living-documents.md`,
    `research-consolidation.md`.
  - `workflow-setup/` — orchestrator round-setup + spawn machinery: `plan-template.md`,
    `subagent-orchestration.md`, `shipping-charter.md`, `research-charter.md`,
    `prompt-templates/`.
- `claude-context/sessions/session-NNN/` — per-session notes.
- `claude-context/dev/` — this project's own working notes, tasks, and ledgers.
- `tools/workflow/` — enforcement tooling (spawn-prompt lint, cost ledger).
- `tmp/` — scratch + staging (git-ignored).
