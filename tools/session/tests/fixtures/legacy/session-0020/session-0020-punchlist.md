<!-- tpm-session: 0020 · 2026-09-17 · tpm-session-version: 1.0 · files: session-0020-handoff.md, session-0020-punchlist.md, session-0020-log.md -->
> **Session 0020 memory — three files in this folder.  THIS FILE: punchlist.**
> • **session-0020-handoff.md** — READ FIRST: where we are, next action, what NOT to redo.
> • **session-0020-punchlist.md** — open/done work items (numbered).
> • **session-0020-log.md** — append-only ledger: Decisions + Log (log reads **bottom-to-top**).

# Punchlist — session 0020 — 2026-09-17

## Open
- [ ] #20.1 · Commit all unstaged ../claude-tpm work: PostToolUse content hook (#1099) + router verb + hooks.json rewire + installer health-check/tests (USER runs git — denied for Claude)  [coglwp, 2026-09-17T15:58:47-07:00]
- [ ] #20.4 · #1101: restore session 019 verbose notes/log from the actual chat transcript (over-trimmed by punchlist externalization)  [yx98yy, 2026-09-17T15:58:48-07:00]
- [ ] #20.5 · Cleanup (mv to tmp/safe-to-delete — rm denied): orphan claude-context/sessions/.current-session.json + A/B rig tmp/session-tests/ab-20260917  [1u25aj, 2026-09-17T15:58:48-07:00]
- [ ] #20.6 · Optional tidy: reword #1099 finished end-action to drop jargon; expand-hook/smoke.sh still exercises the OLD PreToolUse hook (stale, not in run-all)  [1ho8ed, 2026-09-17T15:58:48-07:00]
- [ ] #20.7 · #1103: end-to-end live-claude %TPM_HOME% smoke test — the acceptance gate for the whole resolution redesign (rig under ../tmp; run all permission modes)  [jt4coh, 2026-09-17T18:11:00-07:00]
- [ ] #20.8 · Verifier non-blocking follow-ups: (A) fix retired expand-tpm-home prose exactness (README/technical/hooks-router:54 say it resolves %TPM_HOME% but its TOKEN is braced-only); (B) add committed test for subagent-prompt lint %TPM_HOME% branch; widen ref-lint/verifier coverage to catch "(path)...Read it" read-refs  [m9kxwr, 2026-09-17T18:11:01-07:00]
- [ ] #20.9 · #1104 filed: plugin-cache deploy-correctness — ROOT CAUSE of "content hook never fired": the ~/.claude plugin CACHE was stale (Sep 15); source edits were never re-cached. Fix: `npx tpm install <dir> --force` re-caches from source (cache 0.1.0 now fresh: content hook + migrated skills). Follow-ups A/B/C in #1104 (refresh-verb + doctor stale-cache detection)  [tjzc5l, 2026-09-17T18:46:37-07:00]
- [ ] #20.10 · Smoke harness tools/tpm-smoke.js BUILT (#1103 subtask A) + re-running vs tmp/run-cachetest in BACKGROUND (log: tmp/smoke-run-cachetest.log) to confirm probe-2 token-resolution flips FAIL->PASS now the cache is fresh — RESULT PENDING at save time  [5x8313, 2026-09-17T18:46:37-07:00]
- [ ] #20.11 · CORRECTION to #20.10: cache refresh did NOT make the content hook fire. Smoke re-run vs FRESH cache 0.1.0 -> probe-2 output still LITERAL %TPM_HOME%; probe-1 friction = "Unknown skill: tpm-session" (nested claude -p had NO plugin skills). So plugin skills/hooks likely dont load under headless claude -p. Filed #1105 to investigate (interactive vs -p; #1099 delivery)  [kzs8kh, 2026-09-17T18:50:49-07:00]
- [ ] #20.12 · Smoke harness (#1103) bugs this run exposed: probes 3 (tpm doc) + 4 (tasks) FAILED only because the nested claude was approval-blocked (ran commands never executed) -> pass acceptEdits/allowedTools; harness EXITED 0 despite 3 hard fails (exit-code bug); probes 1/2 cannot validate plugin behavior headlessly if -p doesnt load plugins. See #1105.D  [hebias, 2026-09-17T18:50:49-07:00]
- [ ] #20.13 · Interactive (non--p) content-hook test (#1105.B): INCONCLUSIVE. Interactive claude BOOTS + loads the plugin (folder-trust dialog proves a real session) but `screen -X stuff` CANNOT drive the TUI (Down/Enter zero-effect across 3 tries -> TUI reads /dev/tty directly). Trust dialog also blocks (--dangerously-skip-permissions does NOT skip it). Needs a HUMAN at the terminal or an expect pty-driver. Manual check staged: tmp/run-cachetest/src-interactive.md. Full writeup: dev/tpmhome-cache-and-p-findings-20260917/FINDINGS.md  [lwzic1, 2026-09-17T23:30:47-07:00]

## Done
- [x] #20.2 · #1098 is now LOAD-BEARING: migrate skill Read %TPM_HOME%/ paths to npx tpm doc — the removed PreToolUse path-hook no longer resolves token READ-PATHS for consumers  [f8egdr, 2026-09-17T15:58:47-07:00] (closed 2026-09-17T18:10:59-07:00)
- [x] #20.3 · #1102: project-wide respell %TPM_HOME% literals (avoid bash ${...} emptying); keep token-matching code accepting both spellings  [mh988d, 2026-09-17T15:58:48-07:00] (closed 2026-09-17T18:10:59-07:00)
