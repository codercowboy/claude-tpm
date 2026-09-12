# `tools/session/` — the `tpm-session` skill's tools

Portable per-suite folder (per `tool-conventions.md` Part I §1) backing the `tpm-session` skill's
four modes (`open`/`close`/`save`/`info`). Copy this whole folder anywhere and
it just works: zero third-party runtime dependencies, no shared cross-suite `require`s.

## Tools

Two directly-invoked CLIs, plus two library CLIs the skill also calls directly (all four are
ship-intended — each has tests + a `<tool>.md`):

| Tool | What it does | Docs |
|---|---|---|
| `tpm-session-notes.js` | The session-notes **write API** — `init`/`resume`/`open add\|done`/`log`/`decide`/`seal` against the CURRENT session's `session-notes.md`, enforcing the two-zone rule (STATE rewritten in place, LOG append-only) and the sealed-session immutability guard. | [`tpm-session-notes.md`](./tpm-session-notes.md) |
| `tpm-session-review.js` | The session-notes **read API** — cheap extraction of the last N sessions' Open items / Decisions / overview, without loading every note into context. | [`tpm-session-review.md`](./tpm-session-review.md) |
| `tpm-session-current.js` | Resolves/mutates the **current-session pointer** (`.current-session.json`): is a session open, which `session-NNN`, allocate the next number. Both the skill (bare-invocation state check) and `tpm-session-notes.js` (which-folder-is-CURRENT guard) call this directly. | [`tpm-session-current.md`](./tpm-session-current.md) |
| `tpm-session-config.js` | Resolves the `session` section of a project's `.claude/claude-tpm/config.json` over built-in defaults (`notes.enabled`, `notes.sessionsDir`, message toggles). The skill calls this directly to resolve `--sessions-dir` and to check `session.enabled`. | [`config.md`](./config.md) |

**Internal-only helpers** (no `<tool>.md` — not invoked directly by the skill or any other
consumer, only `require()`d by the tools above):

- `tpm-session-format.js` — the format-token SSOT (`parseNote`/`renderNote`/regexes for headings, open
  items, decisions, log entries). Its own header docstring IS the canonical format spec.
- `tpm-session-paths.js` — suite-local `findRoot()` project-root resolver (per `tool-conventions.md`'s
  "never hardcode absolutes" rule), used by `tpm-session-config.js`.

## Tests

```
node tools/session/tests/run-all.js          # every suite, one shot — 5/5 green
node tools/session/tests/mutation-check.js   # proves the tests actually catch real breakage (17/17 mutants killed)
```

Per-tool suites (each independently runnable):

```
node tools/session/tests/lib-format/test.js
node tools/session/tests/lib-config/test.js
node tools/session/tests/lib-current-session/test.js
node tools/session/tests/tpm-session-notes/test.js
node tools/session/tests/tpm-session-review/test.js
```

All tests drive the real CLIs as subprocesses against disposable sandboxes under
`tmp/test-writer-r1/sandbox/<prefix>-<random>/` (never the live `claude-context/sessions/`) and
assert on actual on-disk file content — not just exit codes. `tools/session/tests/lib/harness.js` is the
shared scaffolding (`makeChecker`, `runNode`, `mkSandbox`, the `TOOLS` path map).

## How the pieces fit together

```
tpm-session skill (out/skills/tpm-session/{SKILL.md,modes-open.md,modes-close.md})
  ├─ tpm-session-config.js         --sessions-dir / --json     (resolve config)
  ├─ tpm-session-current.js --state / --open / --seal   (resolve/mutate "what session is current")
  ├─ tpm-session-notes.js       init/resume/open/log/decide/seal   (write, via tpm-session-format.js)
  └─ tpm-session-review.js      --last N [--open-items|--decisions]   (read, via tpm-session-format.js)
```

`tpm-session-format.js` is the single token SSOT both `tpm-session-notes.js` (write) and `tpm-session-review.js`
(read) import, so write/read tokens cannot drift apart — see its own header docstring for the
canonical format.

## Regenerating this doc's claims

Every behavioral claim in the `<tool>.md` files above was verified by running the real CLI
against a disposable sandbox (`tmp/bug-fixer-r1/sandbox/`, `tmp/documentarian-r1/sandbox/`) —
never the live `claude-context/sessions/`. Re-run any example command from a `<tool>.md` verbatim
to reproduce.
