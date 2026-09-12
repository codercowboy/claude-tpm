# `lib/tpm-task-config.js` — the `tasks` config-section resolver

Resolves the `tasks` section of a project's `.claude/claude-tpm/config.json` — merged over
built-in defaults — so `tpm-task.js` (every subcommand) and the `tpm-task` skill read the SAME 12 keys
the SAME way. This is a **suite-local** resolver (per `tool-conventions.md` Part I §2, portability):
it does NOT `require()` any shared config resolver; it is a small, deliberately-duplicated copy
scoped to just the `tasks` section, mirroring the shape of `tools/session/tpm-session-config.js`.

Every claim below was run against disposable sandbox configs under a tmp tree (each reachable from a
`CLAUDE.md` marker so project-root walking resolves), never a live config.

## Purpose

An absent config file, or an absent `tasks` key, is **not** an error — it resolves to the defaults
(system ON). A malformed config file resolves to defaults **+ a stderr warning** (never a crash) —
matching the module's lenient philosophy. The caller never has to know whether a project customized
its config; it just reads the resolved shape.

**Resolved shape (defaults shown — spec §9):**
```json
{
  "enabled": true,
  "tasksDir": ".claude/claude-tpm/tasks",
  "startId": 1000,
  "bucketSize": 1000,
  "defaultOrder": "newest",
  "defaultListState": ["open", "in-progress"],
  "timezone": "local",
  "exportDir": "tmp",
  "allowHardDelete": true,
  "maxOpenWarn": 50,
  "autoConfirm": { "finish": false, "drop": false },
  "minimalTasks": false,
  "subtaskStyle": "letters"
}
```

## Requirements / invocation shape

```
node lib/tpm-task-config.js [--config <path>] (--json | --get <dotted.key> | --tasks-dir) [--help]
```

- Exactly one of `--json` / `--get <key>` / `--tasks-dir` must be passed (with `--help`, none of the
  above). **Verified:** calling with none of them prints `lib/tpm-task-config.js: nothing to do — pass one of
  --json / --get / --tasks-dir.`, then the usage block, and exits 1.
