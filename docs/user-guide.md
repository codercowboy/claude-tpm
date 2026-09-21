# claude-tpm user guide

This is the day-to-day manual for driving `claude-tpm`: what it is, when to reach for it, and how to
run the loop that keeps a Claude Code project on track across sessions and across subagents.

If you want the pitch and the marketing framing, read the [README](../README.md). If you want to
install it, read [INSTALL.md](INSTALL.md). If you want the architecture and the why-it's-shaped-this-way
internals, read [technical.md](technical.md). This guide is the part in between: you have it installed,
now how do you actually use it?

---

## What claude-tpm is

`claude-tpm` turns your main Claude Code session into an orchestrator — a Technical Program Manager
(TPM) that holds state across sessions and coordinates fleets of subagents — instead of a single
assistant that forgets everything when you close the terminal and spawns helpers ad hoc.

It ships as a Claude Code plugin that delivers a handful of `tpm-*` skills, plus a zero-dependency
`tpm` command-line tool the skills call under the hood. You talk to the orchestrator; it breaks work
down, delegates pieces to subagents running in isolated contexts, checks their output, integrates it,
and reports back.

It solves three problems you hit once your work with Claude Code runs longer than one sitting:

- **Context evaporates between sessions.** You close the terminal and the next session starts cold —
  what you decided, what's half-done, and what's next are all gone. `claude-tpm` writes structured
  session notes so the next session picks up where the last one left off.
- **Multi-agent work is chaotic.** Spawning subagents by hand means no consistent plan, no
  verification step, and strays left running. `claude-tpm` runs subagents as formal rounds with a
  plan, defined roles, and a cleanup step.
- **Subagents drift.** Point a worker at too much process context and it reasons its way into writing
  an essay about why the task is hard instead of doing it. `claude-tpm` gives each subagent a single
  charter and a tight reading list so it stays focused.

The mental model: Claude stops being a chat assistant and becomes a program manager for your project —
one that remembers, tracks, delegates, verifies, and cleans up.

---

## When to reach for it (and when not)

Reach for `claude-tpm` when you do **sustained, multi-session, or multi-agent work** in one project
and you want continuity across sessions plus repeatable coordination of several subagents at once.

Skip it for **quick one-off edits or single-shot questions** — the ceremony isn't worth it there.
`claude-tpm` is scaffolding around the "just talk to Claude" core, not a replacement for it. You can
have it installed and simply not open a session on the days you don't need it.

If it doesn't sound like your fit, the [alternatives](alternatives.md) doc maps the neighbouring
tools — Superpowers, swarm orchestrators, parallel-session runners, and the honest option that
Claude Code's built-in subagents might already be enough.

---

## Before you start

This guide assumes `claude-tpm` is already installed in your project. The full install walkthrough —
prerequisites, the interactive installer, options, uninstall, and troubleshooting — lives in
[INSTALL.md](INSTALL.md). Don't re-teach yourself the install from here.

To confirm the wiring is healthy, run the read-only health check from your project root:

```
npx tpm doctor .
```

A healthy consumer project reports 9 of 9 checks passing and exits 0:

```
  [PASS] package.json exists
  [PASS] "@codercowboy/claude-tpm" declared as a dependency
  [PASS] marketplace "claude-tpm-market" registered
  [PASS] marketplace "claude-tpm-market" source resolves
  [PASS] plugin claude-tpm@claude-tpm-market installed
  [PASS] plugin claude-tpm@claude-tpm-market enabled for this project
  [PASS] plugin claude-tpm@claude-tpm-market cache present (loads)
  [PASS] plugin delivers its PreToolUse hooks (gate-spawn + expand-tpm-home)
  [PASS] consumer config.json is valid JSON (if present)
```

`doctor` changes nothing. If a check fails, it prints what's wrong; re-run `npx tpm install .` to
repair, and see the troubleshooting section of [INSTALL.md](INSTALL.md).

> One gotcha: `npx tpm doctor .` run *inside the claude-tpm library itself* reports two
> failures and exits 1, because the library is not its own consumer (it doesn't declare itself as a
> dependency or enable its own plugin). That's expected. The 9/9 PASS above is what a real project you
> installed it into looks like.

Slash commands work in two forms — the short `/tpm-session` and the namespaced
`/claude-tpm:tpm-session`. Use whichever you like; this guide uses the short form.

---

## The mental model

You only need a handful of concepts to operate `claude-tpm`. The full architecture is in
[technical.md](technical.md); this is the operating minimum.

- **Orchestrator.** The Claude session you talk to. It's the TPM: it takes your intent, plans, and
  delegates. It's the only actor that runs the `tpm-session`, `tpm-workflow`, `tpm-spawn`,
  `tpm-spawn-team`, and `tpm-reap` skills.
- **Subagents.** Isolated Claude workers the orchestrator spawns for a specific job. Each runs in its
  own context window and can't see your main conversation. A subagent never spawns its own subagents.
