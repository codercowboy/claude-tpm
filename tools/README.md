# tools/ — canonical tool ledger

The single source of truth for every tool that ships in claude-tpm: what it is, how (if at all) you run
it, and where its fuller doc lives. **Keep this current** — when you add, remove, or rename a tool,
update this file in the same change. The ledger is exhaustive (every tool that exists is listed) and
honest (nothing that no longer exists is listed). This is the one canonical index; suites do **not** each
carry their own README. The authoring rules behind it — portability, the "runnable by a bare `node`"
convention, and this ledger's contract — live in
[`../claude-context/methodology/tool-conventions.md`](../claude-context/methodology/tool-conventions.md).

**How to read a bullet.** Each tool is `` `path` `` — one sentence. A **Run:** line appears only when the
tool is wired into a run command (claude-tpm exposes the `tpm` bin, so that's `npx tpm …`); tools with no
`npm run` / `npx` wiring — internal helpers, hook scripts invoked by the harness, one-off utilities — get
no Run line. A **Doc:** pointer names the tool's reference (`<tool>.md`) or "header" when the doc is the
top-of-file docstring.

**The `tpm` front door.** `tools/tpm.js` is the package `bin`, so everything wired runs as `npx tpm
<suite> <verb>` (or a linked `tpm <suite> <verb>`). `tpm.js` is a **dumb top dispatcher**: it knows only
the four suites (`session` / `task` / `workflow` / `hooks`) plus the flat consumer aliases
(`install` / `uninstall` / `doctor`), and forwards `<everything-after>` to that suite's own router. The per-suite
routers own their verb tables and self-locate their scripts via `__dirname`, so no `%TPM_HOME%`/env is
needed. Dispatch is by child process with faithful arg/stdio pass-through and exit-code propagation.

- **`tools/tpm.js`** — the top dispatcher / front door; routes `<suite> <verb>` to the per-suite router, plus the flat consumer aliases `install` / `uninstall` / `doctor` (unknown → exit 2; bare / `--help` → menu). Run: `npx tpm <suite> <verb>` · Doc: `tpm.md`

---

## Workflow suite — `tools/workflow/`

The tools the `/tpm-workflow` + `/tpm-spawn*` skills compose to run a formal multi-agent round: scaffold →
compose → lint → Agent, plus config resolution, cost, audit, sign-off, and a fail-loud preflight. All wired
as `npx tpm workflow <verb>`.

- **`tools/workflow/tpm-workflow-config-resolver.js`** — resolve the `workflow` registry from `.claude/claude-tpm/config.json` (personas · teams · `verifier.loopFixer` · charter homes) over built-in defaults. Run: `npx tpm workflow config` · Doc: `tpm-workflow-config-resolver.md`
- **`tools/workflow/tpm-workflow-scaffold-subagent.js`** — scaffold an epic/phase work folder (`epic-init` / `add-phase` / `add-round`): per-role charter, spawn-prompt stub, `tmp/<role>-r<N>/`, `subagent.env`. Run: `npx tpm workflow scaffold` · Doc: `tpm-workflow-scaffold-subagent.md`
- **`tools/workflow/tpm-workflow-compose-spawn-prompt.js`** — emit the standard spawn-prompt boilerplate (role-conditional read-order + return-shape, env ritual, base chain, `{{TASK_CONTEXT}}` sentinel). Run: `npx tpm workflow compose` · Doc: `tpm-workflow-compose-spawn-prompt.md`
- **`tools/workflow/tpm-workflow-lint-subagent-prompt.js`** — lint a spawn prompt / plan / charter against the subagent reading-list manifest + prompt-shape + sentinel checks; enforces the verifier HARD RULE, fails loud on a bad `--manifest`. Run: `npx tpm workflow lint` · Doc: `tpm-workflow-lint-subagent-prompt.md`
- **`tools/workflow/tpm-workflow-check-filename.js`** — guard: reject `.md` deliverable names matching blocked patterns (report/summary/analysis/findings). Run: `npx tpm workflow check-filename` · Doc: `tpm-workflow-check-filename.md`
- **`tools/workflow/tpm-workflow-audit.js`** — audit a `dev/` epic/phase tree against the canonical layout + `00-epic-plan/` charter-cleanliness; emits a markdown punch list. Run: `npx tpm workflow audit` · Doc: `tpm-workflow-audit.md`
- **`tools/workflow/tpm-workflow-cost-ledger.js`** — per-subagent cost rows in `00-epic-plan/`, with `--summary` / `--rollup`. Run: `npx tpm workflow cost` · Doc: `tpm-workflow-cost-ledger.md`
- **`tools/workflow/tpm-workflow-signoff.js`** — the user-sign-off ledger for workflow kickoffs: records the deterministic two-token sign-off that the spawn gate checks before a round is allowed to spawn subagents. Run: `npx tpm workflow signoff` · Doc: header
- **`tools/workflow/tpm-workflow-doctor.js`** — fail-loud PREFLIGHT: charters resolve · sign-off writable · compose emits a marker + `%TPM_HOME%` paths; self-locates the bundle, runs in a consumer. Every ✗ prints its fix. Run: `npx tpm workflow doctor` · Doc: header
- **`tools/workflow/tpm-workflow-router.js`** — the `workflow` sub-router (owns the verb table above; forwarded to by `tpm.js`). Internal plumbing, not a CLI. Doc: header

---

## Session suite — `tools/session/`

The three-file session-memory subsystem behind the `tpm-session` skill's modes (`handoff.md` +
`punchlist.md` + `session-notes.md`). Self-contained (no imports outside the suite). User-facing verbs
wired as `npx tpm session <verb>`; the format/paths modules are internal.