- `--config <path>` is **optional.** Default:
  `<projectRoot>/.claude/claude-tpm/config.json`, where `<projectRoot>` is found by walking up from
  `cwd` for a `CLAUDE.md` marker (via `lib/tpm-task-paths.js`'s `findRoot`).
  - **Default location that doesn't exist → resolves to defaults, no error.**
  - **An EXPLICIT `--config <path>` that doesn't exist → a friendly error, exit 1.** Verified:
    `--config /no/such/config.json --json` prints `config: --config path does not exist:
    /no/such/config.json` and exits 1 — the asymmetry (default-missing = ok, explicit-missing =
    error) is deliberate.

## The 12 keys

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` ⇒ `tpm-task.js` (and the skill) short-circuit with a clear message and do NO store ops. |
| `tasksDir` | `.claude/claude-tpm/tasks` | Store location (this library overrides to `claude-context/tasks`). Resolved relative to the project root if not absolute. |
| `startId` | `1000` | First task number. |
| `bucketSize` | `1000` | Body-folder bucketing (`bodies/1000-1999/`, …). |
| `defaultOrder` | `newest` | `list` sort when `--order` is omitted. |
| `defaultListState` | `["open","in-progress"]` | The pool `list` shows by default. |
| `timezone` | `local` | Timezone for created/ended stamps + age computation. `local` is exact end-to-end; a named IANA tz is exact on the calendar-day diff, approximate on the sub-24h band (see `tpm-task.md`). |
| `exportDir` | `tmp` | Default destination dir for a no-`--out` `export` (auto-timestamped file). Resolved **relative to the resolved tasks store** (`--tasks-dir`, else `tasksDir`) — so the default export lands at `<tasksDir>/<exportDir>/…` and never escapes a `--tasks-dir` sandbox. An absolute value is used as-is; `--out <path>` overrides to anywhere. |
| `allowHardDelete` | `true` | `false` ⇒ `remove --hard` is refused (only soft-stash is possible). |
| `maxOpenWarn` | `50` | Soft nudge (stderr) when the open pool exceeds this — the §0 skimmability guardrail. |
| `autoConfirm.finish` / `autoConfirm.drop` | `false` / `false` | Whether the SKILL may skip the confirm dialogue for these two modes. `remove --hard` is never auto-confirmable. |
| `minimalTasks` | `false` | A **skill** drafting hint (context optional under quick-capture) — NOT a tool gate (the tool is lenient, G7). |
| `subtaskStyle` | `letters` | `letters` (`1245.A`) at launch; `numbers` accepted by the resolver but not built as dual addressing (Q7). |

**Lenient merge.** Each key is type-checked and only overrides the default when valid (e.g.
`bucketSize` must be a positive integer, `subtaskStyle` must be `letters` or `numbers`); anything
malformed is ignored in favor of the default rather than erroring.

## Flags

| Flag | Effect |
|---|---|
| `--json` | Prints the fully resolved `tasks` config as pretty JSON. Exit 0. |
| `--get <dotted.key>` | Prints one resolved value as JSON (`--get startId` → `1000`; `--get autoConfirm.finish` → `false`). **Because the resolver returns the `tasks` SECTION, keys are bare** — `--get enabled`, NOT `--get tasks.enabled`. A key not in the resolved shape (e.g. `--get nope.nope`) errors `config: no such key "nope.nope" in resolved config.` and exits 1. |
| `--tasks-dir` | Shortcut printing the resolved `tasksDir` as a **bare absolute path** (no JSON quoting), resolved relative to `projectRoot` if not already absolute. Convenient for the skill/other scripts (`--tasks-dir "$(node lib/tpm-task-config.js --tasks-dir)"`). |
| `--config <path>` | Explicit config file path (see the default-vs-explicit-missing asymmetry above). |
| `--help` | Usage. Exits 0. |

## Merge behavior — verified against real config files

- **Overrides honored.** A config with `{"tasks":{"startId":5000,"bucketSize":500,
  "tasksDir":"custom/tasks","subtaskStyle":"numbers"}}` resolved `startId` → `5000`, `bucketSize` →
  `500`, `subtaskStyle` → `"numbers"`, and `--tasks-dir` printed the absolute path ending
  `/custom/tasks` under the project root — every other key at its default.
- **Absent `tasks` key → all defaults.** A config `{"version":1}` with no `tasks` section resolves to
  the exact default shape above.
- **Malformed JSON → defaults + warning, exit 0.** A config that is not valid JSON prints
  `config: could not parse <path> as JSON (...); using built-in defaults.` to stderr and still
  resolves the defaults (a following `tpm-task.js list` ran normally, exit 0).

## Exit codes

| Code | When |
|---|---|
| `0` | The requested mode printed its output, or `--help` was passed. |
| `1` | None of `--json`/`--get`/`--tasks-dir` passed; an explicit `--config <path>` that doesn't exist; `--get <key>` for a key not present in the resolved shape. (A malformed config at the resolved location does NOT exit 1 — it warns and resolves defaults.) |

## Worked example (run against a sandbox)

```
$ node tools/task/lib/tpm-task-config.js --json
{
  "enabled": true,
  "tasksDir": ".claude/claude-tpm/tasks",
  "startId": 1000,
  ...
  "subtaskStyle": "letters"
}

$ node tools/task/lib/tpm-task-config.js --get startId
1000

$ node tools/task/lib/tpm-task-config.js --get autoConfirm.finish
false

$ node tools/task/lib/tpm-task-config.js --tasks-dir
/abs/project/root/.claude/claude-tpm/tasks

$ node tools/task/lib/tpm-task-config.js --config /no/such.json --json
config: --config path does not exist: /no/such.json          # exit 1
```

## See also

- [`../tpm-task.md`](../tpm-task.md) — the tool reference; every subcommand resolves config through here.
- [`../README.md`](../README.md) — the suite readme.
- `out/promote/config-guide-section3.md` — the staged live config-guide §3 patch this resolver's
  keys populate.
