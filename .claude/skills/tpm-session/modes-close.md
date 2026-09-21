# `tpm-session close` — wrap-up ritual

Loaded ONLY when `SKILL.md` resolves mode `close`. Parallels `modes-open.md` — the wrap-up
counterpart. Collapses the old `session-close` skill into five steps + the universal footer.

**A subagent must never run this skill.** `close` wraps up the orchestrator's own session (reap,
session-notes seal, sign-off) — a worker's lifecycle is its spawn prompt + its working folder's
`plan.md`, not this. If you were spawned as a subagent and somehow reached this file, STOP and
follow your spawn prompt instead.

## Sequence

1. **Run the reap ritual.** Call `/tpm-reap` — already built, live, and matches this design exactly
   (`.claude/skills/tpm-reap/SKILL.md`). No new logic here: `close` just triggers it. **NEVER
   auto-kills** — enumerate → explicit user choice → double-confirm for "all" → close only the
   confirmed, per `tpm-reap`'s own ritual. Silent (no prompt) if `tpm-reap` finds nothing running.

2. **Finalize session notes — delegate to `save`.** Run `SKILL.md`'s `save` body verbatim — the fixed
   3-step ritual: reconcile the punchlist (close finished items, add any new ones), append any final
   decisions/log lines, then replace the handoff via `ops import-handoff` and persist via `ops save`
   (honoring the exit codes — a refused `import-handoff` (exit 1) wrote nothing, so fix the named field
   and re-run before sealing). Module-gated: a no-op if `session.notes.enabled` is false. This is the
   one path — `close` does NOT duplicate the notes-writing logic.

3. **Seal the session.** After `save` finishes, call `npx tpm session ops --sessions-dir <dir>
   --session <NNNN> close` — the seal. It **REFUSES (exit 1, naming what's missing) unless a handoff
   AND at least one punchlist item are present**; otherwise it stamps `meta.closedAt` on the record.
   Then call `npx tpm session current --sessions-dir <dir> --seal` to mark the current-session pointer
   closed (`%TPM_HOME%/tools/session/tpm-session-current.js`'s `sealSession`), so the NEXT bare
   `tpm-session` invocation (this session or a future one) opens fresh instead of reusing this folder.

4. **`/export` nudge.** One-line reminder that `/export` (a Claude Code CLI command) saves a readable
   transcript — the user types it themselves. Transcripts also persist automatically; this is a
   convenience, not a data-safety requirement.

5. **Terse sign-off** — NOT the skill menu. Crucial UX rule: at close the user is *stopping*, so do
   NOT list "here's what else you could do" (the open MOTD invites work; the close message ends it).
   One paragraph: what shipped, what's pending, any hand-offs to the next session, the notes-saved-to
   pointer. Then the consumer's `session.additionalCloseMessage` file content, if set, appended AFTER.

6. **Print the session #** — the universal `tpm-session` footer (`SKILL.md`'s `info` block).

## What carries over from the legacy `session-close` skill (unchanged)

- The consumer-extension pointer (a wrapper skill or `additionalCloseMessage`, not the canonical) —
  now `session.additionalCloseMessage`, already a live config key.
- "Reap orphaned child sessions" — now delegated wholesale to `/tpm-reap` rather than the old inline
  `ls tmp/sessions/` + `tpm-child-reap.sh` loop (step 1 above).

## What's different from the legacy `session-close` skill

- The old skill **silently killed** stray child sessions. `tpm-reap` NEVER does — every close now
  goes through the enumerate → choice → double-confirm dialogue for anything found running.
- The old skill minted a **new** `session-NNN` folder on every close — the "always create a new
  folder" rule was stated directly in `CLAUDE.md`'s pre-rewrite boot ritual, which pointed at an
  `orchestrator/session-process.md` that is now written and live at
  `%TPM_HOME%/claude-context/methodology/orchestrator/session-process.md`. `close` now updates the SAME folder
  `open` established this session (step 2–3 above) — the bug this whole redesign exists to fix.