- **`tools/session/tpm-session-config.js`** — resolve the `session` config section over built-in defaults (`--json` / `--get` / `--sessions-dir`). Run: `npx tpm session config` · Doc: `config.md`
- **`tools/session/tpm-session-current.js`** — the current-session pointer: open-vs-not state, next-`session-NNN` allocation, seal-at-close. Run: `npx tpm session current` · Doc: `tpm-session-current.md`
- **`tools/session/tpm-session-notes.js`** — the ledger WRITE API: `init` / `log` / `decide` / `seal`, each stamped with a trailing ISO-TZ timestamp (refuses non-current writes without `--edit-sealed`). Run: `npx tpm session notes` · Doc: `tpm-session-notes.md`
- **`tools/session/tpm-session-punchlist.js`** — the punchlist mini task-manager: `add` / `close` / `list [--all]` / `reopen` / `drop` over session-prefixed ids (`#<session>.<n>`). Run: `npx tpm session punchlist` · Doc: `tpm-session-punchlist.md`
- **`tools/session/tpm-session-save.js`** — the gated, linted checkpoint: `save --payload <file.json>` rewrites `handoff.md` (What-remains from the punchlist) + refreshes headers on all three files. Exit 0 ok · 1 refused · 2 usage. Run: `npx tpm session save` · Doc: `tpm-session-save.md`
- **`tools/session/tpm-session-boot-read.js`** — the boot-time pickup emit: the prior session's handoff verbatim + open punchlist + file locations; degrades to point-at-path, always exits 0. Run: `npx tpm session boot-read` · Doc: `tpm-session-boot-read.md`
- **`tools/session/tpm-session-review.js`** — the READ API: `review --last N [--open-items|--decisions|--since|--grep|--json]` (overview from handoff, open items from punchlist, decisions/log from the ledger). Run: `npx tpm session review` · Doc: `tpm-session-review.md`
- **`tools/session/tpm-session-format.js`** — the three-file format SSOT (headings/tokens/ids/slug+ISO-TZ helpers/parse/render + the shared wayfinding header). Internal helper (imported, not a CLI). Doc: header
- **`tools/session/tpm-session-paths.js`** — the suite's project-root / path resolver. Internal helper (imported, not a CLI). Doc: header
- **`tools/session/tpm-session-router.js`** — the `session` sub-router (forwarded to by `tpm.js`). Internal plumbing, not a CLI. Doc: header

---

## Task suite — `tools/task/`

The task-ledger subsystem behind the `tpm-task` skill. Self-contained; the ledger CLI plus its config
resolver are user-facing, the format/store/render/paths modules are internal helpers.

