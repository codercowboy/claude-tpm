# tools/ — canonical tool index

Every project-level tool in claude-admin, what it's for, and where its docs live. Keep this in sync
when you add, remove, or rename a tool (this file is the ledger the methodology's session-open drift
checks and `project-workspace.md` point at).

All scripts are **zero-dependency and standalone** — run them with `node <path>` or `bash <path>`
directly; there is no `npm install` step. No hardcoded paths (per `tool-conventions.md`).

## `tools/tpm.js` — the `tpm` command dispatcher (the front door)

One git-style entry point, shipped as the package `bin` (`npx tpm …`, or a linked `tpm`). It is a
**dumb top dispatcher**: it knows only SUITES and forwards `<suite> <everything-after>` to that
suite's own router, which owns its verb table. The routers self-locate their scripts via `__dirname`,
so a `tpm …` call needs **no `${TPM_HOME}`/env**. Dispatch is by child process with exit-code
propagation. Design: `claude-context/dev/tpm-cli-design.md` §0.

| Tool | Purpose | Docs |
|---|---|---|
| `tpm.js` | Top dispatcher. Suites `session` / `task` / `workflow` → each `tpm-<suite>-router.js`; flat consumer aliases `install` / `uninstall`. Unknown command → exit 2; bare/`--help` → menu. | `tpm.md` |

Per-suite routers (each owns its short-verb table; forwarded to by `tpm.js`, listed in their suite
sections below): `tools/session/tpm-session-router.js`, `tools/task/tpm-task-router.js`,
`tools/workflow/tpm-workflow-router.js`. Test: `tools/tests/tpm-router.test.js` (13 assertions —
dispatch, unknown→exit 2, arg pass-through, exit propagation).

## `tools/workflow/` — the workflow module (round machinery)

The 7 tools the `/tpm-workflow` + `/tpm-spawn*` skills compose to run a round: scaffold → compose → lint →
Agent, plus config resolution, cost, and audit. Each has a `<tool>.md` reference beside it; tests in `tests/`.

| Tool | Purpose | Docs |
|---|---|---|
| `tpm-workflow-config-resolver.js` | Resolve the `.claude/claude-tpm/config.json` workflow registry (7 personas · 6 teams · `verifier.loopFixer` · charter homes) over built-in defaults. `--json` / `--get <key>` / `--validate`. | `tpm-workflow-config-resolver.md` |
| `tpm-workflow-scaffold-subagent.js` | Scaffold an epic/phase work folder (`epic-init` / `add-phase` / `add-round`): per-role charter (copied from its config home + orchestrator-note stripped), spawn-prompt stub, `tmp/<role>-r<N>/`, `subagent.env` stub. `--team` / `--charter <path>`. | `tpm-workflow-scaffold-subagent.md` |
| `tpm-workflow-compose-spawn-prompt.js` | Emit the standard spawn-prompt boilerplate (role-conditional read-order + return-shape, env ritual, base chain, `{{TASK_CONTEXT}}` fill sentinel). `--role` / `--verdict` (bug-fixer). | `tpm-workflow-compose-spawn-prompt.md` |
| `tpm-workflow-lint-subagent-prompt.js` | Lint a spawn prompt/plan/charter against the subagent reading-list manifest + prompt-shape + sentinel checks; rejects placeholder charters, enforces the verifier HARD RULE, fails loud on a bad `--manifest`. Role flags incl. `--verifier` / `--test-writer` / `--documentarian` / `--bug-fixer`. | `tpm-workflow-lint-subagent-prompt.md` |
| `tpm-workflow-check-filename.js` | Guard: reject `.md` deliverable names matching blocked server-side patterns (report/summary/analysis/findings). `--patterns` / `--config`. | `tpm-workflow-check-filename.md` |
| `tpm-workflow-audit.js` | Audit a `dev/` epic/phase tree against the canonical layout + `00-epic-plan/` charter-cleanliness; markdown punch list. `--out` / `--tasks-root` / `--strict`. | `tpm-workflow-audit.md` |
| `tpm-workflow-cost-ledger.js` | Per-subagent cost rows in `00-epic-plan/` (`--epic-path`) + `--summary` / `--rollup`. | `tpm-workflow-cost-ledger.md` |
| `tpm-workflow-doctor.js` | Fail-loud PREFLIGHT (`tpm-workflow doctor`): charters resolve · signoff writable · compose emits a marker + `${TPM_HOME}` paths. Self-locates the bundle; runs in a consumer too. `--json` / `--project-root`. Every ✗ prints its fix. (PreToolUse hooks are plugin-delivered — no longer checked here.) | header |
| `tpm-workflow-router.js` | The `workflow` sub-router for `tpm` (`audit` / `compose` / `lint` / `scaffold` / `cost` / `signoff` / `doctor` / `config` / `check-filename` → the scripts above). Self-locates siblings; forwarded to by `tpm.js`. | header |

