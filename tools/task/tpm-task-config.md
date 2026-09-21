# `tpm-task-config.js` — the `tasks` config resolver (the #1109 history gate)

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
node tpm-task-config.js [--config <path>] (--json | --get <dotted.key> | --tasks-dir) [--help]
```
Programmatic callers `require('./tpm-task-config')` for `resolveTasksConfig / mergeTasksConfig /
getDefaults / tasksDirAbs / getDotted`.

## Flags
| Flag | Meaning |
|------|---------|
| `--config <path>` | path to `config.json`. Default: `<projectRoot>/.claude/claude-tpm/config.json` (project root = the nearest ancestor with a `CLAUDE.md`). |
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

## Resolved keys (defaults)
`enabled:true` · `tasksDir:".claude/claude-tpm/tasks"` · `startId:1000` · `bucketSize:1000` ·
`defaultOrder:"newest"` · `defaultListState:["open","in-progress"]` · `timezone:"local"` ·
`exportDir:"tmp"` · `allowHardDelete:false` (OFF/safe per #1086 — gates `remove --hard`; opt-in `true`) · `maxOpenWarn:50` · `autoConfirm:{finish:false,drop:false}` ·
`minimalTasks:false` · `subtaskStyle:"letters"` · **`history:{enabled:true}`** (the #1109 gate). The
config accepts either `history: { enabled: <bool> }` or a bare boolean `history`.

## Examples
```
$ node tpm-task-config.js --get history.enabled
true
$ node tpm-task-config.js --get startId
1000
$ node tpm-task-config.js --tasks-dir
/…/claude-tpm-dev/.claude/claude-tpm/tasks
$ node tpm-task-config.js --config /nope/config.json --json
config: --config path does not exist: /nope/config.json
# exit 1
$ node tpm-task-config.js --get no.such.key
config: no such key "no.such.key" in resolved config.
# exit 1
```

No dedicated suite; the resolver is exercised through `tpm-task.js`'s history-gate tests in
`tests/tpm-task-ops.test.js` (the "config resolver exposes the #1109 history gate default" case).
