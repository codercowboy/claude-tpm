# Smoke test — session edges & details

This exercises the trickier corners of the **session-notes** tooling: the `import-*` family, reviewing a
session, the read-only `doctor`, and the opt-in `migrate` of an old markdown store. Work through it in
order, then write the feedback file at the bottom.

> Note on "review": there is no `session review` verb — reviewing a session is done by reading it back with
> `npx tpm session export … --style human` (rendered) and/or `npx tpm session boot-read …` (the boot
> pickup). Use those wherever this doc says "review".

## Setup (once)

```
SESSIONS_DIR="$(npx tpm session config --sessions-dir)"
```
Pass `--sessions-dir "$SESSIONS_DIR"` on every verb. If it does not resolve, that is a **FAIL**.

## Steps

1. **Open a fresh session for these edges.** Pick the next number `<N>`:
   `npx tpm session current --sessions-dir "$SESSIONS_DIR" --next-number`
   `npx tpm session open --sessions-dir "$SESSIONS_DIR" --session <N> --session-id smoke-details-<N>`
   Confirm the folder is named `session-<N>/` and holds `session-<N>.json` + `session-<N>.md`
   (the session **number** and the **filename** track together — note whether that felt predictable).

2. **`import-log`** (append-only). Write a scratch log line and import it:
   ```
   printf 'Investigated the import family.\n' > /tmp/smoke-log.txt
   npx tpm session import-log --sessions-dir "$SESSIONS_DIR" --session <N> --txt-file /tmp/smoke-log.txt --status NOTE
   ```

3. **`import-punchlist`** (adds items). One item per line:
   ```
   printf 'review the migrate output\nconfirm doctor is read-only\n' > /tmp/smoke-punch.txt
   npx tpm session import-punchlist --sessions-dir "$SESSIONS_DIR" --session <N> --file /tmp/smoke-punch.txt
   ```

4. **`import-handoff`** (replace). 
   ```
   printf 'Session edges exercised.\n' > /tmp/smoke-ho.txt
   npx tpm session import-handoff --sessions-dir "$SESSIONS_DIR" --session <N> --txt-file /tmp/smoke-ho.txt --next "close and review"
   ```

5. **Review the session** (see the note above — use export):
   `npx tpm session export --sessions-dir "$SESSIONS_DIR" --session <N> --style human`
   PASS if the render shows your imported log line, the two punchlist items, and the handoff.

6. **`doctor` is read-only.** Run it, then run it again — it must not mutate the store:
   `npx tpm session doctor --sessions-dir "$SESSIONS_DIR"`
   PASS if it reports the sessions as valid and makes no changes (same output on a second run).

7. **`migrate` an old markdown store (opt-in).** A fixture old marked 3-file session was laid down at
   `smoke/fixtures/old-session-0007/`. First read the contract, then dry-run, then migrate for real into a
   SCRATCH out-dir (never the live store):
   ```
   npx tpm session migrate --help
   npx tpm session migrate --in smoke/fixtures/old-session-0007 --out-dir /tmp/smoke-migrated --dry-run
   npx tpm session migrate --in smoke/fixtures/old-session-0007 --out-dir /tmp/smoke-migrated
   ```
   (The derived `.md` is emitted by DEFAULT now — no `--emit-md` needed; pass `--no-emit-md` to skip it.)
   PASS if the migrate reports `validation: PASS` and writes `/tmp/smoke-migrated/session-0007/session-0007.json`
   AND `/tmp/smoke-migrated/session-0007/session-0007.md`.
   (If the fixture dir is absent, record this step as N/A and move on.)

8. **Close** the session you opened (needs a handoff + a punchlist — both are present from steps 3–4):
   `npx tpm session close --sessions-dir "$SESSIONS_DIR" --session <N>`

## Feedback (REQUIRED — write to `smoke/feedback-test-session-details.md`)

Write a file `smoke/feedback-test-session-details.md` containing:

- **A per-step PASS/FAIL/NA line** for steps 1–8. Quote the exact command + output for any FAIL.
- **Three feedback buckets:**
  1. **What worked** — clear verbs/skills that did what you expected.
  2. **What didn't** — friction, confusing output, errors (quote the exact command + what happened). In
     particular: was the "review = export" mapping obvious? Did `migrate`'s required flags read clearly?
  3. **What would help to work differently** — concrete suggestions (wording, a missing `review` alias,
     missing flags, smoother flow).
- **A final line:** `OVERALL: PASS` or `OVERALL: FAIL`.
