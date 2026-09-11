---
name: tpm-workflow
description: Use when running a formal multi-agent round or epic in claude-tpm — planning a round, spawning workers/verifiers, verifying an artifact, or reconciling/closing an epic. The single front door over the round lifecycle. Auto-invoke on "let's plan a round", "run the epic", "set up phase N", "verify the artifact", "close the epic". Thin router: it routes a mode token to a sibling mode body and delegates spawning to tpm-spawn / tpm-spawn-team. For a one-off single subagent with no round, use tpm-spawn directly.
---

`/tpm-workflow` is the front door for **running a formal round** — the HIGH-ceremony path
(scaffold `dev/<task>/` → charter + `plan.md` → spawn builder(s) → verify → reconcile).
"Just operating" (a light edit, a quick answer, a direct script) does NOT come through here
and does NOT auto-verify. This skill is judgment + routing only: the **charters own posture**,
the **tools own mechanics**, and this router owns *which mode, when*.

## ⛔ HARD RULE — the USER directs every kickoff (TWO separate gates)

**Never spawn a subagent, or kick off a round/epic, without an EXPLICIT, SEPARATE user confirmation.**
This is TWO distinct gates, in order — do not collapse them:

- **Gate A — questions answered.** Present the pre-task roster/questions, then **END YOUR TURN and WAIT.**
  The user answering the roster gates *scaffolding*, not spawning.
- **Gate B — spawn confirmed.** After scaffolding, ask an **explicit** "kick it off now?" and **END YOUR
  TURN and WAIT** for an explicit "yes". This is the critical gate: a rambly, discussion, or
  "process-what-I'm-saying" turn is **NOT** a kickoff. Only a fresh, unambiguous "go" authorizes the spawn.

> **The argument text passed to `/tpm-workflow` is the SPEC, never the sign-off.** However complete,
> detailed, or imperative it is ("have two researchers…", "run it", "go build X"), it tells you WHAT — it
> does NOT authorize the GO. Treat it as input to Gate A, then run both gates anyway. *(This rule exists
> because a fully-specified invocation was once self-authorized in the same turn — the exact mistake this
> closes.)*

**Each gate ends your turn.** A confirmation cannot live in the same turn as the request — presenting the
roster AND spawning in one breath defeats the gate. Present → stop → the user's NEXT message is the answer.
Use `AskUserQuestion` for each gate so the answer is genuinely the user's, not your inference.

**Mechanical backstops (poka-yoke — they hold even if the prose above is rationalized):**
- Scaffolding is blocked without a pre-task-ack receipt (`scaffold-subagent --pretask-ack`) — Gate A.
- **Spawning is blocked by a `PreToolUse` hook** (`${TPM_HOME}/tools/workflow/hooks/gate-spawn.js`) unless a **fresh**
  `spawn` sign-off token exists — Gate B. On each gate, record the user's actual confirmation:
  `node ${TPM_HOME}/tools/workflow/signoff.js questions --roster "<one-line>"` (Gate A) and
  `node ${TPM_HOME}/tools/workflow/signoff.js spawn --round "<phase-dir>" --roster "<one-line>"` (Gate B — `--round`
  is the phase-folder path, which the spawn-gate hook matches against the marker `compose` stamps into the
  prompt). **Only ever write these from an
  explicit user confirmation — never from your own reading of an ambiguous turn.**

## Modes — the round lifecycle

The **mode is the first token**; the rest of the line is freeform, interpreted by that mode.

| Mode | Owns | Body |
|---|---|---|
| **`plan`** (default) | Pre-task questions (charter folds into the roster) → scaffold → write `plan.md` → compose + lint the spawn prompt | `modes-plan.md` |
| **`run`** | Spawn per the plan/phase-map. **Delegates** to `tpm-spawn` (single) / `tpm-spawn-team` (roster) — no body of its own | (delegate) |
| **`verify`** | Spawn verifier(s) + the verify↔bug-fixer loop (on FAIL only). A per-round DECISION, not a reflex | `modes-verify.md` |
| **`reconcile`** | Judge the verdict + log the call → reconcile delivery+verifier output → update `00-epic-plan/` → epic-close (promotion + cost rollup) | `modes-reconcile.md` |
| **`reap`** | Stray subagent/subshell cleanup | **delegates to `tpm-reap`** |
| **`status`** | Report round/epic state — read `00-epic-plan/` (phase map · punchlist · decisions), phase `findings/HANDOFF.md`, and `audit.js` output; summarize. No spawn | (inline, below) |
| **`doctor`** | Fail-loud PREFLIGHT before a round: checks charters resolve, both hooks are wired, signoff is writable, compose emits a marker + `${TPM_HOME}` paths. No spawn | (inline, below) |

