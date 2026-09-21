# Smoke test — session happy path

You are exercising the promoted **session-notes** tooling end-to-end via the `tpm-session` skill and the
`npx tpm session …` verbs. Work through the steps in order, observe what actually happens, and then write
the feedback file described at the bottom.

## Setup (do this once)

The consumer's session store is already configured. Resolve it and reuse it on every command:

```
SESSIONS_DIR="$(npx tpm session config --sessions-dir)"
```

Every `npx tpm session …` verb needs `--sessions-dir "$SESSIONS_DIR"` — the tool never defaults to a live
store. If `session config --sessions-dir` prints nothing or errors, that is an immediate **FAIL** (record
it and stop — the store is not configured).

## Steps

1. **Pick the next session number.**
   `npx tpm session current --sessions-dir "$SESSIONS_DIR" --next-number`
   Note the number it prints (e.g. `0001`). Use it as `<N>` below.

2. **Open the session.**
   `npx tpm session open --sessions-dir "$SESSIONS_DIR" --session <N> --session-id smoke-happy-<N>`
   PASS if it reports writing `session-<N>/session-<N>.json` and `.md`.

3. **Add a log note.**
   `npx tpm session note --sessions-dir "$SESSIONS_DIR" --session <N> --log --status NOTE --text "smoke: session happy path underway"`

4. **Add a punchlist item** (a close requires a punchlist to be present):
   `npx tpm session punchlist --sessions-dir "$SESSIONS_DIR" --session <N> --action add --text "carry this forward to the next session"`

5. **Import a handoff** (a close also requires a handoff). Write a one-line handoff body to a scratch file,
   then import it:
   ```
   printf 'Finished the session happy-path smoke.\n' > /tmp/smoke-handoff.txt
   npx tpm session import-handoff --sessions-dir "$SESSIONS_DIR" --session <N> --txt-file /tmp/smoke-handoff.txt --next "run the task happy-path smoke next"
   ```

6. **Save.**
   `npx tpm session save --sessions-dir "$SESSIONS_DIR" --session <N>`

7. **Close.**
   `npx tpm session close --sessions-dir "$SESSIONS_DIR" --session <N>`
   PASS if it closes cleanly. (If it REFUSES for a missing handoff or punchlist, that means step 4 or 5 did
   not land — record it as a FAIL with the exact message.)

8. **Confirm the store reflects the session.** Both of these should show session `<N>`:
   `npx tpm session doctor --sessions-dir "$SESSIONS_DIR"`  (expect `1 valid`, `0 invalid`)
   `npx tpm session boot-read --sessions-dir "$SESSIONS_DIR"`  (expect your HANDOFF text + the open punchlist item)
   Confirm the folder `session-<N>/` holds `session-<N>.json` + `session-<N>.md`.

## Feedback (REQUIRED — write to `smoke/feedback-test-session-smoke.md`)

Write a file `smoke/feedback-test-session-smoke.md` containing:

- **A per-step PASS/FAIL line** for steps 1–8 (e.g. `Step 2 (open): PASS`). If a step failed, quote the
  exact command and the exact output.
- **Three feedback buckets:**
  1. **What worked** — which verbs/skills were clear and did what you expected.
  2. **What didn't** — friction, confusing output, errors, dead ends (quote the exact command + what happened).
  3. **What would help to work differently** — concrete suggestions (wording, missing flags, a smoother flow).
- **A final line:** `OVERALL: PASS` or `OVERALL: FAIL`.
