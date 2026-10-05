**`--sessions-dir` is optional.** Every session verb resolves the sessions dir itself from the project root
(`$TPM_PROJECT_ROOT`, exported by the SessionStart hook, else a walk-up for `.claude/claude-tpm/`) and the
configured `session.notes.sessionsDir`, from any cwd. `--sessions-dir <dir>` is only an explicit override. Run every
invocation from the project root; every flag shown is a real CLI flag, not a placeholder.
