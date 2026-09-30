# `tpm-task-config.js` — the `tasks` config resolver (the #1109 history gate)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

A minimal, suite-local resolver for the `tasks` section of a project's
`.claude/claude-tpm/config.json` (P06 port). It reads the config file if present, merges its `tasks`
section over built-in defaults, and hands back the fully resolved registry so every task tool AND the
tpm-task skill read the same keys the same way. Near-verbatim port of the current
`../claude-tpm/tools/task/tpm-task-config.js`, with two JSON-first deltas: `findRoot` now comes from the
shared base lib via `./lib/base` (#1058), and a new `history: { enabled: true }` key — the #1109 gate
`tpm-task.js` reads (`model.setHistoryEnabled(resolved.history.enabled)`).

Overview + file map: [`README.md`](README.md). Verb tool that consumes the gate: [`tpm-task.md`](tpm-task.md).

**Run:**
```
tpm task config [--config <path>] (--json | --get <dotted.key> | --tasks-dir) [--help]
```
Programmatic callers `require('./tpm-task-config')` for `resolveTasksConfig / mergeTasksConfig /
getDefaults / tasksDirAbs / getDotted`.

## Flags
| Flag | Meaning |
|------|---------|
| `--config <path>` | path to `config.json`. Default: `<projectRoot>/.claude/claude-tpm/config.json` (project root = the nearest ancestor containing a `.claude/claude-tpm/` directory — the install footprint). |
| `--json` | print the resolved `tasks` config as pretty JSON. |
| `--get <dotted.key>` | print one resolved value, e.g. `--get history.enabled`. |
| `--tasks-dir` | print the resolved `tasksDir` as a bare absolute path. |
| `--help` | usage. |

Exactly one of `--json` / `--get` / `--tasks-dir` is required; with none it prints usage and exits `1`.
`--help` exits `0`.

## Resolution rules (lenient)
- An absent config file, or an absent `tasks` key, is **not** an error — it means "use the defaults".
- A malformed config resolves to defaults + a stderr warning (never a crash).
- An EXPLICIT `--config` path that does not exist IS a friendly error + exit `1`.
- An unknown `--get` key exits `1` with a clear message.

## Store-dir resolution — `resolveTasksDir(flag, configPathArg, opts)` (F4 / #1132)
The module export every task **verb** uses so `--tasks-dir` can be OMITTED. Precedence (matches #1078's
`resolve()` spec — arg > env > local config > project-local default):
1. `--tasks-dir` flag → `source:"flag"` (always wins).
2. `TPM_TASKS_DIR` env var → `source:"env"` (an explicit operator opt-in; may point anywhere).
3. local `.claude/claude-tpm/config.json` `tasks.tasksDir` under a `.claude/claude-tpm/`-marked root → `source:"config"`.
4. project-local **default** `<root>/.claude/claude-tpm/tasks` (marker present, no config) → `source:"default"`.
5. no flag, no env, **no `.claude/claude-tpm/` marker** → **FAILS LOUD** (`err.storeResolveFail`).

**Guard:** the item-4 default is only permitted with a real project marker and is a PROJECT-RELATIVE path
resolved under that root — inherently scoped, never a global/home/live store. `--tasks-dir` and
`TPM_TASKS_DIR` may point anywhere because setting them is a deliberate operator act.

## Resolved keys (defaults)
`enabled:true` · `tasksDir:".claude/claude-tpm/tasks"` · `startId:1000` · `bucketSize:1000` ·
`defaultOrder:"newest"` · `defaultListState:["open","in-progress"]` · `timezone:"local"` ·
`exportDir:"tmp"` · `allowHardDelete:false` (OFF/safe per #1086 — gates `remove --hard`; opt-in `true`) · `maxOpenWarn:50` · `autoConfirm:{finish:false,drop:false}` ·
`minimalTasks:false` · `subtaskStyle:"letters"` · **`history:{enabled:true}`** (the #1109 gate). The
config accepts either `history: { enabled: <bool> }` or a bare boolean `history`.

## Examples
```
$ tpm task config --get history.enabled
true
$ tpm task config --get startId
1000
$ tpm task config --tasks-dir
/…/claude-tpm-dev/.claude/claude-tpm/tasks
$ tpm task config --config /nope/config.json --json
config: --config path does not exist: /nope/config.json
# exit 1
$ tpm task config --get no.such.key
config: no such key "no.such.key" in resolved config.
# exit 1
```

No dedicated suite; the resolver is exercised through `tpm-task.js`'s history-gate tests in
`tests/tpm-task-ops.test.js` (the "config resolver exposes the #1109 history gate default" case).