- **Charters.** A per-role posture handed to each subagent — "ship a working artifact" for a builder,
  "produce durable knowledge" for a researcher, "render a verdict, don't repair" for a verifier. A
  worker gets exactly one charter and never learns the others exist, which keeps it building instead
  of philosophizing.
- **Rounds and epics.** A *round* is one pass of the formal workflow: plan, spawn, verify, reconcile.
  An *epic* is a multi-phase piece of work, each phase a numbered folder under one `dev/<task>/` tree.
- **The work folder.** A round scaffolds a `dev/<task>/` folder that holds the plan, the charters, the
  spawn prompts, and each subagent's findings. It's the durable paper trail of the round.
- **Asymmetric trust.** The orchestrator is user-facing and self-correcting, so it's trusted lightly.
  Subagents work where you can't see them, so their output gets a critical eye. That's why a
  verification step exists.
- **Reading lists.** What each role reads is defined once, in a manifest, and the linter that gates a
  spawn parses that same manifest. Docs and enforcement can't drift apart.

---

## Your first session — a walked loop

Here is the core loop end to end: open a session, capture some work, run a round, checkpoint, and
close. Every command below was run and its output observed.

### 1. Open the session

From your project, start Claude and run the session-open skill:

```
claude

/tpm-session open
```

The orchestrator boots: it confirms the config and wiring, allocates or resumes a session number,
walks its reading chain, and reads back the prior session's handoff and open punchlist (via `boot-read`)
plus the task queue. A real boot looks like this (captured from an actual session):

> Session 019 open — TPM engine booted. Reading chain walked (project-workspace · handbook ·
> shared-conventions · prior notes · task queue).
>
> Prior state (session 018, sealed): claude-tpm SHIPPED and verified — pushed to
> github.com/codercowboy/claude-tpm, 0.1.0 published, both install routes 9/9 doctor-clean. No open
> items; arc complete.
>
> Task queue: ~40 open, newest #1090 (GitHub-ready publish prep, 3/6) and #1088 (node xyz.js → npx
> docs).
>
> You are in session 019 — claude-context/sessions/session-019/. What are we working on?

You don't have to memorize any of the machinery. Once it's booted, just talk to it. A good first move
on a fresh install is to ask it to explain itself: *"pretend I'm a brand new user — why would I use
claude-tpm?"*

### 2. Capture work in the task ledger

The task ledger is a plain, hand-editable markdown to-do list you and Claude both read. Add a task by
describing it; the skill drafts the entry and the tool stores it:

```
/tpm-task add wire up the export button on the reports page
```

Under the hood the skill stages a small markdown payload and calls the tool. The result:

```
added #1000 · Wire up the export button on the reports page
```

List the open pool (this is also what a bare `/tpm-task` does):

```
$ npx tpm task list
#1000   · today · Wire up the export button on the reports page
```

Move a task through its lifecycle as you work it:

```
$ npx tpm task start 1000
#1000 started.

$ npx tpm task finish 1000 --action "Wired the handler to exportCsv(); shipped."
#1000 finished.
```

`show` prints the full body, including the state fields the tool stamps:

```
$ npx tpm task show 1000 --state all
# #1000 · Wire up the export button on the reports page

- **State:** finished
- **Created:** 2026-09-16
- **Started:** 2026-09-16
- **Ended:** 2026-09-16
- **End action:** Wired the handler to exportCsv(); shipped.

**Summary:** Users can't export a report to CSV; the button is a no-op.

**Context:** The click handler in `reports/toolbar.js` is stubbed. It needs to call the existing `exportCsv()` in `lib/csv.js`.
```

Bigger items become epics with a subtask checklist. `add-subtask` appends one item and preserves the
existing checkboxes; `check` ticks one and refreshes the `(done/total)` counter shown in the list:

```
$ npx tpm task add-subtask 1001 "Document the export format"
added subtask #1001.C (0/3)

$ npx tpm task check 1001.A
checked #1001.A (1/3)

$ npx tpm task list
#1001   · today · Ship the CSV export feature (1/3)
```

