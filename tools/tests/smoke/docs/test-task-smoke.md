# Smoke test — task happy path

You are exercising the promoted **task ledger** tooling end-to-end via the `tpm-task` skill and the
`npx tpm task …` verbs. Work through the steps in order, then write the feedback file at the bottom.

## Setup (once)

The consumer's task store is already configured. Resolve it and reuse it:

```
TASKS_DIR="$(npx tpm task config --tasks-dir)"
```

Every `npx tpm task …` verb needs `--tasks-dir "$TASKS_DIR"` — the tool never defaults to a live store. If
`task config --tasks-dir` prints nothing or errors, that is an immediate **FAIL** (stop; store not configured).

> Task ids start at **1000**. When you `add` the first task it will be `#1000`; use the real id the tool
> prints (shown as `<id>` below), not a guess.

## Steps

1. **Add a task with labels.**
   `npx tpm task add --tasks-dir "$TASKS_DIR" --headline "Smoke happy-path task" --labels "smoke,demo" --summary "the task happy path"`
   Note the created `<id>` (e.g. `#1000`).

2. **List** and confirm it shows up open:
   `npx tpm task list --tasks-dir "$TASKS_DIR"`
   PASS if `<id>` appears with state `open` and the `smoke, demo` labels.

3. **Add a subtask.**
   `npx tpm task add-subtask --tasks-dir "$TASKS_DIR" <id> --text "first subtask" --key s1`

4. **Start it.**
   `npx tpm task start --tasks-dir "$TASKS_DIR" <id>`
   PASS if it reports the task is now `in-progress`.

5. **Confirm the close-guard (#1111).** Try to finish while the subtask is still open — it MUST refuse:
   `npx tpm task finish --tasks-dir "$TASKS_DIR" <id> --action "done"`
   PASS if it REFUSES and names the open subtask(s). (If it finishes anyway, that is a **FAIL** — the guard
   did not fire.)

6. **Check the subtask done.**
   `npx tpm task check --tasks-dir "$TASKS_DIR" <id> s1`

7. **Finish with an action.**
   `npx tpm task finish --tasks-dir "$TASKS_DIR" <id> --action "shipped the happy-path smoke"`
   PASS if it reports the task is now `finished`.

8. **Confirm the store reflects it.**
   `npx tpm task show --tasks-dir "$TASKS_DIR" <id>`   (state finished, subtask s1 done)
   `npx tpm task list --tasks-dir "$TASKS_DIR" --state finished`  (shows `<id>`)

## Feedback (REQUIRED — write to `smoke/feedback-test-task-smoke.md`)

Write a file `smoke/feedback-test-task-smoke.md` containing:

- **A per-step PASS/FAIL line** for steps 1–8. Quote the exact command + output for any FAIL. Step 5 is a
  deliberate must-refuse — mark it PASS only if the finish was refused.
- **Three feedback buckets:**
  1. **What worked** — which verbs/skills were clear and did what you expected.
  2. **What didn't** — friction, confusing output, errors, dead ends (quote the exact command + what happened).
  3. **What would help to work differently** — concrete suggestions (wording, missing flags, smoother flow).
- **A final line:** `OVERALL: PASS` or `OVERALL: FAIL`.
