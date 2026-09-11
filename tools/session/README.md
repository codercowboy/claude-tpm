# `tools/session/` — the `tpm-session` skill's tools

Portable per-suite folder (per `tool-conventions.md` Part I §1) backing the `tpm-session` skill's
four modes (`open`/`close`/`save`/`info`). Copy this whole folder — with its `lib/` — anywhere and
it just works: zero third-party runtime dependencies, no shared cross-suite `require`s.

## Tools

Two directly-invoked CLIs, plus two library CLIs the skill also calls directly (all four are
ship-intended — each has tests + a `<tool>.md`):

| Tool | What it does | Docs |
|---|---|---|
| `session-notes.js` | The session-notes **write API** — `init`/`resume`/`open add\|done`/`log`/`decide`/`seal` against the CURRENT session's `session-notes.md`, enforcing the two-zone rule (STATE rewritten in place, LOG append-only) and the sealed-session immutability guard. | [`session-notes.md`](./session-notes.md) |
| `session-review.js` | The session-notes **read API** — cheap extraction of the last N sessions' Open items / Decisions / overview, without loading every note into context. | [`session-review.md`](./session-review.md) |
| `lib/current-session.js` | Resolves/mutates the **current-session pointer** (`.current-session.json`): is a session open, which `session-NNN`, allocate the next number. Both the skill (bare-invocation state check) and `session-notes.js` (which-folder-is-CURRENT guard) call this directly. | [`lib/current-session.md`](./lib/current-session.md) |
| `lib/config.js` | Resolves the `session` section of a project's `.claude/claude-tpm/config.json` over built-in defaults (`notes.enabled`, `notes.sessionsDir`, message toggles). The skill calls this directly to resolve `--sessions-dir` and to check `session.enabled`. | [`lib/config.md`](./lib/config.md) |

**Internal-only helpers** (no `<tool>.md` — not invoked directly by the skill or any other
consumer, only `require()`d by the tools above):

- `lib/format.js` — the format-token SSOT (`parseNote`/`renderNote`/regexes for headings, open
  items, decisions, log entries). Its own header docstring IS the canonical format spec.
- `lib/paths.js` — suite-local `findRoot()` project-root resolver (per `tool-conventions.md`'s
  "never hardcode absolutes" rule), used by `lib/config.js`.

## Tests

```
node tests/session/run-all.js          # every suite, one shot — 5/5 green
node tests/session/mutation-check.js   # proves the tests actually catch real breakage (17/17 mutants killed)
```

Per-tool suites (each independently runnable):

```
node tests/session/lib-format/test.js
node tests/session/lib-config/test.js
node tests/session/lib-current-session/test.js
node tests/session/session-notes/test.js
node tests/session/session-review/test.js
```

All tests drive the real CLIs as subprocesses against disposable sandboxes under
`tmp/test-writer-r1/sandbox/<prefix>-<random>/` (never the live `claude-context/sessions/`) and
assert on actual on-disk file content — not just exit codes. `tests/session/lib/harness.js` is the
shared scaffolding (`makeChecker`, `runNode`, `mkSandbox`, the `TOOLS` path map).

## How the pieces fit together

```
tpm-session skill (out/skills/tpm-session/{SKILL.md,modes-open.md,modes-close.md})
  ├─ lib/config.js         --sessions-dir / --json     (resolve config)
  ├─ lib/current-session.js --state / --open / --seal   (resolve/mutate "what session is current")
  ├─ session-notes.js       init/resume/open/log/decide/seal   (write, via lib/format.js)
  └─ session-review.js      --last N [--open-items|--decisions]   (read, via lib/format.js)
```

`lib/format.js` is the single token SSOT both `session-notes.js` (write) and `session-review.js`
(read) import, so write/read tokens cannot drift apart — see its own header docstring for the
canonical format.

## Regenerating this doc's claims

Every behavioral claim in the `<tool>.md` files above was verified by running the real CLI
against a disposable sandbox (`tmp/bug-fixer-r1/sandbox/`, `tmp/documentarian-r1/sandbox/`) —
never the live `claude-context/sessions/`. Re-run any example command from a `<tool>.md` verbatim
to reproduce.
