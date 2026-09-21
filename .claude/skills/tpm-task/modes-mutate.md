# `tpm-task` — content modes (`add` · `edit` · `import` · `export`)

Loaded when the router resolves a content mode. These are the modes with real drafting judgment. The
mechanics (id allocation, bucketing, index updates) are all the tool's — your job is to author good
content and hand it to the tool as flags, or, for `import`, as a per-id JSON object.

## How content reaches the tool

There is no markdown payload file and no `--from` flag. Content goes in as CLI flags; a long body goes
in from a text file:

- **`add` / `edit`** take the fields directly:
  - `--headline "<≤ ~8 words>"` (required for `add`)
  - `--summary "<one or two sentences>"`
  - `--context "<what / why / trigger; cross-refs in backticks>"`
  - `--label <L>` (repeatable) or `--labels "a,b"`
  - `--body-txt-file <f> --field summary|context` — read a long summary or context body from a file
    instead of quoting a multi-line block on the command line.
- **`import <id>`** takes a per-id JSON object of editable fields (`--file <f.json>` or stdin) — see
  the `import` section below.

The tool stamps everything mechanical (id, `State`, dates, history); you never write those. State moves
ONLY through the lifecycle verbs (`start`/`finish`/`drop`/`remove`/`reopen`), never via `add`/`edit`/`import`.

## `add`

1. **Draft the fields** from the user's phrasing. Keep the headline tight (≤ ~8 words); write a real
   summary + context. Under `minimalTasks: true` (config), context is optional — headline + summary is
   enough for quick capture (G7: the tool is lenient and writes whatever you give it; `minimalTasks` is
   YOUR drafting hint, not a tool gate).
2. **Detect an epic.** If the work is clearly several discrete steps, propose the subtasks and show them
   for a nod before writing. `add` itself has no subtask flag — add them after the task exists, either
   `add-subtask <id> "<text>"` per step or one `import <id>` carrying a `subtasks` array (see `import`).
   Don't force subtasks onto a simple task.
3. `tpm task add --headline "…" [--summary "…"] [--context "…"] [--label L]…` → relay the
   `created task #N` line. For a long summary/context body, pass `--body-txt-file <f> --field
   summary|context` instead of an inline flag.

## `edit`

`edit` rewrites **editable scalar fields only** — headline / labels / summary / context — NEVER state
(Q9), and NOT subtasks. State changes go through `start`/`finish`/`drop`/`remove`/`reopen`; subtask
changes go through `add-subtask` / `check` / `import`.

1. `tpm task show <id>` to see the current body.
2. `tpm task edit <id> [--headline …] [--summary …] [--context …] [--label L]…` — pass ONLY the fields
   you're changing; an omitted field is left untouched. Use `--body-txt-file <f> --field
   summary|context` for a long body. → relay.

To flip a single checkbox use `check`; to append a subtask use `add-subtask`; to rewrite or re-order a
whole subtask set at once, `import <id>` a JSON object with a `subtasks` array (add `--prune` to drop
the keys you leave out).

## `import` — apply a per-id JSON patch to an existing task

`import <id>` sets one existing task's **editable fields** from a JSON object — `--file <f.json>` or
piped on stdin. It is the bulk-edit path: change several fields (and the whole subtask set) in one
write, or round-trip a task through JSON. Per-id and non-destructive to mechanical state.

- **Editable fields only.** Keys the tool applies: `headline`, `labels`, `summary`, `context`,
  `subtasks` (`[{key,text}]`). Mechanical fields (`id` / `state` / timestamps / `history` /
  `endAction`) are IGNORED even when present — state still moves only through the lifecycle verbs (G3).
- **Subtasks are keep-missing by default.** Keys you include are set/updated; keys already on the task
  that you omit are LEFT in place. Pass `--prune` to drop the omitted ones — destructive to the subtask
  set, so confirm before pruning.
- **`import --template`** prints a blank editable-fields JSON skeleton to fill in:

  ```json
  { "headline": "", "labels": [], "summary": "", "context": "", "subtasks": [ { "key": "A", "text": "" } ] }
  ```

Flow: draft the JSON (`tpm task import --template > ./tmp/tpm-task/edit-<id>.json`, then fill in the
fields you're changing), show it for a nod when it rewrites or prunes a subtask set, then `tpm task
import <id> --file ./tmp/tpm-task/edit-<id>.json` (add `--prune` to drop omitted subtasks) → relay the
`applied editable fields to task #<id>` line.

> **Bulk-creating tasks from a braindump is a separate flow, not `import`.** `import` patches ONE
> existing task; to turn a free-form file into new tasks, draft each candidate and `add` it (confirm
> first, dedup against `tpm task list`).

## `export` — serialize tasks

`/tpm-task export <selector> [--out <path>]` → `npx tpm task export <selector> [--out <path>]`. The router
sends `export` (and `search`) to a dedicated exporter tool — the plain ledger verbs (`list`/`show`/…)
have **no** `export` verb of their own. Emits the selected tasks: default `--human` (rendered bodies) **to stdout** — there is no
config-derived output path, so pass `--out <dir|file>` to write a file (`--json` for records,
`--per-file --out <dir>` for one `task-<id>.{json,md}` per task, `--thin` to drop history). Read-only
against the store.

Selectors (AND together): a **bare `export`** (no selector) = ALL tasks; explicit `<id>` / `<id>,<id>,…`
/ `<lo>-<hi>` ranges; `--state <s>[,<s>]` (`open|in-progress|finished|dropped|removed` — note `all` is
NOT a valid `--state` value here, unlike `list`); `--open`/`--closed` sugar; `--label <l>`; `--match
<text>`; the window flags `--opened-since`/`--updated-since`/`--closed-since <Nd|date>`; and `--last N
[--by updated|created|closed]`.

Examples: `export` (every task) · `export 214-218` · `export 1234,12,1245` · `export tasks about the
rename` (semantic → you resolve to an id-list first) · `export finished last week` (→ you lower to
`export --state finished --closed-since 7d`).
