# Project Workspace & Read/Write Boundaries

Where each actor (orchestrator, subagent) is allowed to read and write. **Applies to both** — read it once
and apply it everywhere. These boundaries are module-agnostic: they hold whether or not the `workflow`
module is enabled.

> **⚠️ Carve note.** The **`dev/<task>/` canonical layout**, "what each folder is for", the
> `questions.md` format, task-folder **scaffolding**, and the file-**naming conventions** were workflow-round
> machinery and live in the **`workflow` module** now (the `tpm-workflow`/`tpm-spawn` skills and the docs
> under [`workflow-setup/`](./workflow-setup/)). Per the **module-opacity principle**
> ([`./overview.md`](./overview.md) §"Module opacity"), a project with `workflow` disabled shouldn't read
> the task-folder layout here. What remains below is the general read/write boundary contract.

---

## Reads vs writes — the principle

- **Reads are unrestricted for both actors.** Any file in the project is fair game to open, grep, diff, or
  cite. Immutable source inputs, prior findings, every script in `tools/`, session notes, third-party
  assets — all readable. Cross-task learning is the whole point.
- **Writes are constrained.** Each actor has its own write boundary. Stepping outside it is a violation,
  not just a style choice.

---

## Orchestrator write boundaries

The orchestrator (main Claude session) can write to most of the repo by default — it owns project-wide
work. The carve-outs below are **never written without the user's explicit per-occasion approval**:

| Path / Action | Write status | Why |
|---|---|---|
| Immutable source inputs the project gates against | ❌ never modify | The project's tooling may checksum-gate against these. Modifying one silently breaks every step that gates on it. Copy to a working file and modify the copy. |
| `tools/<X>/` generalized tools, when doing task-specific work | ❌ no in-place edit | Per the [copy-then-modify pattern](./tool-conventions.md#the-copy-then-modify-pattern): copy the file into your working folder first, modify the copy. Promote back only after the change proves generic. |
| Inside an actively-running subagent's working folder | ❌ no | The orchestrator does NOT edit a subagent's folder while it runs. After it finishes, the folder is read-only until reconciliation. Even during reconciliation, the orchestrator does NOT silently rewrite a subagent's findings — wrong findings get a follow-up subagent or a user escalation; the original stays so the audit trail is honest. |
| Another actor's live-system session dir, if the project has one | ❌ never | If the project provisions a live system per actor, each instance owns its own session dir. Writing to a sibling's corrupts their state. Own only your own session. |

**Writes the orchestrator routinely owns:** `tools/` (product tools + promotions), the task ledger under
`.claude/claude-tpm/tasks/` (read/written via `npx tpm task`), the `docs/` / project-history it keeps
current, the session notes under the configured sessions dir (`session.notes.sessionsDir`), `claude-context/methodology/*`,
`CLAUDE.md` (sparingly), `tmp/` (scratch), `output/` (regenerable, git-ignored). When the orchestrator runs
a task itself, it owns that working folder directly.

**⚠️ All work — even temporary scratch — goes inside this project directory.** Claude may run in a sandbox
or VM; paths outside the project (`/tmp`, or anywhere outside the project root) may not survive a rebuild.
The project's own `./tmp/` survives between sessions.

---

## Subagent write boundaries

A subagent's writes are confined to **its own assigned working folder** — the one the orchestrator picks
and names in the spawn prompt. Sibling task folders, project `output/`, project `tools/`, another actor's
live-system session dir, and `CLAUDE.md`/methodology/docs are all off-limits. Project-level state belongs to
the orchestrator; a subagent surfaces changes to it through its findings, and the orchestrator applies them
at reconciliation.

*(The detailed per-path write table for the `dev/<task>/` layout is part of the task-folder machinery — see
the carve note above; it lives with the workflow module.)*

The orchestrator never **silently rewrites** a subagent's findings during reconciliation. If a finding is
wrong, it spawns a follow-up or works with the user to address it; the original is left in place so the
audit trail is honest.

---

## Cross-references

- [`./shared-conventions.md`](./shared-conventions.md) — shared conventions (communication, reading heuristics, onboarding).
- [`./tool-conventions.md`](./tool-conventions.md) — how tools are used, copied, modified, built.
- [`./troubleshooting.md`](./troubleshooting.md) — when "stuck" turns out to be "I tried to write where I'm not allowed."
- [`./overview.md`](./overview.md) — the claude-tpm activation model + the module-opacity principle behind this carve.
