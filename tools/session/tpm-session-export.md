# `tpm-session-export.js` — session export (`#1113`)

The node-invokable export tool for `kind:"session"` records (P05). It reads canonical JSON through the
model's load path (read → migrate → validate) and emits JSON and/or the human render — one session or
many, combined or per-file. It **composes** the blessed shared pieces (`loadSession`,
`session-converter.render`, and the scaffold's `selectRecords`/`combine`/`dispatch`) and re-implements
none of them.

**Run (Q5 — no bin, no npm-run):**
```
npx tpm session export [flags]
```
Programmatic callers `require('./tpm-session-export')` for `exportSessions(opts)` (plus helpers
`resolveRecords`, `enumerateSessions`, `normalizeStyles`, `padNumber`).

## Flags

| Flag | Meaning |
|------|---------|
| `--sessions-dir <dir>` | directory of `session-<NNNN>.json` (a SCRATCH or real dir). Required unless pre-loaded `records` are passed programmatically. |
| `--last N` | export the N most-recent sessions, **newest first**. |
| `--session <NNNN>[,NNNN] …` | explicit selector list (repeatable / comma-list) — the `#1092` seam, resolved in the order given; no re-matching. |
| `--style json\|human\|both` | output format(s); repeatable / comma-list. Default `json`. |
| `--combine one-file\|per-file` | multi-session: ONE combined file (default) or per-session files. |
| `--out <dir\|file>` | write here (dir = one file per `suggestedName`; a `.json`/`.md` path = a single file). Omit → stdout. |
| `--now <iso>` | reference time for punchlist age (default: now, local offset). Bound once per export in a closure so open items render an age. |

## Export shapes

- **Single session — full JSON:** the bare canonical envelope (carries `schemaVersion`). `--session <one>`.
- **Single session — human:** the converter's `.md` (one-way, NOT re-importable).
- **Multi (combined, Q4):** JSON = a **bare array** of session envelopes (no wrapper); human = the **full
  per-session render repeated** per session (one `# Session NNNN` header each, not one top header).
  `--combine one-file` (the multi default).
- **Multi (per-file):** one file per session, `session-<NNNN>.{json,md}`. `--combine per-file`.
- **JSON and/or human:** `--style json` / `human` / `both`. With `both` + per-file, each session yields
  both a `.json` and a `.md`.

Combined shape and the repeated-header rule are the authority of
[`../export-spec.md`](../export-spec.md) § *Export surface* (Q4) — see it for the locked details.

## The search-composition seam (`#1092`)

Candidates resolve three ways, in precedence order (in `resolveRecords`), then an optional `filter`
composes over them via the scaffold — matching is never reimplemented here:

1. `opts.records` — a pre-loaded, already-validated result-set (no dir needed).
2. `opts.selector` / `--session` — an explicit id/selector list; a miss fails loud.
3. `opts.last` / `--last N` — the N highest-numbered sessions, newest first.

A selection that resolves to no sessions fails loud, with the message depending on which path came up
empty:
- an explicit `--session`/`opts.selector` entry that names a missing session →
  `tpm-session-export: selector '<sel>' matched no session-<NNNN>.json in '<dir>'`;
- any other empty resolution (e.g. an `opts.records`/`filter` path, or `--last N` over an empty dir) →
  `tpm-session-export: the selection resolved to zero sessions`.

## Thin/editable export — NOT wired (Q3)

There is no thin/editable session export and no `--thin` flag; `normalizeStyles` accepts only
`json|human|both`. `trimNonEditable` stays in the base lib for `#1112` but is not wired to any session
CLI flag.

## Examples (run-verified against a scratch dir)

```
# single-session full JSON to stdout
npx tpm session export --sessions-dir /tmp/s --session 0050 --style json
#   -> {
#        "schemaVersion": "1.0.0",
#        "kind": "session",
#        "meta": { "number": "0050", …

# last 2 sessions, combined human — one # Session header per session
npx tpm session export --sessions-dir /tmp/s --last 2 --style human
#   -> 2 "# Session NNNN" headers

# last 2 sessions, combined JSON — a bare array of envelopes
npx tpm session export --sessions-dir /tmp/s --last 2 --style json
#   -> [
#        {
#          "schemaVersion": "1.0.0",
#          …

# per-file, both styles, into an out dir
npx tpm session export --sessions-dir /tmp/s --last 2 --style both --combine per-file --out /tmp/s/out
#   -> wrote 4 file(s):
#        /tmp/s/out/session-0051.json
#        /tmp/s/out/session-0050.json
#        /tmp/s/out/session-0051.md
#        /tmp/s/out/session-0050.md
```

`--last N` emits newest-first (descending session number); an explicit `--session` selector preserves the
order you give.

Tests: `session-tooling/tests/session-export.test.js` (auto-discovered by `tests/run-all.js`).
