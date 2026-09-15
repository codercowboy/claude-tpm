---
name: tpm-spawn-team
description: Use when spawning a TEAM of two or more subagents — either a named team (full / ship / build / test / docs / research) or a freeform ordered roster of roles (planning / builder / test-writer / documentarian / verifier / bug-fixer / researcher) with counts and a serial/parallel run mode. Forgiving roster + mode interpretation, then delegates each spawn to the tpm-spawn flow. For a single subagent, use tpm-spawn. For the full round lifecycle, use tpm-workflow. Orchestrator-only — a subagent never invokes this (subagents don't spawn their own subagents).
---

`/tpm-spawn-team` fires **two or more** subagents as an ordered roster. It owns *roster* judgment
(which roles, how many, in what order, and how peers run) then delegates each individual spawn to the
`tpm-spawn` flow (scaffold → compose → lint → Agent). Judgment + routing only; charters own posture,
tools own mechanics.

Usage: `/tpm-spawn-team [named-team | roster] [--mode serial|parallel]`. No/empty/malformed args → show
this usage and stop.

```
Named-team examples (expand to the fixed rosters below):
  /tpm-spawn-team full
  /tpm-spawn-team ship
  /tpm-spawn-team docs

Freeform-roster examples:
  /tpm-spawn-team researcher followed by a builder
  /tpm-spawn-team builder then 2 verifiers
  /tpm-spawn-team 2 researchers + a planner + a builder + 3 verifiers --mode parallel
```

## ⛔ HARD RULE — the USER directs the kickoff

**Never spawn without explicit user direction.** Any doubt the user said "go" → echo the resolved
roster and ask to confirm rather than inferring it.

## Named teams — the 6 TPM-shipped rosters (check these FIRST)

Before treating the argument as a freeform roster, check whether it names one of the **6 shipped teams**.
If the (normalized) argument is a single team name, expand it to the fixed roster below. **Array order IS
run order** — the delivery agents each run ONCE, in the listed order, then the verifier checks. These
rosters + their order are authoritative from `tpm-workflow-config-resolver.js` `getDefaults().teams`; do not reorder or
re-roster them.

| Team | Roster (run order) | Notes |
|---|---|---|
| **`full`** | planning → builder → test-writer → documentarian → verifier | The only team with separated test/doc concerns. Then the verify↔bug-fixer loop (orchestrator-owned; see below). |
| **`ship`** | builder → verifier | Lean — the builder wears all hats (artifact + its tests + its docs). Then the loop. |
| **`test`** | test-writer → verifier | Add tests to already-delivered code. Then the loop. |
| **`docs`** | documentarian → verifier | Add docs to already-delivered code. Then the loop. |
| **`research`** | researcher | No verify. |
| **`build`** | builder | No verify. (A lone builder is really a single spawn — see rule 3 below; `build` is listed here for completeness of the team registry.) |

Team-name synonyms are forgiving too (normalize + intent-match): `full round`/`everything`→`full`;
`ship it`/`deliver`→`ship`; `add tests`/`testing`→`test`; `docs`/`documentation`/`write docs`→`docs`;
`investigate`/`explore`→`research`; `just build`→`build`. **Confidence gate still applies** — if a name is
ambiguous between a team and a freeform role (e.g. bare `test` could mean the `test` team or a lone
`test-writer`), don't guess: echo both readings and ask which.

**The verify↔bug-fixer loop is NOT this skill's job.** Every team above except `research`/`build` ends with
a verifier, and on a kickback the orchestrator may loop verifier↔bug-fixer up to `verifyLoopCap`. That loop
is **orchestrator-owned and wired in `tpm-workflow`'s `modes-verify` (phase 13), not here.** This skill
spawns the team's roster in order; it does not spawn the bug-fixer, run the loop, or reason about its count.

## Interpreting the roster (forgiving)

If the argument is NOT a named team, resolve it to an ORDERED roster of canonical roles: **`planning`** ·
**`builder`** · **`test-writer`** · **`documentarian`** · **`verifier`** · **`bug-fixer`** ·
**`researcher`**.

1. **Normalize + intent-match** exactly as `/tpm-spawn` does — lower-case, collapse whitespace, strip
   punctuation, then map each named role by meaning, not exact string. Same synonym guide:

   | Canonical | Also accept |
   |---|---|
   | `planning` | planning, planner, plan, formalize the ask, surface risks |
   | `builder` | builder, worker, work, working subagent, implementer, do the work, ship it, build |
   | `test-writer` | test-writer, test writer, write tests, add tests, tests, testing, test author, coverage, unit tests |
   | `documentarian` | documentarian, documenter, docs, doc, document, documentation, write docs, add docs, wiki, write-up |
   | `verifier` | verifier, verify, verification, checker, check, second opinion, review the artifact |
   | `bug-fixer` | bug-fixer, bug fixer, fixer, fix, fix the bug, fixup, patch, repair, address the findings, fix the verdict |
   | `researcher` | researcher, research, investigate, explore, look into, study, survey |

   Minor unambiguous misspellings (`biulder`, `reseacher`) resolve normally.
2. **Order and counts are load-bearing.** Preserve the sequence (`researcher followed by a builder`
   → researcher, then builder) and the counts (`2 builders`, `3 verifiers`). Connective words —
   `then`, `followed by`, `and`, `+`, `,`, `with`, `of` — are separators, not roles. A leading
   `team` / `team of` is a prefix, not a role.
3. **Only one role, count 1 → not a team.** Tell the user *"That's a single subagent — use
   `/tpm-spawn <role>` instead."* and stop.
4. **Confidence gate.** Resolve a role ONLY when confident. If any element is empty, maps to nothing,
   or is genuinely ambiguous between two roles, do NOT guess — show the usage and name the ambiguity
   in one line.

## Interpreting `--mode` (intra-phase policy)

`--mode` sets how **same-role peers** run within a stage. Default **`serial`**.

1. **Normalize + intent-match**, same forgiving rule. Obvious misspellings (`sequental`, `paralel`,
   `parallell`) resolve normally.

   | Canonical | Also accept |
   |---|---|
   | `serial` (default) | serial, seq, sequential, series, chain, chained, ordered, after, then, 1x1 |
   | `parallel` | par, fan, fanout, fan-out, wide, together, at-once, concurrent, simultaneous, swarm |

2. **Absent → serial.**
3. **`--mode` is the INTRA-STAGE policy only. The pipeline barriers are ALWAYS hard.** Roles run in
   pipeline order
   `researcher(s) → planning → builder(s) → test-writer(s) → documentarian(s) → verifier(s)` with
   **hard barriers between stages**. Each **delivery** agent (builder / test-writer / documentarian)
   runs ONCE, in that order; barriers: planning→delivery is a hard gate (planning fully done before any
   build); and **delivery→verifier is a hard gate** — a verifier reads the completed artifact from
   disk, so it cannot start until every delivery agent ahead of it has finished. So `--mode parallel`
   on a `builder + verifier` roster means "run the verifiers in parallel with each other, AFTER the
   builder finishes," NOT "run builder and verifier at once." If the user's phrasing implies overlapping
   a delivery agent with its verifier, say so and treat the boundary as a barrier anyway. (The
   verifier↔bug-fixer *loop* that may follow a verifier is orchestrator-owned — see "Named teams" — and
   is not scheduled by this skill.)

## Echo the resolution before acting

State the full ordered roster + resolved mode in one block so a wrong parse is visible before
anything spawns:

> Reading `team of 2 builders then 3 verifiers --mode par` as →
> **Roster:** builder, builder → verifier, verifier, verifier
> **Mode:** parallel (within each stage)
> **Note:** builder→verifier is a barrier — verifiers start after both builders finish.

Then, if the roster has more than one BUILDER, flag the ambiguity before scaffolding: two builders can
mean two independent phase folders or one shared artifact — **ask which**, since it changes the
`dev/…` layout (multiple builders sharing a deliverable is the epic trigger; each builder gets its
own numbered phase folder — no stomping). Do NOT silently pick one.

## Then spawn each — via the `tpm-spawn` flow

For each roster slot, run the `tpm-spawn` flow (scaffold → fill `plan.md` → compose → lint → Agent),
respecting the stage barriers and the intra-stage `--mode`, all in the **background**. Roles + charters
+ models resolve from `tpm-workflow-config-resolver.js`; each subagent writes ONLY in its own folder.