- **`tools/task/tpm-task.js`** — the ledger CLI: 13 user modes (`add` / `import` / `export` / `list` / `show` / `edit` / `check` / `add-subtask` / `start` / `finish` / `drop` / `remove` / `reopen`) plus the tool-internal `resolve` / `reindex`. Run: `npx tpm task <subcmd>` · Doc: `tpm-task.md`
- **`tools/task/tpm-task-config.js`** — resolve the `tasks` config section over defaults (`--json` / `--get` / `--tasks-dir`). Run: `npx tpm task config` · Doc: `config.md`
- **`tools/task/tpm-task-format.js`** — the task token SSOT. Internal helper (imported, not a CLI). Doc: header
- **`tools/task/tpm-task-store.js`** — the filesystem store engine. Internal helper (imported, not a CLI). Doc: header
- **`tools/task/tpm-task-render.js`** — the view / age-ladder layer. Internal helper (imported, not a CLI). Doc: header
- **`tools/task/tpm-task-paths.js`** — the project-root resolver. Internal helper (imported, not a CLI). Doc: header
- **`tools/task/tpm-task-router.js`** — the `task` sub-router (forwarded to by `tpm.js`). Internal plumbing, not a CLI. Doc: header

---

## Consumer adoption — `tools/consumer/`

How a downstream project adopts claude-tpm as a dependency. `install`/`uninstall` are wired as flat `tpm`
aliases; the rest support the smoke suites and skill-relocatability.

- **`tools/consumer/tpm-consumer-install.js`** — graft claude-tpm onto an existing project (check-then-act, idempotent 5-step flow: preflight → dep → marketplace → plugin install → enable, all `--scope project`; `--check` doctor / `--quiet` / `--force`). Calls `npm` + `claude plugin …` directly; never authors project files or `settings.json`. Run: `npx tpm install [dir]` · Doc: header
- **`tools/consumer/tpm-consumer-uninstall.js`** — reverse the install, **scope-aware** (the plugin + marketplace are machine-global singletons): asks *this project only* (disable here + drop the dep, leave the shared marketplace for others) vs *whole system* (plugin uninstall + global marketplace remove + drop the dep), with a secondary consent + a guard when the shared marketplace's source points at this project. `--project` / `--system` set the scope non-interactively. Never deletes the user's files. Run: `npx tpm uninstall [dir]` · Doc: header
- **`npx tpm doctor [dir]`** — read-only health check; a porcelain alias for `install --check` (all the doctor rows, changes nothing). Run: `npx tpm doctor [dir]` · Doc: `tpm.md` / `install` header
- **`tools/consumer/tpm-consumer-check-json.js`** — extract + assert on the strict JSON a headless `claude -p` probe returns (`--truthy` / `--eq` / `--includes`); backs the smoke suites deterministically. Doc: header
- **`tools/consumer/tpm-consumer-lint-skill-refs.js`** — keep the `tpm-*` skills relocatable: flag any bare bundle ref that must carry `%TPM_HOME%/`. Doc: header
- **`tools/consumer/smoke.sh`** — LLM-in-the-loop consumer smoke: headless `claude -p` probes (`skills-present`, `methodology-resolves`, `token-methodology-read`, + the deterministic `npx-tpm-resolves`) asserted via `tpm-consumer-check-json.js`. Run against an installed consumer dir. Doc: header

---

## Hooks — `tools/hooks/` + suite hook scripts

claude-tpm's PreToolUse hooks. The plugin auto-invokes them via the bundle-root `hooks/hooks.json`, which
calls each by a **stable, path-independent** `npx tpm hooks <verb>` command; the hook scripts themselves
live in their owning suite (a workflow gate under `workflow/`, the read-path resolver under `consumer/`).

- **`tools/hooks/tpm-hooks-router.js`** — the `hooks` sub-router: exposes each hook under one stable verb table (`npx tpm hooks <verb>`), dispatching by child process so the harness's PreToolUse payload/stdout/exit-code pass through unchanged. Internal plumbing. Doc: header
- **`tools/workflow/hooks/tpm-workflow-gate-spawn.js`** — PreToolUse hook on `Agent|Task`: the spawn gate (blocks a marked subagent spawn that fails the sign-off check). Run: `npx tpm hooks gate-spawn` · Doc: header
- **`tools/consumer/hooks/expand-tpm-home.js`** — PreToolUse hook on `Read|Glob|Grep|NotebookRead`: resolves the `%TPM_HOME%/…` bundle placeholder in read-tool paths to the real bundle (self-located from `__dirname`; read-family only + containment + fail-open). Run: `npx tpm hooks expand-tpm-home` · Doc: header

---

## Child-session — `tools/child-session/`

