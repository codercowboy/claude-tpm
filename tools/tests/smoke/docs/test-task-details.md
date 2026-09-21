# Smoke test — task edges & details

This exercises the trickier corners of the **task ledger**: labels + the reverse index, the
`import --template` → `import --file` round-trip, `--body-txt-file`, `history`, `search` (incl. a comma-id
set), and `drop --reason`. Work through it in order, then write the feedback file at the bottom.

## Setup (once)

```
TASKS_DIR="$(npx tpm task config --tasks-dir)"
```
Pass `--tasks-dir "$TASKS_DIR"` on every verb. If it does not resolve, that is a **FAIL**. Task ids start
at **1000** — use the real ids the tool prints.

## Steps

1. **Add a base task**, then add labels two ways:
   `npx tpm task add --tasks-dir "$TASKS_DIR" --headline "Task edges" --labels "alpha,beta"`
   Note the `<id>`. Add another label with the singular verb:
   `npx tpm task label --tasks-dir "$TASKS_DIR" <id> gamma`

2. **Labels reverse index + filter.**
   `npx tpm task labels --tasks-dir "$TASKS_DIR"`  (expect `alpha`, `beta`, `gamma` each mapping to `<id>`)
   `npx tpm task list --tasks-dir "$TASKS_DIR" --label alpha`  (expect `<id>` in the list)

3. **`--body-txt-file`.** Load a longer context body from a file:
   ```
   printf 'A longer context body loaded from a file for the smoke.\n' > /tmp/smoke-ctx.txt
   npx tpm task add --tasks-dir "$TASKS_DIR" --headline "Task with body file" --body-txt-file /tmp/smoke-ctx.txt --field context
   ```
   Confirm with `npx tpm task show --tasks-dir "$TASKS_DIR" <that-id>` that the context body is present.

4. **`import --template` → edit → `import --file`.** Emit the blank editable-fields skeleton, edit it, and
   import it onto a placeholder task:
   ```
   npx tpm task import --template > /tmp/smoke-import.json
   ```
   Edit `/tmp/smoke-import.json`: set `headline` to `"Imported task"` and `summary` to `"via import --file"`.
   The template ships with a sample `subtasks` entry whose `text` is empty — **import refuses an empty
   subtask text**, so either fill that text in or set `"subtasks": []`. (Note in your feedback whether that
   was obvious.) Then:
   ```
   npx tpm task add --tasks-dir "$TASKS_DIR" --headline "placeholder to import into"
   npx tpm task import --tasks-dir "$TASKS_DIR" <placeholder-id> --file /tmp/smoke-import.json
   ```
   PASS if the placeholder's headline + summary are replaced by the imported values
   (`npx tpm task show --tasks-dir "$TASKS_DIR" <placeholder-id>`). Optionally try `--prune` and note what it drops.

5. **`history`.** Read the event log for the first task:
   `npx tpm task history --tasks-dir "$TASKS_DIR" <id>`
   PASS if it shows the `create` event and the label additions in order.

6. **`search`** over content and a **comma-id set**:
   `npx tpm task search --tasks-dir "$TASKS_DIR" --match "Imported"`  (finds the imported task)
   `npx tpm task search --tasks-dir "$TASKS_DIR" <id>,<placeholder-id>`  (returns both by id)

7. **`drop --reason`.** Drop the body-file task from step 3:
   `npx tpm task drop --tasks-dir "$TASKS_DIR" <body-file-id> --reason "not needed for the smoke"`
   PASS if it reports the task is now `dropped`; confirm with
   `npx tpm task list --tasks-dir "$TASKS_DIR" --state dropped`.

## Feedback (REQUIRED — write to `smoke/feedback-test-task-details.md`)

Write a file `smoke/feedback-test-task-details.md` containing:

- **A per-step PASS/FAIL/NA line** for steps 1–7. Quote the exact command + output for any FAIL.
- **Three feedback buckets:**
  1. **What worked** — clear verbs/skills that did what you expected.
  2. **What didn't** — friction, confusing output, errors (quote the exact command + what happened). In
     particular: was the `import --template` empty-subtask refusal obvious before it bit you? Did `--prune`
     behave as you expected?
  3. **What would help to work differently** — concrete suggestions (wording, missing flags, a template that
     imports cleanly out of the box, smoother flow).
- **A final line:** `OVERALL: PASS` or `OVERALL: FAIL`.
