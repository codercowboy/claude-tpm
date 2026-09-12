# `tpm-session-config.js` — the `session` config-section resolver

Resolves the `session` section of a project's `.claude/claude-tpm/config.json` — merged over
built-in defaults — so every `tools/session/*` script and the `tpm-session` skill read the SAME
~6 keys the SAME way. This is a SUITE-LOCAL resolver (per `tool-conventions.md` Part I §2,
portability): it does NOT `require()` `tools/workflow/tpm-workflow-config-resolver.js`; it is a small,
deliberately duplicated copy scoped to just the `session` section.

Every claim below was run against disposable sandbox trees under `tmp/bug-fixer-r1/sandbox/`
(each with its own `CLAUDE.md` marker so project-root walking never escapes to the real repo),
never the live `claude-context/`.

## Purpose

Absent config file, or an absent `session` key, is **not** an error — it resolves to the
defaults. The caller (another `tools/session/*` script, or the `tpm-session` skill) never has to
know whether a project has customized its config; it just reads the resolved shape.

**Resolved shape (defaults shown):**
```json
{
  "enabled": true,
  "notes": { "enabled": true, "sessionsDir": "claude-context/sessions" },
  "showTPMOpenMessage": true,
  "showTPMCloseMessage": true,
  "additionalOpenMessage": "",
  "additionalCloseMessage": ""
}
```

## Requirements / invocation shape

```
node tpm-session-config.js [--config <path>] (--json | --get <dotted.key> | --sessions-dir) [--help]
```

- Exactly one of `--json` / `--get <key>` / `--sessions-dir` must be passed (with `--help`, none
  of the above). **Verified:** calling with none of them prints `nothing to do — pass one of
  --json / --get / --sessions-dir.` and exits 1.
- `--config <path>` is **optional**. Default: `<projectRoot>/.claude/claude-tpm/config.json`,
  where `<projectRoot>` is found by walking up from `cwd` for a `CLAUDE.md` marker (via
  `tpm-session-paths.js`'s `findRoot`).
  - **Default location that doesn't exist → resolves to defaults, no error.** Verified: a fresh
    sandbox with a `CLAUDE.md` but no `.claude/claude-tpm/config.json` at all prints the exact
    default JSON above and exits 0.
  - **An EXPLICIT `--config <path>` that doesn't exist → a friendly error, exit 1.** Verified:
    `--config <nonexistent-path> --json` prints `config: --config path does not exist: <path>`
    and exits 1 — the asymmetry (default-missing = ok, explicit-missing = error) is deliberate,
    per the header docstring.

## Flags

| Flag | Effect |
|---|---|
| `--json` | Prints the fully resolved `session` config as JSON. |
| `--get <dotted.key>` | Prints one resolved value as JSON (e.g. `--get notes.sessionsDir` → `"claude-context/sessions"`, `--get notes.enabled` → `false`). Verified: a key that doesn't exist in the resolved shape (e.g. `--get nope.nope`) errors `no such key "nope.nope" in resolved config.` and exits 1. |
| `--sessions-dir` | Shortcut for `--get notes.sessionsDir`, but prints a **bare absolute path** (no JSON quoting) — resolved relative to `projectRoot` if the configured value isn't already absolute. Convenient for other scripts/shells to consume directly (e.g. `--sessions-dir "$(node tpm-session-config.js --sessions-dir)"`). |
| `--config <path>` | Explicit config file path (see above for default-vs-explicit-missing behavior). |
| `--help` | Usage. Exits 0. |

## Merge behavior — verified against real config files

- **Nested `notes.enabled` + a custom `notes.sessionsDir`** — a config with
  `{"session":{"notes":{"enabled":false,"sessionsDir":"custom/sessions/path"}}}` resolves with
  `notes.enabled: false` and `notes.sessionsDir: "custom/sessions/path"`, every other key at its
  default. `--sessions-dir` printed the absolute path with that custom suffix under the sandbox
  project root. This is the exact nesting `out/promote/config-guide-section1.md` documents for the
  live config-guide.
- **Legacy flat `session.sessionsDir`** (pre-nesting) is honored as a back-compat default for
  `notes.sessionsDir` — verified: `{"session":{"sessionsDir":"legacy/flat/path","enabled":false}}`
  resolves `notes.sessionsDir: "legacy/flat/path"` (nested `notes.enabled` stays at its default
  `true` since the legacy config never set it) and top-level `enabled: false`.
- A raw `session.enabled` boolean with no `notes` object at all still resolves fine — `notes.*`
  falls back to defaults.

## Exit codes

| Code | When |
|---|---|
| `0` | The requested mode printed its output, or `--help` was passed. |
| `1` | None of `--json`/`--get`/`--sessions-dir` passed; an explicit `--config <path>` that doesn't exist; the config file exists but isn't valid JSON (`EBADJSON`); `--get <key>` for a key not present in the resolved shape. |

## Worked example (run against the sandbox)

```
$ node tools/session/tpm-session-config.js --config nonexistent.json --json
config: --config path does not exist: /abs/path/nonexistent.json

$ node tools/session/tpm-session-config.js --json      # no config file at the default location
{
  "enabled": true,
  "notes": { "enabled": true, "sessionsDir": "claude-context/sessions" },
  "showTPMOpenMessage": true, "showTPMCloseMessage": true,
  "additionalOpenMessage": "", "additionalCloseMessage": ""
}

$ node tools/session/tpm-session-config.js --sessions-dir
/abs/project/root/claude-context/sessions

$ node tools/session/tpm-session-config.js --get notes.enabled
false                                                    # (with the nested-override config above)

$ node tools/session/tpm-session-config.js --get nope.nope
config: no such key "nope.nope" in resolved config.
```

## See also

- `tools/session/tpm-session-current.md` — consumes `--sessions-dir` from this resolver.
- `tools/session/tpm-session-notes.md` — the write API; `--sessions-dir` is required on every
  invocation, resolved via this tool.
- `out/promote/config-guide-section1.md` — the staged live config-guide §1 patch this resolver's
  `notes.enabled` nesting is built to match.
