# Subagent reading list

**The complete set of methodology docs a subagent reads.** If a doc isn't on this list, a subagent
has no reason to open it.

This file is the **single source of truth** for the step-zero reading chain. Two things consume it:

- **The orchestrator**, when writing a spawn prompt (via the `spawn-subagent` skill).
- **The subagent-prompt lint** (`npx tpm workflow lint`), which parses the marked blocks below and derives its
  checks from them. Add a doc here and the lint starts requiring it; remove one and it stops. They
  cannot drift.

> **Subagents: this list is yours and it is complete.** You do not need, and should not go looking
> for, any methodology doc outside it. There is a separate list scoped to the orchestrator; it
> contains project-management process that does not apply to your round and would only mislead you
> about what your round is for. Your `plan.md` is authoritative for what you're doing; this list is
> authoritative for what you read to do it.

> **Orchestrator: do not hand-edit spawn prompts to add docs from the orchestrator list.** If a
> worker genuinely needs something that lives there, that's a signal the content is misfiled —
> promote the generic part into a doc on this list instead.

---

## Base — every subagent, every round, no exceptions

Read in this order, before any other action in your round.

<!-- lint:begin base -->
1. **[`project-workspace.md`](../project-workspace.md)** — read/write boundaries, the canonical `dev/<task>/` layout, naming conventions. Tells you where you may write.
2. **[`shared-conventions.md`](../shared-conventions.md)** — shared conventions: findings-doc format, terse-by-default communication, the resumption protocol, reading heuristics.
3. **[`handbook.md`](./handbook.md)** — how you operate as a subagent. Step-zero env ritual, what you own, how you report.
4. **[`tool-conventions.md`](../tool-conventions.md)** — the copy-then-modify pattern, `tool-updates.md` / `tool-feedback.md` formats, the no-hardcoded-paths directive.
5. **[`troubleshooting.md`](../troubleshooting.md)** — what to try before declaring a dead end, plus disaster recovery.
<!-- lint:end -->

Then, in your working folder:

<!-- lint:begin working-folder -->
6. **`plan.md`** — your round's authoritative brief. Read it last so the conventions above are loaded when you do.
<!-- lint:end -->

## Conditional — only when your spawn prompt says so

Your spawn prompt names which of these apply. Read them after the base list, before `plan.md`.

**Resuming a prior round** (`--resume`):

<!-- lint:begin resume -->
- **`findings/HANDOFF.md`** — read BEFORE `plan.md`. Its "What remains" section drives your scope; its "MUST NOT redo" list is load-bearing.
<!-- lint:end -->

**Shipping an artifact** — a tool, a code change, a data transformation, or other built artifact (`--shipping`):

<!-- lint:begin shipping -->
- **[`verification.md`](../verification.md)** — the reproducibility bar your artifact has to clear.
<!-- lint:end -->

**Granted a live system under test** (`--live-system`):

<!-- lint:begin live-system -->
<!-- Per-project block. This library ships no canonical live-system doc — access to a live system
     under test is entirely project-specific, so there is nothing generic to put here. The block is
     intentionally empty by default; a consumer project with a live SUT adds its own operational
     reference here (or via a consumer supplement). The lint requires whatever entries exist. -->
<!-- lint:end -->

**Verifying another worker's artifact** (`--verifier`):

<!-- lint:begin verifier -->
- **[`verification.md`](../verification.md)** — the **HARD RULE** (independence = render a *verdict*, never *repair* what you check; you actively exercise the artifact with whatever tools/MCP the round provides, but you never mutate or drive the state you are verifying — a PASS you caused is worthless), on-disk evidence, and the PASS/FAIL-with-evidence format.
<!-- lint:end -->

**Writing tests for already-delivered code** (`--test-writer`):

<!-- lint:begin test-writer -->
- **[`tool-conventions.md`](../tool-conventions.md)** — the ship-tool **tests** bar: a ship-intended tool owes real tests (under `tests/<tool>/`), not smoke tests; the bar those tests must clear.
- **`HANDOFF.md`** — the prior delivery agent's handoff: the artifact under test and where it lives.
<!-- lint:end -->

**Writing docs for already-delivered code** (`--documentarian`):

<!-- lint:begin documentarian -->
- **[`tool-conventions.md`](../tool-conventions.md)** — the **`<tool>.md`** bar: a ship-intended tool owes a reference doc beside the executable (flags, subcommands, one worked example).
- **`HANDOFF.md`** — the prior delivery agent's handoff: the artifact to document and where it lives.
<!-- lint:end -->

**Fixing the verifier's reported findings** (`--bug-fixer`):

<!-- lint:begin bug-fixer -->
- **[`verification.md`](../verification.md)** — the verifier's verdict format and the reproducibility bar your fix must re-clear; the concerns you are fixing are stated against it.
- **`HANDOFF.md`** — the prior delivery agent's handoff: the artifact under fix and where it lives.
<!-- lint:end -->

## Consumer projects

<!-- lint:begin consumer-optional -->
- **`reference-resources.md`** — pointers to project-specific canonical resources (source-input paths, captures repo, project-details doc pool). **This library ships no such file, by design** — its entire content is per-project, so there is nothing generic to put in one. It is REQUIRED reading when the file exists and silently skipped when it does not; the lint checks for it only if it's on disk.
<!-- lint:end -->

A consumer project extends this list rather than replacing it — see
[`docs/INSTALL.md`](../../docs/INSTALL.md).

<!-- PORT-NOTE: INVARIANT 2 — block names are now: base, working-folder, resume, shipping, live-system, verifier, consumer-optional. The `emulator` block was renamed to `live-system` and the `--emulator` flag to `--live-system`. Worker C's subagent-prompt-lint BLOCK_SPEC / CANONICAL_IDS and the `--emulator`→`--live-system` flag MUST be aligned to these exact names in the same change, and its working-folder regex changed from `research/topics/` to `dev/`. -->
