# Stage-D functional smoke — `tools/tests/smoke/`

A **doc-driven functional smoke** of the promoted session/task tooling. The harness lays a *selected* set
of stand-alone prose test docs into a fresh consumer, configures its stores, and spawns a headless
ORCHESTRATOR-shaped agent that works through the docs using the `tpm-*` skills and `npx tpm <suite> <verb>`
verbs — then leaves structured feedback. It answers the "spiritual" question: **does the tooling actually
work when a real headless agent uses it, with no hooks and no spoon-feeding?**

## Which smoke is which (avoid the "three smokes" confusion)

| Rig | What it proves |
|---|---|
| `tools/consumer/smoke.sh` | **Quick install-sanity probe** — the plugin loads and its skills resolve their refs in a consumer. Deterministic CLI probes + a few JSON-schema LLM probes. |
| `tools/tests/smoke/` (this dir) | **Richer doc-driven FUNCTIONAL smoke** — a real headless agent drives the session/task verbs through prose test docs and reports 3-bucket feedback. |
| `tools/tests/run-all.js` | The **zero-dep unit suites** (`npm test`). This rig is not part of it (it needs a live `claude`). |

## Run it

```
# happy-path session + task, auto permission mode, fresh scaffolded consumer (the intended first run):
bash tools/tests/smoke/run-smoke.sh --fresh --mode auto --tests test-session-smoke,test-task-smoke

# lay-down / flag check only — scaffold + configure + lay down, but do NOT spawn the agent:
bash tools/tests/smoke/run-smoke.sh --target /path/to/consumer --tests test-session-smoke --no-agent
```

### Flags

- `--tests <comma-list>` — which docs to lay down. The `test-` prefix and `.md` suffix are optional
  (`session-smoke` == `test-session-smoke` == `test-session-smoke.md`). **Only the selected docs** are
  written into the consumer's `smoke/` — a session/task run never lays down the workflow or resume docs.
  Default: `test-session-smoke,test-task-smoke`.
- `--mode auto|dangerous` — permission mode for the spawned agent. **Default `auto`** =
  `--permission-mode acceptEdits` + `--allowedTools "Bash,Read,Write,Edit,Glob,Grep"`. `dangerous` =
  `--dangerously-skip-permissions` (opt-in; not needed for the first run).
- `--fresh` — scaffold a new consumer under the scratch root (`<scratch>/smoketest-<slug>`). Default when
  no `--target` is given.
- `--target <dir>` — use an existing consumer instead of scaffolding.
- `--no-agent` — do everything except spawn the agent (scaffold + configure stores + lay down docs), then
  print the exact `claude -p` command it would have run. For CI / lay-down / flag checks.
- `--timeout <secs>` — wall-clock cap for the spawned agent (default 600).
- `--help`.

`SMOKE_TMP` overrides the scratch root (default: the bundle's sibling workspace `tmp/`, else `<bundle>/tmp`).
Prior `smoketest-*` runs are swept aside to `<scratch>/safe-to-delete/` via `mv` (this rig never `rm`s).

## How the store gets configured (#1126.G)

Every `npx tpm task|session` verb REQUIRES `--tasks-dir`/`--sessions-dir` — the tools never default to a
live store, so a bare consumer errors `--tasks-dir <dir> is required`. The harness therefore writes
`<consumer>/.claude/claude-tpm/config.json` with a `tasksDir` + `sessionsDir`, which makes
`npx tpm task config --tasks-dir` and `npx tpm session config --sessions-dir` resolve to absolute paths.
Each test doc opens by capturing those and passing them on every verb.

## Scaffolding

The `--fresh` path **ports** the proven logic from `claude-tpm-dev/tools/hooktest/scaffold-consumer.sh`
inline (npm init + `npx tpm install <dir> --force --quiet` from the bundle + a `~/.claude.json`
folder-trust seed). It is ported rather than called because this rig **ships inside the bundle** and must
be self-contained — a consumer has no `claude-tpm-dev` workspace to reach back into.

## Adding a test doc

1. Drop a stand-alone prose doc at `docs/test-<name>.md`. It must be self-contained instructions an
   orchestrator can follow with **only** `npx tpm <suite> <verb>` commands — never a `.js` path (the
   shipped doctrine; the skill-refs lint flags `.js`).
2. End it with the **3-bucket feedback schema** — *What worked* / *What didn't* / *What would help to work
   differently* — plus a **per-step PASS/FAIL** instruction and an `OVERALL: PASS|FAIL` line, telling the
   agent to write `smoke/feedback-test-<name>.md`.
3. If the doc needs a fixture (e.g. `test-session-details` migrates an old marked 3-file store), add it
   under `docs/fixtures/…` and teach `run-smoke.sh` to copy it in when that doc is selected.
4. Opt into it with `--tests test-<name>`.

## Docs shipped so far

- `test-session-smoke` — session happy path: `current --next-number` → `ops open` → `note` → `punchlist`
  → `import-handoff` → `save` → `close`; confirm via `doctor` + `boot-read`.
- `test-session-details` — edges: `import-log` / `import-punchlist` / `import-handoff`; review via
  `export --style human`; read-only `doctor`; opt-in `migrate` of the `fixtures/old-session-0007` store.
- `test-task-smoke` — task happy path: `add` (labels) → `add-subtask` → `start` → close-guard refusal
  (#1111) → `check` → `finish --action`; confirm via `show` / `list`.
- `test-task-details` — edges: `label`/`labels`/`list --label`, `import --template` → `import --file`
  (`--prune`), `--body-txt-file`, `history`, `search` (+ comma-id set), `drop --reason`.

Deferred to a follow-on (not built yet): `test-workflow-smoke`, `test-workflow-details`,
`test-session-resume` (multi-session continuity), and the harness's sequential-session mode.