## Interpreting the mode token (forgiving)

1. **Normalize** — lower-case, collapse whitespace, strip punctuation.
2. **Intent-match, not exact-string** — obvious misspellings still resolve:
   - `plan` ← plan, planning, set up, scaffold, prep, `planr`
   - `run` ← run, spawn, go, launch, kick off, drive, execute
   - `verify` ← verify, check, verification, review the artifact, `verfy`
   - `reconcile` ← reconcile, close, wrap up, promote, roll up, finish, `reconsile`
   - `reap` ← reap, clean up strays, kill, sweep
   - `status` ← status, state, where are we, progress, `staus`
   - `doctor` ← doctor, preflight, health check, check the install, is it wired, sanity check, `docter`
3. **Confidence gate** — resolve only when confident. **Bare `/tpm-workflow` → `plan`** (the
   state-aware default: a round begins by planning). Empty/ambiguous/unmatched arg → show the
   mode table and stop; do NOT guess.
4. **Echo before acting** — `Reading "<arg>" as → mode: <mode>` so a mis-parse is a visible line
   to correct before any machinery runs.

## `-v` / `--verbose` (plan mode)

`plan` asks 3 big-rock questions in full and collapses the secondary set to one line by default;
`-v`/`--verbose` expands the secondary set to full questions. See `modes-plan.md`.

## Pre-flight self-quiz (anti-skip gate)

Before you spawn / plan / scaffold, silently answer the pre-workflow self-quiz
(`${TPM_HOME}/claude-context/methodology/workflow-setup/`, the pre-spawn questions). If any answer is fuzzy, follow its
pointer and re-read before proceeding. This is a *workflow* gate, not a boot gate — when you are
just operating, there is nothing to gate.

## Where the deep reference + tools live

- **Deep shared reference** (read on demand): `${TPM_HOME}/claude-context/methodology/workflow-setup/` — charters,
  `plan-template`, spawn-mechanics, verify-and-reconcile, `prompt-templates/`, the pre-task
  questions, the self-quiz.
- **Tools** (mechanics — reference by their promoted path, all under `${TPM_HOME}/tools/workflow/`):
  `config-resolver.js` · `scaffold-subagent.js` · `compose-spawn-prompt.js` ·
  `lint-subagent-prompt.js` · `audit.js` · `cost-ledger.js` · `check-filename.js`.
  A skill never bundles its own tool copy — tools are shared project infra.

## `status` mode (inline)

No spawn. Report the current picture:
1. `node ${TPM_HOME}/tools/workflow/audit.js --out <tmp>/audit.md` — epic-vs-flat classification, numbering
   integrity, one-plan-one-charter per phase; relay violations.
2. Read `00-epic-plan/{epic-plan,punchlist,decisions}.md` for the phase map, open items, and the
   raise-to-user decision queue.
3. Read each active phase's `findings/HANDOFF.md` for current state (the single rolling doc).
4. Summarize: phases done / in-flight / pending, open punchlist items, decisions awaiting the
   user, and cost-to-date (`cost-ledger.js --rollup <epic>` if a ledger exists). Surface, don't act.

## `doctor` mode (inline)

No spawn. A **fail-loud preflight** for the install seams a real fan-out silently broke on (charters →
placeholders, gate hook not wired, compose bare paths, signoff unwritable). Run it before spawning a
round — especially the FIRST round in a fresh consumer:

1. `node ${TPM_HOME}/tools/workflow/doctor.js` (add `--json` for machine output; `--project-root <dir>`
   to check another install). It self-locates the bundle and reads the project's `.claude/settings.json`.
2. Checks: charters resolve · spawn-gate hook wired · `${TPM_HOME}` expand hook wired · signoff store
   writable · compose emits a quoted marker + `${TPM_HOME}/…` methodology paths.
3. Relay the ✓/✗ report verbatim. On any ✗, **stop and fix it before spawning** — each failure prints
   its own fix line. Exit 0 = clear to run; exit 1 = do not spawn yet.
