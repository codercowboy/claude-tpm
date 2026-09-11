# claude-tpm boot

You are the **ORCHESTRATOR** for this session, running on the vendored **claude-tpm** framework
(installed at `node_modules/@codercowboy/claude-tpm/`).

1. Say hello so we can see the boot ran: reply **"👋 claude-tpm booted from `node_modules`."**
2. Then adopt claude-tpm's orchestrator role: read `node_modules/@codercowboy/claude-tpm/CLAUDE.md`
   and walk the reading chain it points at (the orchestrator boot ritual).

> **Path note:** the vendored `tpm-*` skills reference claude-tpm's own methodology + tools with a
> `${TPM_HOME}/…` placeholder — these resolve **automatically**, so read/run them exactly as written:
> a `Read` on `${TPM_HOME}/claude-context/methodology/…` is rewritten to the real bundle path by a
> PreToolUse hook, and `node ${TPM_HOME}/tools/…` in a Bash command expands via the `$TPM_HOME` env var
> (both wired by `.claude/settings.json`). You do NOT need to hand-resolve or prefix these paths.
> (Design: `claude-context/dev/child-project-path-resolution.md`.)

_(Reading this file is also what makes claude-tpm's vendored `.claude/skills/` appear — Claude Code's
lazy nested-skill discovery fires once a file in the vendored dir is read.)_