## `tools/session/` — the session-notes subsystem (backs `tpm-session`)

Self-contained, zero-dependency suite backing the `tpm-session` skill's four modes. The suite carries
its own config resolver (`tpm-session-config.js`), current-session pointer (`tpm-session-current.js`),
and the write/read token format SSOT (`tpm-session-format.js`) — no imports outside this suite, per
`tool-conventions.md` Part I §2.

| Tool | Purpose | Docs |
|---|---|---|
| `tpm-session-config.js` | Resolve the `session` section of `.claude/claude-tpm/config.json` over built-in defaults. `--json` / `--get <key>` / `--sessions-dir`. | `config.md` |
| `tpm-session-current.js` | The current-session pointer: open-vs-not-opened state, next-`session-NNN` allocation, seal-at-close. `--state` / `--open` / `--seal` / `--next-number`. | `tpm-session-current.md` |
| `tpm-session-format.js` | The session-notes token SSOT (headings/tokens/parse/render) — imported by both tools below, not a standalone CLI. | header |
| `tpm-session-notes.js` | The notes WRITE API: `resume` / `open add\|done` / `log` / `decide` / `seal`. Refuses non-current-session writes without `--edit-sealed <NNN> --confirm`. | `tpm-session-notes.md` |
| `tpm-session-review.js` | The notes READ API: `review --last N [--open-items\|--decisions\|--since <date>\|--grep <term>]`. | `tpm-session-review.md` |
| `tpm-session-router.js` | The `session` sub-router for `tpm` (`tpm session <config\|current\|notes\|review>`); self-locates siblings, forwarded to by `tpm.js`. | header |

## `tools/task/` — the task ledger (backs `tpm-task`)

Self-contained, zero-dependency suite backing the `tpm-task` skill. `tpm-task.js` is the ledger tool
(all subcommands); the helpers (`format` / `paths` / `render` / `store`) + the `config` resolver sit
**flat beside it — no `lib/`** (matches `tools/session/`; the `tests/lib/` under `tests/` is unrelated
test-support). Self-contained, no imports outside this suite (`tool-conventions.md` Part I §2).

| Tool | Purpose | Docs |
|---|---|---|
| `tpm-task.js` | The ledger CLI: `add` / `import` / `export` / `list` / `show` / `edit` / `check` / `add-subtask` / `start` / `finish` / `drop` / `remove` / `reopen`. | `tpm-task.md` |
| `tpm-task-config.js` | Resolve the `tasks` section of `.claude/claude-tpm/config.json` over defaults (12 keys). The skill's config-gate calls it directly. `--json` / `--get <key>` / `--tasks-dir`. | `config.md` |
| `tpm-task-router.js` | The `task` sub-router for `tpm` (`tpm task <subcmd>` → `tpm-task.js`; `tpm task config` → the resolver). Self-locates siblings; forwarded to by `tpm.js`. | header |
| `tpm-task-format.js` · `tpm-task-store.js` · `tpm-task-render.js` · `tpm-task-paths.js` | Internal helpers (token SSOT · fs store engine · view/age-ladder layer · project-root resolver) — imported by `tpm-task.js`, not standalone CLIs. | `README.md` / headers |

Tests: `tools/task/tests/run-all.js` (3 suites) + `tools/task/tests/mutation-check.js` (18 mutants).

## `tools/child-session/` — orchestrator-launched child Claude sessions

