# How tools read claude-tpm config

A short rule-of-the-road for anyone adding or changing a claude-tpm tool that needs a config value. The
mechanism is settled (#1152); this page says which door to use so no tool hand-parses `config.json` again.

## The one layered source

All config resolves through **three layers**, lowest → highest precedence:

1. the shipped defaults — `tools/config/defaults.json` (in the bundle; `_comment`/`$comment` keys are
   stripped from resolved values);
2. the project config — `<project>/.claude/claude-tpm/config.json`;
3. the user config — the file named by `$CLAUDE_TPM_USER_CONFIG`.

A later layer wins per value. Objects deep-merge; scalars/objects/arrays REPLACE. A missing project or user
layer is tolerated; an invalid **user** file warns to stderr and is skipped (never fatal); an invalid
**project** file is surfaced loudly. Per-value flag/env (e.g. `--sessions-dir`, `TPM_TASKS_DIR`) still win on
top of the overlaid config value — wire new code in at the "config" rung, never re-implement the flag/env
rungs. The full key reference is `docs/config-guide.md`.

## Which door to use

- **A tool that needs a value → read it through the section resolver (in-process), not by parsing JSON.**
  Each section has a resolver module: `tools/session/tpm-session-config.js`, `tools/task/tpm-task-config.js`,
  `tools/workflow/tpm-workflow-config-resolver.js`, `tools/config/tpm-hygiene-config.js`. `require()` the one
  you need and call its `resolve*Config(...)` / `getDefaults()`. Those apply the type-guards, the back-compat
  aliases, and the three-layer overlay for you.

- **A new section or a generic read → use the shared overlay lib** `tools/lib/tpm-config-overlay.js`
  directly (`loadDefaults()`, `resolveLayers(...)`, `overlayUserOnto(...)`). A section resolver re-points its
  `getDefaults()` onto `overlay.loadDefaults().<section>` and folds the user layer onto the project section
  with `overlay.overlayUserOnto(...)` before its existing whitelist merge — that composition keeps every
  type-guard and stays byte-identical to the built-in defaults when no layer is set.

- **A human or a skill → use the `tpm config` porcelain**, the CLI over the same lib:

  ```
  tpm config get session.notes.sessionsDir
  tpm config set tasks.maxOpenWarn 100
  tpm config list
  ```

  `get`/`list` read the overlaid (or a single) layer; `set` writes one layer's raw file (comments and
  sibling sections round-trip). Reference: `tools/config/tpm-config-router.md`.

## Don'ts

- **Don't `JSON.parse` `config.json` inline** to read a value — that skips the defaults, the user layer, the
  type-guards, and the comment-stripping. (This is exactly what the SessionStart hook used to do for
  `hygiene.healthCheck.enabled`; #1152 re-pointed it onto the hygiene resolver.)
- **Don't hard-code the defaults file path.** The overlay self-locates it relative to its own module; a
  `TPM_DEFAULTS_FILE` override exists for tests. Don't read `TPM_HOME` to find it — `TPM_HOME` is
  informational and nothing reads it for code.
- **Don't add array-concat semantics casually.** Arrays REPLACE by default; concat+dedup is gated behind an
  explicit, currently-empty allowlist in the overlay lib. Add a path there only when a section genuinely
  accumulates across layers.
