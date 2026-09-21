# `tpm` — the claude-tpm command dispatcher

`tpm` is the single git-style front door to claude-tpm's tooling. It is shipped as the package `bin`,
so in a consumer it's reachable as `npx tpm …` (or a linked `tpm` on `PATH`).

```
tpm <suite> <verb> [args…]
```

## The two-level model

`tpm.js` is a **dumb top dispatcher**: it knows only *suites*, and forwards `<suite> <everything-after>`
verbatim to that suite's own router (`tools/<suite>/tpm-<suite>-router.js`). Each **suite router** owns
its short-verb table and maps a verb to a sibling script. Both levels dispatch by child process
(`spawnSync('node', …, {stdio:'inherit'})`) and propagate the child's exit code.

Adding, renaming, or removing a verb touches only that suite's router — never `tpm.js`. The canonical
tool ledger is [`tools/README.md`](README.md).

**No `%TPM_HOME%` / env needed.** Every router self-locates its scripts from its own `__dirname`, so a
`tpm …` invocation resolves the bundle on its own. This is why skill prose can call `npx tpm <suite>
<verb>` instead of `node %TPM_HOME%/tools/<suite>/<tool>.js` — routing through `tpm` removes the
`%TPM_HOME%` token from Bash invocations entirely.

## Suites & verbs

| Suite | Verbs | → scripts under |
|---|---|---|
| `session` | `config` · `current` · `notes` · `review` | `tools/session/` |
| `task` | any `tpm-task.js` subcommand (`add`/`list`/`show`/…) passes through; `config` → the resolver | `tools/task/` |
| `workflow` | `audit` · `compose` · `lint` · `scaffold` · `cost` · `signoff` · `doctor` · `config` · `check-filename` | `tools/workflow/` |
| `hooks` | `gate-spawn` · `expand-tpm-home` | `tools/hooks/` (+ each suite's hook script) |

Verbs are **short** — the suite name namespaces them (e.g. `tpm workflow scaffold`, not
`scaffold-subagent`). `tpm <suite> --help` (or bare `tpm <suite>`) lists that suite's verbs.

**Not exposed as verbs:** the skill *modes* (`/tpm-session open|close`, `/tpm-workflow plan|verify|
reconcile`) — those are orchestration the model drives (reading chains, MOTD), not scripts. The `hooks`
verbs exist for the harness to invoke, not for a human to type.

## Consumer-adoption aliases (flat, no suite)

| Command | → script |
|---|---|
| `tpm install [dir] [options]` | `tools/consumer/tpm-consumer-install.js` |
| `tpm uninstall [dir] [options]` | `tools/consumer/tpm-consumer-uninstall.js` |
| `tpm doctor [dir]` | `tools/consumer/tpm-consumer-install.js` (with `--check` appended: `doctor` *is* `install --check`) |

These are the human porcelain for adoption (`npx tpm install .`), so they stay top-level rather than
under a `consumer` suite.

## Exit codes

- The child's exit code is propagated verbatim (so `tpm session config --json` exits exactly as the
  underlying tool does).
- Unknown suite (at `tpm.js`) or unknown verb (at a suite router) → **exit 2** + the relevant menu.
- A dispatch failure (child couldn't be spawned) → exit 1.
- Bare invocation or `--help` / `-h` → the menu, exit 0.

## Examples

```
npx tpm                                      # top menu
npx tpm session notes resume --where "…" --next "…"
npx tpm session current --sessions-dir .claude/claude-tpm/sessions --open
npx tpm task add --from ./tmp/tpm-task/add-foo.md
npx tpm task config --tasks-dir
npx tpm workflow scaffold add-phase dev/<epic> --slug <slug> --team <team>
npx tpm workflow doctor --json
npx tpm install .
```

## Tests

`tools/tests/tpm-router.test.js` — 13 assertions over the whole chain: suite/verb routing, unknown →
exit 2, faithful arg pass-through, and exit-code propagation across both hops (using only non-mutating
child commands). Run: `node tools/tests/tpm-router.test.js`.
