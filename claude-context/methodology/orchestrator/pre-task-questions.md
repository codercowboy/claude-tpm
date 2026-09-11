# Pre-task questions — the orchestrator↔user ritual before any spawn

> ⚠️ **Orchestrator-only (charter-secret).** This doc names charters + the roster machinery. Never point a
> subagent at it. Run this ritual with the USER before you write a `plan.md` or spawn anything.

**🛑 DO NOT START** a round until you have walked this with the user and gotten an explicit go. The user always
directs the kickoff of subagents; it must be confirmed. (See `handbook.md` + the workflow design.)

## Present it as BIG ROCKS + one collapsed ADVANCED line

Batch the questions into one message: the task-defining **big rocks** asked in full, and the defaulted rest tucked
into a single **advanced** line. **A default is never a mutation** — accepting runs the team AS CONFIGURED. The
accept phrase is **`all defaults`**; the user overrides by naming a change (e.g. `time 1h`).

Use the **presentation format** (one subagent per line; the loop as an "on FAIL only" sub-line):

```
Pre-task — <team> round: <task>
Defaults run the team AS CONFIGURED. Reply "all defaults" to accept; name only what you want changed.

① Roster + sequencing — <serial|parallel>, 1 each:
     <role>   · charter: <name>   · <model>       (one line per persona, in run order)
     ↳ on FAIL only: verify ↔ bug-fixer loop  · bug-fixer · <model> · cap <verifyLoopCap>
② Definition of "done" — [draft the acceptance triples; confirm/edit]
③ Paths — in: <…>  out: <…>

Advanced — all defaulted ("-v" expands): time <2h> · scope <task-folder> · retries <from config>
```

## The three big rocks (asked in full)

1. **Roster + sequencing** — which team (`full` / `ship` / `build` / `test` / `docs` / `research`, or a
   config-defined team) + counts + parallelism (`defaultParallelism`, default `serial`). Picking a team cascades
   the whole roster, run order, and the verify↔bug-fixer loop — it's ONE choice, presented one-persona-per-line
   with each role's fixed charter + model shown (from `subagentConfigs`).
2. **Definition of "done"** — the acceptance criteria as a table of triples (claim · artifact · check). You draft;
   the user confirms/edits.
3. **Paths** — confirm the input/output paths (a wrong input path silently wastes a whole round).

**There is no separate charter question.** Every role has exactly one shipped charter (`subagentConfigs[].charterFile`),
so the roster just *displays* each role's charter — nothing to choose. If a round needs a lower bar for one role,
that's an **ad-hoc edit to that round's copied `charter-<role>.md` in the work folder** (the canonical charter stays
pristine), or a consumer's own config override — not a pre-task question.

## The secondary line (collapsed to one line by default; `-v` / `--verbose` asks in full)

- **Time budget** (default 2h) · **Models** (per-role defaults from `subagentConfigs`) · **Scope** (default:
  task-folder) · **Retry counts** (from config: builder/bug-fixer 5 · verify-loop cap 5 · others 1).

## Baked in — NOT questions

- **Background execution** — the orchestrator always runs subagents in the background.
- **Resume handling** — filled contextually when writing the plan (continuing a failed round / multiple workers in
  a folder); the 3 modes (resume / sibling / clean-reset) are orchestrator machinery, not a user question.
- **Adversarial verification** — verifiers are always adversarial (baseline in the verifier charter), never an opt-in.
- **Repro-script deliverable** — a standing shipping-charter deliverable, not a planning question.

Authoritative model: the workflow design §"Persona / team / loop model" + §"Pre-task presentation format — SPEC".
