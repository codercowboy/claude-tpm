---
name: tpm-task
description: Use to capture, track, and manage a project's lightweight task ledger — a shared, hand-editable markdown to-do list Claude and the user both read. `/tpm-task <mode> <freeform>` where mode is add · import · export · list · show · edit · check · add-subtask · start · finish · drop · remove · reopen. Bare "/tpm-task" or "list" shows the open tasks. The tool owns all mechanics; this skill owns judgment (draft content, detect epics, confirm destructive ops). NOT a real issue tracker — keep it skimmable.
---

`tpm-task` is the task-ledger skill. It is a **thin router**: it interprets a fuzzy mode token,
does the small amount of JUDGMENT each mode needs (draft content, detect an epic, resolve + echo a
selector, confirm destructive ops), then forwards the MECHANICS to `%TPM_HOME%/tools/task/tpm-task.js` and relays
its compact output. **The skill never hand-reads or hand-writes the store** — one clean write path,
the tool.

| Mode | Aliases | Body |
|---|---|---|
| **`add`** | new, queue, create, todo, remember, note, capture, log | [`modes-mutate.md`](./modes-mutate.md) |
| **`import`** | add-from-file, from-file, ingest, convert, bulk-add, load | [`modes-mutate.md`](./modes-mutate.md) |
| **`edit`** | amend, update, modify, revise, change | [`modes-mutate.md`](./modes-mutate.md) |
| **`export`** | serialize, dump, save to file, extract to, write out | [`modes-mutate.md`](./modes-mutate.md) |
| **`finish`** | done, complete, close, ship, shipped | [`modes-end.md`](./modes-end.md) |
| **`drop`** | cancel, retire, wontfix, won't do, abandon, shelve, park, decline, skip | [`modes-end.md`](./modes-end.md) |
| **`remove`** | delete, rm, purge, erase, destroy, wipe | [`modes-end.md`](./modes-end.md) |
| **`reopen`** | restore, undo, revive, unfinish, resurrect, bring back | [`modes-end.md`](./modes-end.md) |
| **`list`** | ls, all, open, what's on, todos | inline, below |
| **`show`** | view, get, display, detail, cat | inline, below |
| **`check`** | tick, mark, x, check off, mark done | inline, below |
| **`add-subtask`** | add subtask, append subtask, new subtask, add step, add a checklist item | inline, below |
| **`start`** | begin, wip, working, active, in progress, pick up | inline, below |

## Tools this skill calls (promoted paths)

- `npx tpm task config --tasks-dir` — resolves the configured store dir (absolute path).
  Also `--json` / `--get enabled` to read the config. (The resolver returns the `tasks` SECTION,
  so keys are bare — `--get enabled`, `--get startId` — NOT `--get tasks.enabled`.)
- `npx tpm task --tasks-dir <dir> <subcommand> [args]` — ALL mechanics. Its header
  docstring / [`tpm-task.md`](../../tools/task/tpm-task.md) is the full reference.

All of `%TPM_HOME%/tools/task/` is self-contained (zero shared imports, per `tool-conventions.md` Part I §2).
Run every invocation from the project root; `--tasks-dir` is the resolved absolute store path.

## Config gate

Read `tasks.enabled` via `npx tpm task config --get enabled` (or `--json`).
`enabled: false` ⇒ reply one line — "task ledger disabled by config (tasks.enabled: false)" — and stop.
The tool ALSO gates itself, so this is a courtesy short-circuit, not the only guard. Missing config ⇒
defaults (system ON).

## Interpreting the mode token (forgiving)

1. **Normalize** — lower-case, collapse whitespace, strip punctuation.
2. **Intent-match** — the aliases table above; obvious misspellings still resolve (`ad`, `lst`, `fin`,
   `chk`). An `add` that names a file / says "from file" → `import`.
3. **Confidence gate** — resolve only when confident. Empty/ambiguous/unmatched arg → show the mode
   table and stop; do NOT guess.
4. **Echo before acting** — `Reading "<arg>" as → mode: <mode>` so a mis-parse is a visible line to
   correct before anything runs. **Mandatory before any state-changing mode.**

**Collision rules (§8):** ambiguous token (`open`, `close`, `show all`) + a target present → `show`;
no target → `list`. A target carrying a subtask sub-id (`1245.A`) + a done-ish verb → `check`, not
`finish`. Unsure on a **state-changing** mode → echo + ask, never guess.

**Bare `/tpm-task` (no argument)** is not an error and does not show the table — run **`list`**.

## Selectors (shared grammar — §5)

Every task-referring mode takes the same selector language:
- **Deterministic** (hand straight to the tool): `all` · `<id>` (`1234`, `#1234`) · `<id>,<id>,…` ·
  `<start>-<end>` (ascending; descending is an error; a range matching nothing warns; sparse ranges
  skip). Natural-language time windows ("finished last week") are **lowered by YOU** to
  `resolve --state <pool> --since <Nd>` (G6) — the tool does not parse prose.
- **Semantic** (`the auth ones`, `anything about the rename`): read candidate headlines via
  `tpm-task.js list`/`show`, pick the matching ids yourself, **echo the resolved concrete id set for
  confirmation**, then call the tool with that explicit id-list. The tool never guesses semantics.

## Inline modes — "call the tool, relay"

These need no drafting; interpret args, call the tool, relay its output verbatim (compact).

- **`list`** → `tpm-task.js --tasks-dir <dir> list [--order newest|oldest|id|state] [--state <s>]`.
  Default pool is open + in-progress. `--order` aliases: recent/new→newest, stale/old→oldest,
  num→id, status→state. `--state` widens to finished/dropped/removed/all.
- **`show`** → resolve the selector, then `tpm-task.js … show <selector> [--state <s>]`. For a semantic
  ask, echo the resolved ids first.
- **`add-subtask`** → `tpm-task.js … add-subtask <id> "<text>"`. Appends ONE lettered subtask, PRESERVING
  the existing items and their check state (unlike `edit`, whose `setSubtasks` REPLACES the block and
  resets progress). Use this to grow an epic's checklist without clobbering a `(3/8)`.
- **`check`** → `tpm-task.js … check <id.LETTER>` (e.g. `1245.A`; `1245a`/`#1245.A` also accepted). Ticks
  one subtask and refreshes the epic's `(done/total)`. No `uncheck` mode — un-ticking is a hand-edit
  (G5). Already-checked ⇒ the tool reports a no-op.
- **`start`** → `tpm-task.js … start <id>` (→ in-progress). Redundant/illegal transitions are the tool's
  job to report (G3) — relay its message.

Everything with real judgment (drafting content, detecting epics, the import collaboration flow, the
destructive-confirm dialogue) lives in the two mode files, loaded only when that mode runs.

## Universal rules

- **Stage payloads, pass `--from`** (Q11): for `add`/`edit`/`import`, write the drafted content to
  `./tmp/tpm-task/<mode>-<slug>.md` and pass `--from <that path>`. Never inline multiline content on
  the command line. Payload format is in [`modes-mutate.md`](./modes-mutate.md).
- **Echo the resolved concrete id set before any destructive mode** (finish/drop/remove) — §7.
- **Keep it skimmable.** This is a low-friction ledger, deliberately NOT an issue tracker. If the open
  list crosses `maxOpenWarn`, nudge the user to finish/drop stale items rather than growing the system.