| Tool | Purpose | Docs |
|---|---|---|
| `tpm-child-launch.sh` | Provision + launch a child Claude session in a sibling project folder (`--headless "<prompt>"`, `--interactive` for Remote Control, or `--print-cmd`). Vendors a bootstrap, writes the child's `.claude-admin/` pointer, and sets `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` so the child's transcript persists. | header + `claude-context/dev/child-session-design.md` |
| `tpm-child-reap.sh` | Finalize an exited child: stamp `session.json` (status/ended_at) and archive a copy of the child's transcript into the session folder. | header |
| `tpm-child-watch.sh` | Background monitor that polls a launched child and reaps it on exit. | header |

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
| `tpm-consumer-install.js` | Graft claude-tpm onto an **existing** consumer project (replaces the retired scaffolder). Check-then-act, idempotent, **5-step** flow: (1) preflight (`npm` + valid `package.json` + `claude` on PATH, fail-fast per-prereq), (2) add the `@codercowboy/claude-tpm` optional dep (idempotent — skipped when declared **and** in `node_modules`, unless `--force`), (3) `marketplace add`, (4) `plugin install`, (5) `enable` (only if installed-but-disabled). Calls `npm`/`claude plugin …` directly; never authors `package.json`/settings. `--check` doctor · `--quiet` · `--force` · `--dir`/`--from`. | header |
| `tpm-consumer-uninstall.js` | Reverse the install — remove claude-tpm from an existing project. Idempotent **3-step** reverse-order flow: (1) `plugin uninstall`, (2) `marketplace remove --scope project`, (3) `npm uninstall @codercowboy/claude-tpm`. Never deletes the user's `package.json`, source, or docs. `--check` · `--quiet` · `--force` · `--dir`. | header |
| `hooks/expand-tpm-home.js` | PreToolUse hook: resolves the `${TPM_HOME}/…` bundle placeholder in READ-tool paths to the real bundle (self-located from `__dirname`). Read-family only + auto-allow + containment + fail-open. Empirical contract in the header. | header |
| `tpm-consumer-lint-skill-refs.js` | Keep the `tpm-*` skills relocatable: flags any bare bundle ref (`node tools/…`, `` `tools/… ``, `claude-context/methodology/…`) that must carry `${TPM_HOME}/`. Ignores workspace refs + `out/…` staged paths. | header |
| `tpm-consumer-check-json.js` | Extract + assert on the strict JSON a headless `claude -p` probe returns (`--truthy` / `--eq` / `--includes`). Backs the smoke suites (deterministic, not prose-grep). | header |
| `smoke.sh` | LLM-in-the-loop consumer smoke: headless `claude -p` probes (boot+skill-discovery, methodology-resolves, `token-methodology-read`) asserted via `tpm-consumer-check-json.js`. Run against an installed consumer dir. | header |

Tests: `tools/consumer/tests/run-all.js` runs the whole suite — `tpm-consumer-install/test.js`,
`tpm-consumer-uninstall/test.js` (both drive the tools' pure exported helpers, incl. `parsePluginList`
and the arg flag-guards; spawn no real `claude`/`npm`), plus `expand-hook/unit.js` (the hook —
deterministic); `expand-hook/smoke.sh` is the LLM smoke.

## `tools/misc/` — one-off / domain-agnostic utilities

Standalone tools that aren't part of a specific subsystem.

| Tool | Purpose | Docs |
|---|---|---|
| `tpm-fix-git-rename-refs.js` | Domain-agnostic reference migrator: after a batch of git renames/deletes (read from a `git status` snapshot), find + fix references to the old paths. `identify` (ledger + `--json` worklist) · `fix` (`--dry`/`--force`) · `apply-plan` (expected-text-asserted targeted edits). Provable refs auto-fixed byte-exact; ambiguous ones flagged for `--force`/agent resolution. Never calls git; zero-dep. | `tpm-fix-git-rename-refs.md` (+ `.design.md`, `.test-design.md`; the agent "3rd mechanism" for ambiguous refs: `agent-ambiguous-resolution.design.md` + `.eval-design.md`) |
| `find-tool-rename-usages.js` | Superseded identify-only predecessor of the above (kept for reference). | header |

Tests: `tools/misc/tests/tpm-fix-git-rename-refs/test.js` (113 tests, hermetic temp-dir fixtures).

## `tools/workflow/tests/` — workflow tool tests

Self-contained (zero-dep), mutation-checked suites, one group per tool. Run each directly, e.g.
`node tools/workflow/tests/tpm-workflow-lint/tests/lint-subagent-prompt/test.js` or
`node tools/workflow/tests/tpm-workflow-scaffold-config/tests/scaffold-subagent/test.js`.

## Skills (in `.claude/skills/`, not tools)

The round workflow is driven by the **`tpm-*` skills** that compose these tools:
- **`tpm-workflow`** — the round-lifecycle front door (plan · run · verify · reconcile · reap · status).
- **`tpm-spawn`** — spawn ONE subagent (scaffold → compose → lint → Agent).
- **`tpm-spawn-team`** — spawn a named team (full/ship/build/test/docs/research) or a freeform roster.
- **`tpm-reap`** — safe stray-subagent cleanup.
