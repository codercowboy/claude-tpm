---
name: tpm-reap
description: Use to safely clean up stray subagents / subshells / runaway scripts left after a round (or an abort) — the shared reap ritual. Enumerate → explicit user choice → double-confirm for "all" → close only the confirmed. NEVER auto-kills. A round's end or an abort is a natural trigger to offer it. Also invoked as tpm-workflow's reap mode and by tpm-session close.
---

`/tpm-reap` surfaces and safely closes stray processes a round may leave behind — a subagent off the
reservation, a subshell that got away, a background script that outlived its purpose. It is **core and
always-on** (not workflow-only): a round's end, or an abort, is a natural moment to offer it. This
skill is judgment + safety dialogue only.

## ⛔ The one safety rule — NEVER auto-kill

Killing a process is irreversible and can destroy in-flight work. So reaping is **always** a
resolve → echo → confirm → act dialogue, and a bare invocation NEVER closes anything on its own. When
in doubt, enumerate and ask — do not assume.

## The ritual

1. **Enumerate** — list the candidate strays: background subagents/tasks this session launched, and
   any runaway subshells/scripts (OS `ps` for detached processes, plus the harness's own
   background-task list). Present them with enough identity to tell them apart — PID / task id / role
   / phase / what launched it / how long it's run / its working folder.
2. **Nothing found → say so and stop.** "No strays — nothing to reap." A clean report is the success
   case; don't manufacture targets.
3. **Explicit user choice** — the user names WHICH to close (by id/PID or an unambiguous description).
   Never infer "they probably meant all of them" from a vague instruction. Resolve the user's choice
   forgivingly (normalize → intent-match → confidence-gate), then **echo the exact resolved set**
   (`Closing → [PID 4821 builder-r2, task tpm-abc123]`) so a mis-selection is a visible line to
   correct before anything is killed.
4. **Double-confirm for "all"** — closing *everything* is the highest-stakes case: require a second,
   explicit confirmation ("that's ALL N strays — confirm again?") before acting. A single "yes" is
   not enough for an all-kill.
5. **Close only the confirmed** — act on exactly the echoed, confirmed set. Anything not explicitly
   confirmed stays running. Report what was closed and what remains.

## No-args / malformed

Bare `/tpm-reap` → run the enumerate step and present the candidates + the choices (it is the natural
entry point, not an error). A malformed/ambiguous selection → show the enumerated list again and ask
for an explicit choice; do NOT guess and do NOT act.
