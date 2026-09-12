# `tpm-task` — content modes (`add` · `edit` · `import` · `export`)

Loaded when the router resolves a content mode. These are the modes with real drafting judgment. The
mechanics (id allocation, bucketing, index updates) are all the tool's — your job is to author good
content and stage it as a `--from` payload.

## The payload format (what you write to `./tmp/tpm-task/<mode>-<slug>.md`)

One task = one block starting with a `# ` heading. Plain markdown — the same shape as a stored body,
minus the bits the tool stamps (number, State, dates), which it fills in:

```markdown
# <headline — ≤ ~8 words>

**Summary:** <one or two sentences>

**Context:** <full detail — what / why / trigger, cross-refs in `backticks`>

**Subtasks:**            ← include ONLY for an epic
- [ ] A. <first subtask>
- [ ] B. <second subtask>
```

- **`- **Created:** YYYY-MM-DD`** — include only in an `import` payload when the source text implies a
  date (per-entry override); otherwise the tool stamps today.
- **`- **State:** …`** — normally omit (the tool defaults `open`). Present only in an `export` file you
  re-`import` (so a finished/dropped task round-trips its state).
- Multiple blocks in one file = a batch (`import`).

Always pass the file with `--from`: `tpm-task.js --tasks-dir <dir> add --from ./tmp/tpm-task/add-rename.md`.

## `add`

1. **Draft the fields** from the user's phrasing. Keep the headline tight (≤ ~8 words); write a real
   summary + context. Under `minimalTasks: true` (config), context is optional — headline + summary is
   enough for quick capture (G7: the tool is lenient and writes whatever you give it; `minimalTasks` is
   YOUR drafting hint, not a tool gate).
2. **Detect an epic.** If the work is clearly several discrete steps, propose lettered subtasks and show
   them for a nod before writing. Don't force subtasks onto a simple task.
3. Stage the payload → `tpm-task.js … add --from <payload>` → relay the `added #N …` line.

## `edit`

`edit` changes **content fields only** (headline / summary / context / subtasks) — NEVER state (Q9).
State changes go through `start`/`finish`/`drop`/`remove`/`reopen`.

1. `tpm-task.js … show <id>` to see the current body.
2. Draft a payload block with ONLY the fields you're changing (omit the rest — the tool leaves an
   omitted field untouched; supplying `**Subtasks:**` REPLACES the whole subtask list).
3. `tpm-task.js … edit <id> --from <payload>` → relay.

To flip a single checkbox, use `check`, not `edit`. To re-word or re-order subtasks, `edit` with a new
`**Subtasks:**` block (letters are re-derived A, B, C…).

## `import` — convert a free-form file into tasks (the on-ramp)

Braindump anywhere, then `/tpm-task import <path>` structures it. Collaborative + non-destructive —
nothing is written until the user confirms.

1. **Read + assess the file.** Compatibility check FIRST: already in / close to our body format →
   light touch (don't re-draft structured items); free-form prose/bullets → extract candidate tasks.
2. **Ask the collaboration mode:**
   - **Piecemeal** — present candidates as a numbered WORKING list (1, 2, 3 … — ephemeral handles, NOT
     the real `#1000+` ids the tool assigns on write). For each: proposed headline, drafted
     summary + context, an **inferred created date** (from any date the text implies, else today —
     shown so the user can correct), and epic detection. Walk keep / edit / skip.
   - **Best-effort** — convert ALL candidates with best judgment, present the full batch for one
     review, confirm, write.
3. **Write via the tool** — accepted candidates → one `tpm-task.js … import --from <payload>` (contiguous
   id block, single index update). Each accepted block gets its `- **Created:** <date>` line if you
   inferred one. **Dedup** against existing tasks (`tpm-task.js list`) and warn on likely duplicates before
   writing.
4. **Source file left untouched** by default (it's the user's). Offer to annotate/clear only if asked.

Candidate numbers (1, 2, 3) are throwaway — never conflate them with real ids.

## `export` — serialize tasks to a file

`/tpm-task export <selector> [--out <path>]` → `tpm-task.js … export <selector> [--out <path>] [--state <s>]`.
Writes selected tasks to ONE markdown file in canonical body format, so **export round-trips back
through `import`** (the tool reassigns fresh ids on re-import; content is preserved). Default out is
config-derived (`<exportDir>/tasks-export-<date>.md`, Q4) — the user may name a path with `--out`.
`--state` widens the pool to reach finished/removed. Read-only against the store.

Examples: `export all` · `export 214-218` · `export 1234,12,1245` · `export tasks about the rename`
(semantic → you resolve to an id-list first) · `export finished last week` (→ you lower to
`resolve --state finished --since 7d`, then export that id-list).