Orchestrator-owned Bash scripts for launching and managing a **child Claude session** (a separate `claude`
process the orchestrator drives, headless or remote-controlled). Not wired into `tpm` — run directly with
Bash. They keep the child project pristine and vendor everything the child reads into a per-session folder.

- **`tools/child-session/tpm-child-launch.sh`** — the launcher: spins up a child Claude session against a target project (`--headless "<prompt>"` / `--interactive` / `--print-cmd`), vendoring the session folder and forcing transcript persistence. Run: `bash tools/child-session/tpm-child-launch.sh <child-project-dir> …` · Doc: header
- **`tools/child-session/tpm-child-reap.sh`** — finalize an exited child session: stamp `session.json` (ended/status/exit) and archive the child transcript into the session folder so it survives a later sweep. Non-destructive. Run: `bash tools/child-session/tpm-child-reap.sh <session-dir>` · Doc: header
- **`tools/child-session/tpm-child-watch.sh`** — watch an interactive child by pid/screen name: resolve its transcript path once it registers, then report its first real user message. Run: `bash tools/child-session/tpm-child-watch.sh <pid> <screen-name> <child-cwd>` · Doc: header

---

## Misc — `tools/misc/`

Standalone utilities that aren't part of a suite. Not wired into `tpm` — run directly with `node`.

- **`tools/misc/fix-git-rename/tpm-fix-git-rename-refs.js`** — domain-agnostic reference migrator: after a batch of git renames/deletes, find + fix references to the old paths (`identify` / `fix` / `apply-plan`); provable refs auto-fixed byte-exact, ambiguous ones flagged. Never calls git; zero-dep. Doc: `tpm-fix-git-rename-refs.md` (+ `.design.md`, `.test-design.md`, and the agent-resolution `agent-ambiguous-resolution.design.md` / `.eval-design.md`)
- **`tools/misc/fix-git-rename/find-tool-rename-usages.js`** — the superseded identify-only predecessor of the above (kept for reference). Doc: header

---

## Tests ledger

Every suite's tests are self-contained (zero-dep) and safe to run anywhere (they spawn no real
`claude`/`npm`). Test scratch output goes to `tmp/scratch/<run-slug>/`, out of the tool tree.

- **Everything at once:** `npm test` → `tools/tests/run-all.js` (the top-level aggregator; runs all suites under one scratch slug).
- **`tools/tests/tpm-router.test.js`** — the `tpm` dispatcher: suite/verb routing, unknown → exit 2, arg pass-through, exit-code propagation. Run: `node tools/tests/tpm-router.test.js`
- **`tools/tests/tpm-workflow-lint-selflocate.test.js`** — the lint tool self-locating its canonical manifest. Run: `node tools/tests/tpm-workflow-lint-selflocate.test.js`
- **`tools/workflow/tests/run-all.js`** — the workflow suite. Run: `node tools/workflow/tests/run-all.js`
- **`tools/session/tests/run-all.js`** (+ `tools/session/tests/mutation-check.js`) — the session suite. Run: `node tools/session/tests/run-all.js`
- **`tools/task/tests/run-all.js`** (+ `tools/task/tests/mutation-check.js`) — the task suite. Run: `node tools/task/tests/run-all.js`
- **`tools/consumer/tests/run-all.js`** — install / uninstall (pure exported helpers, incl. `parsePluginList`) + the `expand-hook` unit tests; `expand-hook/smoke.sh` is the LLM smoke. Run: `node tools/consumer/tests/run-all.js`
- **`tools/misc/fix-git-rename/tests/tpm-fix-git-rename-refs/test.js`** — the rename migrator (hermetic temp-dir fixtures). Run: `node tools/misc/fix-git-rename/tests/tpm-fix-git-rename-refs/test.js`
- **`tools/tests/lib/`** — shared test-support (the scratch-dir helper), not a suite.

---

## See also — skills (not tools)

The `tpm-*` skills in `.claude/skills/` are what *compose* these tools into workflows; they are skills,
not tools, so they're not part of this ledger:

- **`tpm-session`** — the session lifecycle (open · close · save · info).
- **`tpm-task`** — the task ledger front door.
- **`tpm-workflow`** — the round lifecycle (plan · run · verify · reconcile · reap · status).
- **`tpm-spawn`** / **`tpm-spawn-team`** — spawn one subagent / a named team.
- **`tpm-reap`** — safe stray-subagent cleanup.
