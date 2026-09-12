# `tpm-task` — end-state modes (`finish` · `drop` · `remove` · `reopen`)

Loaded when the router resolves a state-ending mode. These change a task's lifecycle state, so the
judgment here is mostly **safety**: resolve fuzzy selectors to concrete ids, echo them, and get a yes
before mutating. The tool moves the index line and stamps the body; you own the confirm dialogue.

## The lifecycle (§7)

```
add → [ OPEN #N ] ──start──▶ in-progress   (stays in task-index.md; State flips)
           │  ──finish──▶ finished-tasks-index.md  (state finished, +End action)
           │  ──drop────▶ finished-tasks-index.md  (state dropped, +reason)
           │  ──remove──▶ removed-tasks-index.md   (non-destructive)  ──(--hard, confirmed)──▶ gone
  any ended/removed ──reopen──▶ back to OPEN (keeps Created; strips Ended/End action)
```

**State-transition legality (G3) — the tool enforces it; relay its message:**
- A **forward** transition from a sensible state succeeds.
- A **redundant** one (→ the state it's already in) is a **no-op with a notice** — not an error.
- A **nonsensical** one (e.g. `start` a finished task, `finish` a dropped one) is a **loud error naming
  the current state**. The fix is usually `reopen` first — tell the user that.

## Safety rules (enforce BEFORE calling the tool) — §7

1. **Resolve → CONFIRM.** Turn any fuzzy/semantic selector into concrete ids (`tpm-task.js resolve …` for
   deterministic selectors; read `list`/`show` for semantic ones). **Echo the exact `#`s + headlines**
   and get a yes before mutating. Never act on a fuzzy selector unconfirmed.
2. **Multi-target selectors** (`last 5`, a range) are ALWAYS listed before acting.
3. **Echo before mutate** — a mis-parse then surfaces as a visible line to correct, not a silent wrong
   action.

`autoConfirm` (config) may skip the confirm dialogue for `finish`/`drop` only (default both false).
`remove --hard` is **never** auto-confirmable.

## `finish`

`tpm-task.js … finish <id> --action "<what was done>"`. The `--action` text is required (it becomes the
`End action:` line) — draft a one-line "what was actually done / where it shipped" from the user's
words. Confirm the id + headline first unless `autoConfirm.finish` is true.

## `drop`

`tpm-task.js … drop <id> --reason "<why>"`. Stamps `dropped` + `End action: WON'T DO — <reason>`. Draft the
reason from the user. Confirm unless `autoConfirm.drop` is true.

## `remove` — non-destructive by default

- **Default (`tpm-task.js … remove <id>`)** moves the task to the removed stash — say *"stashed to removed,
  recoverable via `reopen`."* This is the safe default; prefer it.
- **Hard delete (`--hard`)** only when the user EXPLICITLY says not to stash / to delete permanently.
  First warn, verbatim intent: *"This permanently deletes #<id> with NO stash — unrecoverable. Confirm?"*
  Only on an explicit yes call `tpm-task.js … remove <id> --hard`. Hard delete is **always** confirmed,
  regardless of any `autoConfirm`, and is **blocked entirely** when `allowHardDelete: false` (the tool
  refuses — relay that).

## `reopen`

`tpm-task.js … reopen <id>`. Any ended/removed task → back to `open` (keeps its Created date; strips the now
-stale `Ended:` / `End action:` lines; stamps `Reopened:` as history — G4). Reopening an already-active
task is a no-op notice. Use `reopen` before re-`finish`/`start`/`drop` on a task the tool refused as a
nonsensical transition.
