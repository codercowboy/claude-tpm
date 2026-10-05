**Footer (the LAST thing every `tpm-session` mode prints — an unmistakable "you are in session NNN" line).** Resolve and print, in order:
1. Current session number + folder path (via `tpm session current --state`; "no session open yet" if `state: not-opened`).
2. Whether the `session-NNNN.json` (+ derived `session-NNNN.md`) exists for it yet, and roughly when it was last modified.
3. Total session count (`ls <sessions-dir>/session-*/ | wc -l`-shaped over the resolved sessions dir, or read `tpm session export`'s listing).
4. The real Claude Code sessionId if `$CLAUDE_CODE_SESSION_ID` is readable (best-effort, diagnostic-only, not load-bearing).
