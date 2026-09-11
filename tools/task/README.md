# `tools/task/` — the `tpm-task` skill's tools

Portable per-suite folder (per `tool-conventions.md` Part I §1) backing the `tpm-task` skill's
task ledger. Copy this whole folder — with its `lib/` — anywhere and it just works: **zero
third-party runtime dependencies, Node built-ins only, no shared cross-suite `require`s.** It runs
via bare `node` today (no `package.json` needed — the `npm run task` alias is deferred, Q5).

## Tool

One directly-invoked CLI, plus one library CLI the skill also calls directly (both ship-intended —
each has a `<tool>.md` and is covered by the tests):

| Tool | What it does | Docs |
|---|---|---|
| `task.js` | The task **engine + write API** — the 14 subcommands (`list`/`show`/`add`/`import`/`export`/`edit`/`check`/`start`/`finish`/`drop`/`remove`/`reopen` + the tool-internal `resolve`/`reindex`) over a per-task-file markdown store. Owns ALL deterministic mechanics; the ONE write path. | [`task.md`](./task.md) |
| `lib/config.js` | Resolves the `tasks` section of a project's `.claude/claude-tpm/config.json` over built-in defaults (12 keys). The skill calls it directly to resolve `--tasks-dir` and to check `enabled`. | [`lib/config.md`](./lib/config.md) |

**Internal-only helpers** (no `<tool>.md` — not invoked directly, only `require()`d by the tools
above):

- `lib/format.js` — the format-token SSOT: the canonical body + index tokens (headings,
  `- **Label:**` field lines, `- [ ] A.` checkbox lines, index rows, the `**Next ID:**` marker)
  AND the read/write logic over them. Its header docstring IS the canonical format spec. Implements
  the **G1 surgical in-place rewrite** — mutations edit only the managed landmark line(s) they
  target and leave every other byte (blank lines, `## Notes` blocks, stray prose) untouched, so
  hand-written prose is never lost on a write.
- `lib/store.js` — the on-disk store engine: body-file read/write with thousand-bucketing, the three
  derived index files, the self-healing Next-ID marker, per-task row placement on a state change,
  and the full `reindex` rebuild. Composes `format.js`'s primitives with `fs`; never hand-parses.
- `lib/render.js` — the view layer: the age ladder (Q3/G2), `list`/`show` rendering, and the shared
  `resolve` selector grammar (spec §5).
- `lib/paths.js` — suite-local `findRoot()` project-root resolver (byte-identical logic to
  `tools/session/lib/paths.js`, copied per the portability rule — never hardcode absolutes), used by
  `lib/config.js`.

## How to run

```
node tools/task/task.js --help                          # top-level usage (all 14 subcommands)
node tools/task/task.js --tasks-dir <dir> list          # the compact open-task view
node tools/task/lib/config.js --json                    # resolved tasks config (12 keys)
```

`--tasks-dir` overrides the store location; otherwise it comes from the resolved `tasks.tasksDir`.
Run every invocation from anywhere inside the project (root is resolved via the `CLAUDE.md` marker).

## Tests

```
node tools/task/tests/run-all.js          # every suite, one shot — 3/3 suites, 195 assertions green
node tools/task/tests/mutation-check.js   # proves the tests catch real breakage — 15/15 mutants killed
```

Per-suite suites (each independently runnable):

```
node tools/task/tests/format/test.js      # 49 units on lib/format.js (lenient parse + surgical mutations + G1 preserve)
node tools/task/tests/render/test.js      # 37 units on lib/render.js (age-ladder boundaries, sorts, selector grammar)
node tools/task/tests/task/test.js        # 109 end-to-end via the real CLI (all modes + G3 matrix + round-trip + reindex)
```

All tests build a disposable sandbox store in `os.tmpdir()` (via `fs.mkdtempSync`, per G8) and resolve
tool paths via `__dirname` — never the live store, and portable across a promotion move. They drive the
real CLI as subprocesses and assert on actual on-disk file content, not just exit codes.
`tests/lib/harness.js` is the shared scaffolding. (`tests/task/bug-repros.test.js` is deliberately
**excluded** from `run-all.js`; it is the closed-bug regression set from the build's verify↔fix loop.)

## How the pieces fit together

```
tpm-task skill (out/skills/tpm-task/{SKILL.md,modes-mutate.md,modes-end.md})
  ├─ lib/config.js   --tasks-dir / --json / --get enabled   (resolve config + store dir)
  └─ task.js         add/import/edit/check/start/finish/drop/remove/reopen/list/show/export/resolve/reindex
                       └─ lib/store.js  (fs engine)  ──uses──▶  lib/format.js  (token SSOT: parse + surgical rewrite)
                          lib/render.js (age ladder, list/show render, resolve selector grammar)
```

`lib/format.js` is the single token SSOT `store.js` imports for both read and write, so the format the
tool writes and the format it parses cannot drift apart — see its header docstring for the canonical
body + index shape.

## Regenerating this doc's claims

Every behavioral claim in the `<tool>.md` files above was verified by running the real CLI against a
disposable sandbox store (`--tasks-dir <tmpdir>`) — never the live `.claude/claude-tpm/tasks/` or the
dogfood `claude-context/tasks/`. Re-run any example command from `task.md` / `lib/config.md` verbatim to
reproduce. The test totals above (195 assertions, 15/15 mutants) were re-run from this folder.
