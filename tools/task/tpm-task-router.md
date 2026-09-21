# `tpm-task-router.js` — the `tpm task` sub-router

The `task` sub-router for the `tpm` dispatcher (P06 port; near-verbatim). `task` is a SINGLE-TOOL suite:
`tpm-task.js` owns all the ledger subcommands, so the router forwards almost everything straight through
with the subcommand intact — `tpm task add …` ≡ `tpm-task.js add …`. The reserved verbs are `config`
(→ `tpm-task-config.js`), `export`/`search` (→ `tpm-task-export.js`, the ONE selector core), `doctor`
(→ `tpm-task-doctor.js`), and `migrate` (→ `tpm-task-migrate.js`) — the last two added #1123 for
symmetry with the session router, so the skill can surface `tpm task doctor` / `tpm task migrate`.

Sibling scripts resolve against `__dirname` — no `%TPM_HOME%`/env dependency. Dispatch is by CHILD
PROCESS and the child's exit is propagated. `tpm-task.js` owns its own `--help` and bare listing, so
those pass straight through.

Overview + file map: [`README.md`](README.md). The tools it forwards to: [`tpm-task.md`](tpm-task.md) ·
[`tpm-task-export.md`](tpm-task-export.md) · [`tpm-task-config.md`](tpm-task-config.md).

**Run** (via the `tpm` bin at promotion; standalone in the sandbox):
```
node tpm-task-router.js <subcommand> [args…]
```
Programmatic callers `require('./tpm-task-router')` for `main`, `MAIN`, `CONFIG`, `EXPORT_TOOL`,
`DOCTOR`, `MIGRATE`.

## Routing
| Leading token | Forwards to | argv |
|---------------|-------------|------|
| `config` | `tpm-task-config.js` | the token is dropped; the rest passes through. |
| `export` \| `search` | `tpm-task-export.js` | the mode token is KEPT as `argv[0]` (the export tool's mode dispatch reads it). |
| `doctor` | `tpm-task-doctor.js` | the token is dropped; the rest passes through. |
| `migrate` | `tpm-task-migrate.js` | the token is dropped; the rest passes through. |
| anything else (incl. bare, `--help`, `history`, `list`, `add`, …) | `tpm-task.js` | passed through verbatim. |

The child's exit code is returned unchanged (a signal-killed child maps to `1`); a spawn failure prints
`tpm task: failed to run '<verb>': …` and returns `1`.

## Examples (verified, sandbox)
```
$ node tpm-task-router.js list --tasks-dir /tmp/t --now 2026-09-20T17:00:00-07:00
# → tpm-task.js list … (renders the human index view)

$ node tpm-task-router.js config --get history.enabled
true                                    # → tpm-task-config.js

$ node tpm-task-router.js export --tasks-dir /tmp/t --state finished --json
[ … ]                                   # → tpm-task-export.js (mode token kept)

$ node tpm-task-router.js search --tasks-dir /tmp/t --match router
#1000  bodies/1000-1999/task-1000.json:6  "headline": "Wire the router",

$ node tpm-task-router.js --help
tpm-task — JSON-backed task verbs …      # → tpm-task.js --help (pass-through)

$ node tpm-task-router.js bogus --tasks-dir /tmp/t   # → tpm-task.js, unknown verb
# exit 2 (propagated from the child)
```

No dedicated suite; the router is a thin child-process forwarder over the three tools, each of which
carries its own tests.
