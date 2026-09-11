# tools/ — canonical tool index

Every project-level tool in claude-admin, what it's for, and where its docs live. Keep this in sync
when you add, remove, or rename a tool (this file is the ledger the methodology's session-open drift
checks and `project-workspace.md` point at).

All scripts are **zero-dependency and standalone** — run them with `node <path>` or `bash <path>`
directly; there is no `npm install` step. No hardcoded paths (per `tool-conventions.md`).

## `tools/workflow/` — the workflow module (round machinery)

The 7 tools the `/tpm-workflow` + `/tpm-spawn*` skills compose to run a round: scaffold → compose → lint →
Agent, plus config resolution, cost, and audit. Each has a `<tool>.md` reference beside it; tests in `tests/`.

| Tool | Purpose | Docs |
|---|---|---|
| `config-resolver.js` | Resolve the `.claude/claude-tpm/config.json` workflow registry (7 personas · 6 teams · `verifier.loopFixer` · charter homes) over built-in defaults. `--json` / `--get <key>` / `--validate`. | `config-resolver.md` |
| `scaffold-subagent.js` | Scaffold an epic/phase work folder (`epic-init` / `add-phase` / `add-round`): per-role charter (copied from its config home + orchestrator-note stripped), spawn-prompt stub, `tmp/<role>-r<N>/`, `subagent.env` stub. `--team` / `--charter <path>`. | `scaffold-subagent.md` |
| `compose-spawn-prompt.js` | Emit the standard spawn-prompt boilerplate (role-conditional read-order + return-shape, env ritual, base chain, `{{TASK_CONTEXT}}` fill sentinel). `--role` / `--verdict` (bug-fixer). | `compose-spawn-prompt.md` |
| `lint-subagent-prompt.js` | Lint a spawn prompt/plan/charter against the subagent reading-list manifest + prompt-shape + sentinel checks; rejects placeholder charters, enforces the verifier HARD RULE, fails loud on a bad `--manifest`. Role flags incl. `--verifier` / `--test-writer` / `--documentarian` / `--bug-fixer`. | `lint-subagent-prompt.md` |
| `check-filename.js` | Guard: reject `.md` deliverable names matching blocked server-side patterns (report/summary/analysis/findings). `--patterns` / `--config`. | `check-filename.md` |
| `audit.js` | Audit a `dev/` epic/phase tree against the canonical layout + `00-epic-plan/` charter-cleanliness; markdown punch list. `--out` / `--tasks-root` / `--strict`. | `audit.md` |
| `cost-ledger.js` | Per-subagent cost rows in `00-epic-plan/` (`--epic-path`) + `--summary` / `--rollup`. | `cost-ledger.md` |
| `doctor.js` | Fail-loud PREFLIGHT (`tpm-workflow doctor`): charters resolve · both hooks wired · signoff writable · compose emits a marker + `${TPM_HOME}` paths. Self-locates the bundle; runs in a consumer too. `--json` / `--project-root`. Every ✗ prints its fix. | header |

## `tools/session/` — the session-notes subsystem (backs `tpm-session`)

Self-contained, zero-dependency suite backing the `tpm-session` skill's four modes. `lib/` holds the
suite's own config resolver, current-session pointer, and the write/read token format SSOT — no
imports outside this suite, per `tool-conventions.md` Part I §2.

| Tool | Purpose | Docs |
|---|---|---|
| `lib/config.js` | Resolve the `session` section of `.claude/claude-tpm/config.json` over built-in defaults. `--json` / `--get <key>` / `--sessions-dir`. | `lib/config.md` |
| `lib/current-session.js` | The current-session pointer: open-vs-not-opened state, next-`session-NNN` allocation, seal-at-close. `--state` / `--open` / `--seal` / `--next-number`. | `lib/current-session.md` |
| `lib/format.js` | The session-notes token SSOT (headings/tokens/parse/render) — imported by both tools below, not a standalone CLI. | header |
| `session-notes.js` | The notes WRITE API: `resume` / `open add\|done` / `log` / `decide` / `seal`. Refuses non-current-session writes without `--edit-sealed <NNN> --confirm`. | `session-notes.md` |
| `session-review.js` | The notes READ API: `review --last N [--open-items\|--decisions\|--since <date>\|--grep <term>]`. | `session-review.md` |

