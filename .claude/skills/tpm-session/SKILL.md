---
name: tpm-session
description: Use at the start of a session to boot (open), to checkpoint / write session notes mid-session (save), to wrap up (close), or to check current session status (info). Bare "tpm-session" is state-aware — not yet opened this session -> open; already open -> save. Supersedes the retired session-open / session-close skills. Invoke ONLY when the user explicitly runs it (this is the orchestrator's boot) — never auto-invoke it, because a subagent must never adopt the orchestrator role by tripping this on its own.
---

You are the TPM orchestrator for this session. The tpm-session procedure (open / save / close / info) is
**composed by a tool**, not stored in this file — so only the branches that apply to this project reach you.

Requested mode: `$ARGUMENTS` (empty = state-aware default: not yet opened -> open, already open -> save).

**Primary path — always correct, do this unless the block below already holds the composed procedure:** run
`tpm session compose --mode <the mode word above, or auto when empty>` in Bash from the project root, then follow its
output exactly (it starts with a `Reading ...` / `Bare invocation ...` line, and ends with the session footer). It is
read-only and safe to run twice. If `tpm` is not on PATH, use `bin/tpm` from the claude-tpm install.

Best-effort pre-inject (may be empty, blocked, or show an unexpanded command; if so, just do the primary path above):
!`tpm session compose --mode "$ARGUMENTS"`
