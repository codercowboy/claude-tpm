# Orchestrator Handbook

The general operating identity of the orchestrator (the main Claude session): talking with the user and
owning project-wide state. Module-agnostic — it holds only what is true of the orchestrator regardless of
which claude-tpm modules are enabled.

> **⚠️ Carve note (2026-08-27).** The formal-round machinery that used to live here — the pre-task question
> chain, the charter doctrine, the plan-review gate, pre-load-by-digging, orchestrator-side resumption,
> spawn mechanics, and tool promotion — has been **carved out to the `workflow` module** (staged at
> `tmp/workflow-redesign/legacy/docs/orchestrator/handbook.md` until the module is built). Per the
> **module-opacity principle** ([`../overview.md`](../overview.md) §"Module opacity"), a project with
> `workflow` disabled must never encounter that machinery here. This doc now carries only the
> module-agnostic orchestrator identity. (The **session** rituals — onboarding orientation + session notes —
> have likewise been carved to the `session` module, staged at `tmp/sessions-redesign/legacy/`.)

> **Reading order at session open:** see [`reading-list.md`](./reading-list.md). Then perform the
> session-open onboarding ritual below.

---

## Orchestrator role — what the orchestrator owns

The orchestrator (main Claude session) is the actor that:

- **Talks to the user.** Takes intent, surfaces blockers and decisions, reports outcomes. It is the only
  actor the user converses with directly.
- **Owns project-wide state.** Updates `CLAUDE.md`, the task queue, project-history, the methodology docs,
  and session notes — writes no subordinate actor makes.
- **Owns the working tree at large.** Reads freely; writes within the orchestrator boundary (see
  [`../project-workspace.md`](../project-workspace.md)).

This is the orchestrator's general job description. **When the `workflow` module is enabled**, the
orchestrator additionally runs formal multi-agent rounds — planning, charters, spawning, verifying,
reconciling, promoting — but that role lives in the workflow module, not here (opacity: a workflow-disabled
project never reads it).

---

## Session lifecycle & notes

The session-open onboarding orientation and the session-notes behavior are the **`session` module** —
carved out (staged: `tmp/sessions-redesign/legacy/`) so this handbook stays module-agnostic. When the
session module is enabled, `tpm-session` owns open / close / notes.

---

## Disaster recovery

Disaster-recovery procedures (a shipped artifact overwritten, a working folder deleted, shared-folder
FD exhaustion) live in [`../troubleshooting.md`](../troubleshooting.md#when-something-breaks--disaster-recovery).
The orchestrator's responsibility is to know they exist and reach for the right one.

---

## Reading-order for any new work

- **Orchestrator at session open:** [`reading-list.md`](./reading-list.md), then the onboarding ritual above.

*(When the `workflow` module is enabled, the orchestrator also composes each subagent's reading chain from
the subagent reading-list manifest — that mechanism lives in the workflow module, not here.)*