Full task reference is in [the per-skill section](#62-tpm-task).

### 3. Run a formal round

When a piece of work is big enough to want a plan, subagents, and a verification step, run a workflow
round. The orchestrator plans it, then spawns a team:

```
/tpm-workflow plan add a CSV export endpoint with tests and docs
```

This is a deliberately high-ceremony path, and **you direct every kickoff through two separate gates**:

- **Gate A — questions answered.** The orchestrator presents the pre-task roster and questions, then
  stops and waits. Answering them clears the way to scaffold the round folder.
- **Gate B — spawn confirmed.** After scaffolding, the orchestrator asks an explicit "kick it off
  now?" and stops and waits. Only a fresh, unambiguous "go" spawns the subagents.

The argument you pass is the *spec*, never the sign-off — however detailed it is, the orchestrator
still runs both gates and waits for you at each. This is backed by a mechanical hook that blocks a
spawn without a fresh sign-off token, so the gate holds even if the prose gets rationalized away.

Once you confirm, pick a team (or let it default to `full`). The orchestrator spawns the roster in
order, verifies the result, and reconciles it back. The [six built-in teams](#the-six-built-in-teams)
are listed below. The workflow modes are `plan` → `run` → `verify` → `reconcile`, plus `status`,
`doctor`, and `reap`; see [the per-skill section](#63-tpm-workflow).

### 4. Checkpoint mid-session

Whenever you've reached a state worth saving, checkpoint it:

```
/tpm-session save
```

A session's memory lives in **two files** in its folder — ONE canonical `session-NNNN.json` (the source
of truth) and ONE derived `session-NNNN.md` (a human view regenerated from the JSON on every write, with
`## Handoff` / `## Punchlist` / `## Log` sections). `save` runs a fixed 3-step ritual over the record:
reconcile the punchlist (`ops punchlist --action …`), append any ledger lines (`ops note --log/--decision`),
then replace the handoff (`ops import-handoff`) and persist (`ops save`). Each write rewrites the JSON
atomically and re-renders the `.md`.

The record is the durable memory the next `open` reads back. Its `## Handoff` section is what a cold
resume reads first (verified render):

```markdown
## Handoff

**Where we are:**
Toolbar button shipped and wired to exportCsv(); backend endpoint still pending.

**Next:**
Add the backend export endpoint.

**In flight:**
- backend export endpoint
```

The handoff is gated: `where` and `next` are required, and `ops import-handoff` refuses (writing nothing,
exit 1) if `next` is missing. Repeated saves in one session rewrite the same session's `session-NNNN.json`
wholesale (the log and punchlist are append/mark-only). They don't spawn a new session number — only
`open` (via `current --open`) allocates one.

### 5. Close the session

When you're done, wrap up:

```
/tpm-session close
```

Close writes a final checkpoint and offers to reap any stray subagents left from your rounds (see
[tpm-reap](#66-tpm-reap)). The next time you `open`, the orchestrator reads back this sealed session's
handoff (via `boot-read`) and resumes from its "Where we are / Next" head.

That's the whole loop: `open` → work with `tpm-task` and `tpm-workflow` → `save` → `close`.

---

## Per-skill usage reference

Six skills ship with `claude-tpm`. The first two (`tpm-session`, `tpm-task`) you use constantly; the
next three (`tpm-workflow`, `tpm-spawn`, `tpm-spawn-team`) run formal multi-agent rounds; the last
(`tpm-reap`) cleans up.

Every skill is a thin router: it interprets a fuzzy mode or role token (normalize → intent-match →
confidence-gate), echoes how it read your argument (`Reading "<arg>" as → mode: <mode>`) before it
acts, and forwards the mechanics to the `tpm` CLI. You can spell modes loosely; obvious misspellings
still resolve.

### 6.1 tpm-session

**Purpose.** Boot, checkpoint, and wrap a session so its state survives across sessions in one canonical
record per session — `session-NNNN.json` (the source of truth) + a derived `session-NNNN.md` with
`## Handoff` (the pickup doc), `## Punchlist` (open/done work items), and `## Log` (the decisions + log
ledger). This is the backbone — the orchestrator's boot and the
first thing you run.

**When to reach for it.** Starting work (`open`), mid-session to save state (`save`), wrapping up
(`close`), or checking where you are (`info`).

**Modes.**

| Mode | Aliases | What it does |
|---|---|---|
| `open` | start, begin, boot | Boots the session: confirms config, allocates or resumes a session number, walks the reading chain, loads prior notes and the task queue. |
| `close` | end, finish, wrap | Wraps up: final checkpoint, notes seal, and offers reap. |
| `save` | write, checkpoint, snapshot, record, note | Runs the 3-step checkpoint: reconcile the punchlist, append any ledger lines, replace the gated handoff via `ops import-handoff` + persist via `ops save`. |
| `info` | status, current, which, where, show | Prints the current session number, whether notes exist, and the session count. Writes nothing. |

**Bare `/tpm-session` is state-aware:** not opened yet → runs `open`; already open → runs `save`. It's
not an error and shows no menu. It resolves the choice by reading the current-session pointer, the same
mechanism `open` and `save` use to find their own session.

**What `open` does, in order.** It allocates or confirms the session number (idempotent — a second
`open` in the same session returns the *same* number, never mints a new folder), reads the module map,
walks the orchestrator reading list fresh from its manifest, calls `boot-read` to pull the prior
session's handoff and open punchlist into context (it always excludes the just-opened session and
never crashes boot), loads the task queue, prints the capabilities menu (only the enabled skills), and
ends with the session footer. That is why a boot both remembers the last session and knows what you can
reach for.

**What `close` does, in order.** It runs the reap ritual (offer to close strays — never auto-kills),
delegates to `save` to write the final checkpoint, seals the notes and the session pointer so the next
`open` starts fresh instead of reusing this folder, nudges you to `/export` the transcript, and prints
a terse sign-off (deliberately *not* the capabilities menu — you're stopping, not starting). Sealing is
the fix for the old "every close mints a new session folder" bug: `open` establishes the folder once
and `save`/`close` only ever update it.

**Gotchas.**

- Every mode ends by printing the "you are in session NNN" footer last.
- `save` never silently opens a session; if none is open it tells you and runs `open` instead.
- A "reap"-shaped argument redirects to `/tpm-reap` — there is no `tpm-session reap` mode.
- Two config flags gate it: `session.enabled` (the whole skill) and `session.notes.enabled` (just the
  notes writes).

**Worked example.** The walked loop above shows `open`, `save`, and `close` end to end. To just check
where you are without writing anything, run `/tpm-session info`.

**The CLI underneath.** The skill drives `npx tpm session <verb>`:

```
tpm session — session-notes tooling router

Verbs:
  config     resolve session config / sessions-dir (--json / --sessions-dir / --get / --modules)
  current    the current-session pointer (--state / --open / --seal / --next-number)
  ops        the notes WRITE surface (open / save / note / punchlist --action / close / import-handoff|log|punchlist)
  export     the notes READ / export API (--last N | --session NNNN · --style json|human|both · --out)
  migrate    opt-in convert ONE old 3-file markdown session → canonical JSON (--in / --out-dir)
  boot-read  the boot-time pickup emit (prior handoff + open punchlist); never crashes boot
  doctor     READ-ONLY health check: validate + hash-drift + suggest-migrate
```

You rarely type these yourself, but they're useful for scripting or inspection. For example, read back
the most recent session without opening one:

```
$ npx tpm session export --sessions-dir <dir> --last 1 --style human
# Session 0001 · 2026-09-16

## Handoff

**Where we are:**
Toolbar button shipped; endpoint pending.

**Next:**
Add the backend export endpoint.
```

### 6.2 tpm-task

**Purpose.** A lightweight, shared, hand-editable markdown to-do list that you and Claude both read.
It is **not an issue tracker** — keep it skimmable.

**When to reach for it.** Capturing and tracking work items across sessions, jotting a TODO, or
marking progress.

**Modes (13).** `add` · `import` · `export` · `list` · `show` · `edit` · `check` · `add-subtask` ·
`start` · `finish` · `drop` · `remove` · `reopen`.

| Mode | What it does |
|---|---|
| `add` | Add one task. You describe it; the skill drafts the entry. |
| `import` | Batch-add several tasks from one markdown payload. |
| `export` | Serialize tasks to one file (round-trips back through `import`). |
| `list` | Show the compact view. Default pool is open + in-progress; `--state` widens it. |
| `show` | Print the full body of a task or selection. |
| `edit` | Rewrite a task's content fields. Note: editing subtasks *replaces* the whole checklist and resets progress. |
| `check` | Tick one subtask (`<id>.<LETTER>`) and refresh the `(done/total)` counter. |
| `add-subtask` | Append one subtask, *preserving* the existing items and their check state. |
| `start` | Move a task to in-progress. |
| `finish` | Mark done (records the end action). |
| `drop` | Cancel with a reason. |
| `remove` | Soft-stash to removed (recoverable), or `--hard` to purge. |
| `reopen` | Bring an ended or removed task back to open. |

**Bare `/tpm-task` or "list" runs `list`.**

**Selectors.** Task-referring modes share one selector grammar: deterministic selectors (`all`, a
single id like `1234`, a comma list `1,2,3`, or an ascending range `1-5`) hand straight to the tool; a
semantic ask ("the auth ones") is resolved by the skill, which echoes the concrete id set for you to
confirm before it acts.

**Gotchas.**

- The skill echoes the resolved concrete id set before any destructive mode (`finish` / `drop` /
  `remove`).
- There's no `uncheck` mode — un-ticking a subtask is a hand-edit.
- Use `add-subtask` (not `edit`) to grow an epic's checklist, or you'll reset its progress counter.
- Illegal state transitions fail loudly with the current state named:

```
$ npx tpm task start 1000       # 1000 is already finished
task: cannot start #1000: it is "finished". (reopen it first to start again)
```

**Worked example.** The full add → list → start → finish → show → epic flow is in the walked loop
above.

**The payload underneath.** You describe a task in prose and the skill drafts it, but the mechanics
take a small markdown payload passed with `--from`. One task is one `# ` heading with optional
`**Summary:**` / `**Context:**` / `**Subtasks:**` blocks:

```markdown
# Ship the CSV export feature

**Summary:** End-to-end CSV export: button, endpoint, and docs.

**Subtasks:**
- [ ] A. Wire the toolbar button
- [ ] B. Add the backend endpoint
```

Subtask lines must carry the letter prefix (`- [ ] A. …`); the tool derives the ids from them.
Unlettered checklist lines are dropped with a warning rather than silently guessed. Verified: a
payload whose subtasks were bare `- [ ] …` lines produced `⚠️ … NOT in a managed field … DROPPED`.
Multiple `# ` blocks in one file is a batch, which is what `import` ingests.

**The CLI underneath.** All mechanics run through `npx tpm task`, one unified usage:

```
Usage: npx tpm task [--tasks-dir <path>] [--config <path>] <subcommand> [args]
Subcommands (via the router → tpm-task.js):
  list [--state open|in-progress|finished|dropped|removed|all] [--label <l>]
  show <id>
  add --headline "<…>" [--summary "<…>"] [--context "<…>"] [--label <l>]… [--body-txt-file <f> --field summary|context]
  import <id> (--file <f.json> | stdin) [--prune]      # per-id JSON, editable fields only
  import --template                                     # emit a blank editable-fields JSON skeleton
  edit <id> [--headline …] [--summary …] [--context …] [--label …]
  add-subtask <id> --text "<…>"
  check <id> <key>
  label / unlabel <id> <label…>   ·   labels [--json]
  start <id>
  finish <id> [--action "<…>"] [--note "<…>"] [--ref "<…>"]…
  drop <id> [--reason "<…>"] [--note "<…>"] [--ref "<…>"]…
  remove <id> [--hard]          # --hard PURGES the body; config-gated on tasks.allowHardDelete (off by default)
  reopen <id>
  reindex   ·   history <id> [--json]

Reached through the router but implemented in tpm-task-export.js:
  export|search <selector…> [--state <s>] [--open|--closed] [--label <l>] [--match <t>]
                            [--opened-since|--updated-since|--closed-since <Nd|date>] [--last N --by updated|created|closed]
                            [--json|--human] [--out <dir|file>]   # default: --human to stdout
```

(`reindex` / `history` are mostly tool-internal — the skill uses them; you rarely type them. There is
no `resolve` verb — use `search`/`export` selectors.)

### 6.3 tpm-workflow

**Purpose.** The single front door over the formal multi-agent round and epic lifecycle: scaffold a
`dev/<task>/` folder, write the plan and charters, spawn workers, verify the artifact, and reconcile
the results. It's a thin router that delegates the actual spawning to `tpm-spawn` and
`tpm-spawn-team`.

**When to reach for it.** When you explicitly want to plan a round, run an epic, verify an artifact,
or close an epic. It **never auto-fires**. Just operating (a light edit, a quick answer) does not
go through here.

**Modes.**

| Mode | What it does |
|---|---|
| `plan` (default) | Ask the pre-task questions, scaffold the round folder, write `plan.md`, and compose plus lint the spawn prompt. |
| `run` | Spawn per the plan. Delegates to `tpm-spawn` (single) or `tpm-spawn-team` (a roster). |
| `verify` | Spawn the verifier(s) and, on a FAIL, run the verify↔bug-fixer loop. |
| `reconcile` | Judge the verdict, reconcile the delivered and verified output, update the epic plan, and promote or close. |
| `status` | Report round and epic state (phase map, punchlist, decisions). No spawn. |
| `doctor` | Fail-loud preflight before a round: confirms charters resolve, the sign-off store is writable, and the prompt composer emits its gate marker. No spawn. |
| `reap` | Delegates to `tpm-reap`. |

Bare `/tpm-workflow` runs `plan`.

**The two-gate kickoff (the critical rule).** You direct every kickoff through two separate gates that
each end the orchestrator's turn and wait for you:

- **Gate A** — the orchestrator presents the pre-task roster and questions and waits. Your answers
  gate the *scaffolding*.
- **Gate B** — after scaffolding, the orchestrator asks "kick it off now?" and waits. Only a fresh,
  explicit "go" gates the *spawn*.

The argument text is the spec, not the sign-off. This is enforced mechanically: scaffolding requires a
pre-task acknowledgement receipt, and a `PreToolUse` hook blocks the spawn unless a fresh sign-off
token exists. Sign-offs are recorded with `npx tpm workflow signoff questions` (Gate A) and
`npx tpm workflow signoff spawn` (Gate B).

**Gotchas.**

- `tpm-workflow` is **orchestrator-only** — a subagent never invokes it.
- Run `doctor` before your first round in a fresh install; fix any ✗ before spawning. A healthy run:

```
$ npx tpm workflow doctor
  ✓ charters resolve
  ✓ signoff store writable
  ✓ compose emits marker + tokens
✓ all preflight checks pass
```

- Check where a round stands at any time with `signoff status`:

```
$ npx tpm workflow signoff status
questions  FRESH (891s)
spawn      — "spawn" sign-off is STALE (74951s old > 1800s max)
```

  A "spawn" sign-off is fresh for 30 minutes by default — long enough for a round's spawns to follow
  one confirmation, short enough that yesterday's "go" can't authorize today's round. The two tokens
  are different events: the **questions** token (Gate A) only has to *exist* to clear scaffolding,
  while the **spawn** token (Gate B) must be *fresh* — the hook checks it right before the spawn. Both
  live as small JSON files under `<project-root>/tmp/tpm-signoff/`, keyed by round so one round's "go"
  can't wave through another; `npx tpm workflow signoff clear` wipes them when a round is done. In an
  empty store, `signoff status` reports `no "questions" sign-off token on disk` for each gate; once
  Gate A is recorded it reads `questions FRESH (0s)`.

- Verifier verdicts land at `findings/verifier-r<N>-v<M>-verdict.md` in the round folder — "verdict",
  not "findings", so the filename guard lets it through. The rolling per-phase state doc is always
  `findings/HANDOFF.md`.

- `plan` asks three big-rock questions and collapses the rest to one line; pass `-v` / `--verbose` to
  expand the secondary set to full questions.

**Worked example.** See [step 3 of the walked loop](#3-run-a-formal-round). The short version:
`/tpm-workflow plan <what you want>` → answer the roster (Gate A) → confirm "kick it off" (Gate B) →
the round runs and reconciles.

**The CLI underneath.** `npx tpm workflow <verb>`: `audit`, `compose`, `lint`, `scaffold`, `cost`,
`signoff`, `doctor`, `config`, `check-filename`. Most of these are plumbing the skill calls for you —
see [under the hood](#under-the-hood-the-tpm-cli).

### 6.4 tpm-spawn

**Purpose.** Fire a single subagent through the Agent tool. It owns the *role* judgment, then runs the
standard scaffold → compose → lint → Agent flow.

**When to reach for it.** When you want one lone worker and no full round — a single builder,
researcher, verifier, and so on. It's also the delegate that `tpm-workflow run` uses for a single-agent
spawn.

**The seven canonical roles.** `planning` · `builder` · `test-writer` · `documentarian` · `verifier`
· `bug-fixer` · `researcher`. (A child project can add its own on top.) You can name a role loosely —
"write tests" resolves to `test-writer`, "look into X" to `researcher` — and the skill echoes
`Reading "<arg>" as → role: <role>` before it spawns.

**The flow.** For each spawn the skill:

1. Scaffolds the work folder (`npx tpm workflow scaffold`) — creates the numbered phase folder with a
   `plan.md` stub, the role's `charter-<role>.md`, the spawn-prompt stub, and `findings/ tools/ tests/
   tmp/`.
2. Fills `plan.md` (structure only — the posture lives in the charter file).
3. Composes the spawn prompt (`npx tpm workflow compose`) — emits the working-folder line, the read
   order, the env-source ritual, constraints, and the return shape.
4. Lints the prompt before the Agent call (`npx tpm workflow lint`). It does not spawn on a FAIL.
5. Spawns the subagent in the background with the resolved model.

**Gotchas.**

- **Orchestrator-only** and gated by the same hard rule: never spawns without your explicit direction.
- If a `findings/HANDOFF.md` already exists in the target folder, the subagent is told to read it
  before `plan.md` (a resumed round), and the prompt is linted with `--resume`.
- The `bug-fixer` role is the verify-loop fixer: `/tpm-spawn bug-fixer` is the right front door for a
  one-off manual fix when you already have a verifier's verdict in hand.

**Worked example.**

```
/tpm-spawn researcher survey how other tools handle CSV escaping edge cases
```

The orchestrator echoes the resolved role, scaffolds the folder, composes and lints the prompt, asks
you to confirm, and on your "go" spawns one researcher subagent in the background.

### 6.5 tpm-spawn-team

**Purpose.** Fire a team of two or more subagents as an ordered roster. It owns the *roster* judgment —
which roles, how many, in what order, and how peers run — then delegates each individual spawn to the
`tpm-spawn` flow.

**When to reach for it.** When you need two or more roles with ordering or counts. A single role with
count 1 isn't a team; the skill tells you to use `/tpm-spawn` instead.

**Two ways to specify a team:**

- **A named team** — one of the six shipped rosters (see below).
- **A freeform roster** — `researcher followed by a builder`, `builder then 2 verifiers`,
  `2 researchers + a planner + a builder + 3 verifiers`. Order and counts are load-bearing; connective
  words (`then`, `followed by`, `and`, `+`, `with`) are separators.

**`--mode serial | parallel`** sets how *same-role peers within a stage* run (default `serial`). The
**pipeline barriers between stages are always hard**:
`researcher(s) → planning → builder(s) → test-writer(s) → documentarian(s) → verifier(s)`. Delivery →
verifier is a hard gate — a verifier reads the finished artifact from disk, so it can't start until
every delivery agent ahead of it finishes. `--mode parallel` on `builder + verifier` means "run the
verifiers in parallel with each other, after the builder finishes," not "run builder and verifier at
once."

**Gotchas.**

- **Orchestrator-only.**
- The skill echoes the full ordered roster and resolved mode before it spawns anything.
- Two builders in a roster is ambiguous (one shared artifact, or two independent phase folders), so
  the skill asks which before scaffolding.
- The verify↔bug-fixer loop is not this skill's job; it's orchestrator-owned and wired into
  `tpm-workflow`'s `verify` mode.

**Worked example.**

```
/tpm-spawn-team docs
```

expands to the fixed `docs` roster (documentarian → verifier): the documentarian writes the docs, then
the verifier checks them. The skill echoes the roster, and on your confirmation spawns them in order.

### 6.6 tpm-reap

**Purpose.** Enumerate and safely close stray subagents, subshells, or runaway scripts left after a
round or an abort. It's core and always-on, not workflow-only.

**When to reach for it.** When a round ends or is aborted, or you suspect strays are still running.
`tpm-session close` and `tpm-workflow`'s `reap` mode both invoke it too.

**The one safety rule: it NEVER auto-kills.** Reaping is always a five-step dialogue:

1. **Enumerate** the candidate strays with enough identity to tell them apart (PID, task id, role,
   phase, how long it's run).
2. **Nothing found → say so and stop** ("No strays — nothing to reap"). A clean report is the success
   case.
3. **Explicit user choice** — you name which to close; the skill echoes the exact resolved set
   (`Closing → [PID 4821 builder-r2, task tpm-abc123]`).
4. **Double-confirm for "all"** — closing everything requires a second explicit confirmation.
5. **Close only the confirmed** — anything not explicitly confirmed keeps running.

**Worked example.**

```
/tpm-reap
```

Bare `/tpm-reap` runs the enumerate step only and presents the candidates plus the choices. You then
name which to close, and the skill confirms before acting.

---

## The six built-in teams

When you run a round, you pick from six built-in teams. The array order is the run order.

| Team | Roster (run order) | When |
|---|---|---|
| `full` *(default)* | planning → builder → test-writer → documentarian → verifier | The complete separated-concerns round. |
| `ship` | builder → verifier | The builder wears all hats (artifact, its tests, its docs), then verify. |
| `build` | builder | A quick, unverified build. |
| `test` | test-writer → verifier | Add tests to already-delivered code. |
| `docs` | documentarian → verifier | Add docs to already-delivered code. |
| `research` | researcher | A one-off info-gathering pass. No verify. |

Any team that ends with a verifier runs a bounded **verify↔bug-fixer loop** on a FAIL: the verifier
reports a verdict, the orchestrator judges it, a bug-fixer makes exactly the fixes it named, the
verifier re-checks, repeating up to `verifyLoopCap` (default 5) cycles. The verifier renders the
verdict; it never repairs what it checks, and it stays blind to the loop. That independence is what
makes the verdict trustworthy. The kickback goes to a `bug-fixer`, never to a fresh builder.

Two separate retry mechanisms are at work; don't confuse them:

- **Per-agent retry (`retryCount`).** An agent that *bails without delivering* is re-run up to its
  own cap. The shipped defaults (from `workflow config`) give delivery/fix roles more room — **builder
  and bug-fixer retry up to 5**, every other role once. This forces delivery; it isn't the verify loop.
- **Verify↔bug-fixer loop (`verifyLoopCap`, default 5).** This runs only on a verified FAIL, and the
  bug-fixer is the *only* thing that repeats — the delivery agents each run once, in roster order.

With more than one verifier, they run blind to each other and (with `verifier.requireAllPass`, on by
default) the round passes only if every verifier passes. A phase can also complete as
**partial-with-stated-gap**: a working artifact plus a measured gap that becomes a follow-on
phase, rather than grinding toward 100%.

---

## What a round leaves on disk

A round scaffolds a durable paper trail under `dev/`, and knowing its shape helps you read or resume
one. A single flat round is one numbered phase folder; an **epic** is
several phase folders plus a shared `00-epic-plan/` at the root. This guide was itself written by an
epic, whose layout looks like:

```
dev/<epic>/
  00-epic-plan/            # orchestrator-owned, charter-clean
    epic-plan.md           #   the phase map
    punchlist.md           #   done / pending / cut
    decisions.md           #   the call log (items tagged "raise to user")
  01-<phase>/              # a numbered phase folder
  02-<phase>/
    plan.md                #   structure only — the DoD table, task, constraints
    charter-<role>.md      #   one per role — the posture (workers read only their own)
    spawn-prompt-<role>-r<N>.md   #   the composed, linted prompt actually sent
    findings/HANDOFF.md    #   the single rolling state doc for the phase
    findings/verifier-r<N>-v<M>-verdict.md   #   the verifier's verdict, when one ran
    tools/ tests/ tmp/     #   the deliverable's supports and per-agent scratch
```

Each retry re-runs in the **same** phase folder (the `-r<N>` prompts are the history); a genuinely new
stage is a new numbered phase, never a `HANDOFF-v2.md`. Nothing promotes to the project root mid-epic —
`reconcile` does per-phase checkpoints (update the punchlist, log the decision, write the cost row), and
only the user-gated **epic-close** promotes the planned deliverables out of `dev/` and seals the epic
records immutable. You can check where any round stands without spawning anything: `/tpm-workflow
status` reads that `00-epic-plan/` tree and each phase's `HANDOFF.md` and summarizes.

---

## Under the hood: the tpm CLI

Under the skills sits the `tpm` command-line tool: `tpm <suite> <verb> [args…]`. You'll mostly let the
skills call it, but it's there for scripting and inspection. The top-level help:

```
$ npx tpm --help
tpm — claude-tpm command dispatcher

Usage:
  tpm <suite> <verb> [args…]

Suites:
  session    session-notes tooling   (config / current / notes / review)
  task       task ledger             (add / list / show / … / config)
  workflow   multi-agent rounds      (audit / compose / lint / scaffold / cost / signoff / doctor / config)
  hooks      PreToolUse hooks        (gate-spawn / expand-tpm-home)

Consumer adoption:
  install [dir] [options]     graft claude-tpm onto an existing project
  uninstall [dir] [options]   reverse it (asks: this project only, or the whole system)
  doctor [dir]                read-only health check (= install --check)
```

Four suites plus three flat consumer aliases:

- **`session`** and **`task`** are the ones you'd reasonably type by hand — inspecting config, reading
  back notes, or scripting the ledger. A few useful ones:

  ```
  npx tpm session config --modules   # which modules are ON/OFF (JSON)
  npx tpm task list                  # show open tasks
  npx tpm workflow doctor            # workflow-side preflight
  ```

- **`workflow`** verbs (`compose`, `lint`, `scaffold`, `signoff`, `audit`, `cost`) are mostly
  orchestrator plumbing the skills invoke for you. You'll rarely type them directly. The exhaustive
  verb tables are in [technical.md](technical.md).

- **`hooks`** (`gate-spawn`, `expand-tpm-home`) are harness-invoked `PreToolUse` hooks delivered by the
  plugin. You do not wire these by hand — they're how the kickoff gate is enforced.

- **`install` / `uninstall` / `doctor`** are the consumer lifecycle aliases; see [INSTALL.md](INSTALL.md).

One filename convention the workflow tools enforce: deliverable filenames
whose basename contains `report`, `summary`, `analysis`, or `findings` are blocked (a server-side
guard on skill-authored files). That's why round handoffs are named `HANDOFF.md`, not `findings.md`:

```
$ npx tpm workflow check-filename my-findings.md
BLOCKED: "my-findings.md" contains blocked pattern "findings". Rename it (avoid: report, summary, analysis, findings).

$ npx tpm workflow check-filename plan.md
OK: "plan.md" does not match any blocked pattern.
```

---

## Configuration

Configuration lives in one file: `.claude/claude-tpm/config.json`. Every module is on by default with
sensible built-ins, so you only add config to *change* something — an absent or partial config just
means defaults, never an error.

See which modules are enabled:

```
$ npx tpm session config --modules
{
  "session": true,
  "workflow": true,
  "tasks": true,
  "hygiene": true
}
```

`hygiene` reports `true` here but ships **no `tpm-hygiene` skill yet** — the module is
enabled-by-default in config ahead of the drift-detection work it will eventually front, so `open` does
not list it in the capabilities menu. The other three back the skills you use every day.

A fully worked config with every knob explained is in the [config guide](config-guide.md).
Full config reference, including the per-role `retryCount` and the `verifyLoopCap` retry knobs, is in
[technical.md](technical.md).

---

## Caveats & gotchas

- **`claude-tpm` rides entirely on the Claude Code CLI.** It *is* a Claude Code plugin — no `claude` on
  your PATH means nothing to plug into.
- **It grafts onto an existing project; it won't create one.** You need a repo with a `package.json`
  first (`npm init -y` if you don't have one).
- **v0.1.0, Mac-first, works-on-my-machine.** No pinned minimum Node version and no cross-platform test
  pass yet. It's distributed from GitHub only, not the public npm registry.
- **The orchestrator never spawns a round on its own.** Every kickoff is behind the two-gate rule; the
  argument you pass is the spec, never the sign-off.
- **`tpm-reap` never auto-kills.** Every close is explicit, and closing "all" needs a second
  confirmation.
- **The workflow, spawn, and spawn-team skills are orchestrator-only.** A subagent follows its spawn
  prompt and plan; it never runs the round lifecycle or spawns its own subagents.

---

## Where to go next

- **[INSTALL.md](INSTALL.md)** — install, verify, options, uninstall, troubleshooting.
- **[technical.md](technical.md)** — architecture, the CLI dispatcher, the module model, plugin and
  marketplace mechanics, the two `PreToolUse` hooks, and the dependency breakdown.
- **[alternatives.md](alternatives.md)** — when to pick a different tool.
- **[config guide](config-guide.md)** — a fully worked `config.json` and every knob.
- **The README's [Resources](../README.md#resources)** — the "just talk to it" core `claude-tpm` is
  built around, starting with Boris Cherny's talk on using Claude Code.

And the best first move on a fresh install: open a session and ask Claude how any of this works.