## `tools/child-session/` — orchestrator-launched child Claude sessions

| Tool | Purpose | Docs |
|---|---|---|
| `launch-child.sh` | Provision + launch a child Claude session in a sibling project folder (`--headless "<prompt>"`, `--interactive` for Remote Control, or `--print-cmd`). Vendors a bootstrap, writes the child's `.claude-admin/` pointer, and sets `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` so the child's transcript persists. | header + `claude-context/dev/child-session-design.md` |
| `reap-child.sh` | Finalize an exited child: stamp `session.json` (status/ended_at) and archive a copy of the child's transcript into the session folder. | header |
| `watch-child.sh` | Background monitor that polls a launched child and reaps it on exit. | header |

## `tools/session-log/` — transcript rendering

| Tool | Purpose | Docs |
|---|---|---|
| `export-session.sh` | Render any normally-logged session to a readable, timestamped log from its on-disk JSONL. Resolve by `<name\|sessionId\|pid>`. | header |

## `tools/consumer/` — consumer adoption (relocatable install + path resolution)

How a downstream project adopts claude-tpm as a dependency and makes the vendored skills resolve their
shared bundle refs. Design: `claude-context/dev/consumer-adoption-design.md` +
`child-project-path-resolution.md`.

| Tool | Purpose | Docs |
|---|---|---|
| `scaffold-consumer.js` | Scaffold a consumer project: `package.json` (`file:` dep on claude-tpm), CLAUDE.md (boots claude-tpm via `boot.md`), README/LICENSE/`.gitignore`, `.claude/claude-tpm/config.json` (config source of truth — `bundle.home`), and a generated `.claude/settings.json` (`env.TPM_HOME` + expand/gate hooks; idempotent merge). `--smoke` installs + runs the smoke suite. | header |
| `hooks/expand-tpm-home.js` | PreToolUse hook: resolves the `${TPM_HOME}/…` bundle placeholder in READ-tool paths to the real bundle (self-located from `__dirname`). Read-family only + auto-allow + containment + fail-open. Empirical contract in the header. | header |
| `lint-skill-refs.js` | Keep the `tpm-*` skills relocatable: flags any bare bundle ref (`node tools/…`, `` `tools/… ``, `claude-context/methodology/…`) that must carry `${TPM_HOME}/`. Ignores workspace refs + `out/…` staged paths. | header |
| `check-json.js` | Extract + assert on the strict JSON a headless `claude -p` probe returns (`--truthy` / `--eq` / `--includes`). Backs the smoke suites (deterministic, not prose-grep). | header |
| `smoke.sh` | LLM-in-the-loop consumer smoke: headless `claude -p` probes (boot+skill-discovery, methodology-resolves, `token-methodology-read`) asserted via `check-json.js`. Run against a scaffolded+installed consumer dir. | header |

Tests: `tools/consumer/tests/expand-hook/{unit.js,smoke.sh}` (the hook — deterministic + LLM smoke) and
`tools/consumer/tests/scaffold-consumer/test.js` (the scaffolder helpers + end-to-end into a temp dir).

## `tools/workflow/tests/` — workflow tool tests

Self-contained (zero-dep), mutation-checked suites, one group per tool. Run each directly, e.g.
`node tools/workflow/tests/lint/tests/lint-subagent-prompt/test.js` or
`node tools/workflow/tests/scaffold-config/tests/scaffold-subagent/test.js`.

## Skills (in `.claude/skills/`, not tools)

The round workflow is driven by the **`tpm-*` skills** that compose these tools:
- **`tpm-workflow`** — the round-lifecycle front door (plan · run · verify · reconcile · reap · status).
- **`tpm-spawn`** — spawn ONE subagent (scaffold → compose → lint → Agent).
- **`tpm-spawn-team`** — spawn a named team (full/ship/build/test/docs/research) or a freeform roster.
- **`tpm-reap`** — safe stray-subagent cleanup.
