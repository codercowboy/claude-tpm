# `tpm-session-current.js` — current-session state resolver

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Answers "is a session currently open, or not?" and owns allocating the next `session-NNNN` folder
number (four-digit, zero-padded). Backs the `tpm-session` skill's bare-invocation state check (open →
`save`, not-opened → `open`); the skill resolves the session number here, then passes it to the write
surface (`tpm-session-ops.js`) and the reader (`tpm-session-export.js`) as an explicit `--session`.

Every claim below was run against a disposable sandbox tree
(`tmp/bug-fixer-r1/sandbox/`), never the live configured sessions dir.

## Purpose

A single pointer file — `<sessionsDir>/.current-session.json` — tracks whether a session is open,
which `session-NNNN` it is, and when it opened/closed. This is deliberately **not** a
`sessionId -> NNNN` map: `$CLAUDE_CODE_SESSION_ID` is read as a best-effort diagnostic
(`sessionIdMismatch` is reported, never gates state), because the open/close lifecycle of the
pointer itself is the reliable disambiguator — see the header docstring in `tpm-session-current.js`
for the full rationale.

## Requirements / invocation shape

```
tpm session current [--sessions-dir <dir>] (--state | --open | --seal | --next-number) [--help]
```

- `--sessions-dir <dir>` — **optional.** Omitted, it is resolved from the project root's
  `.claude/claude-tpm/config.json` (`session.notes.sessionsDir`, see `config.md`); the flag overrides
  that.
- Exactly one of `--state` / `--open` / `--seal` / `--next-number` must be passed. **Verified:**
  passing none of them (with `--sessions-dir` present) prints `nothing to do — pass one of --state
  / --open / --seal / --next-number.` and exits 1; `--help` prints usage and exits 0.
- Run with no flag in a project, it uses the configured sessions dir (`tpm session current --next-number`
  printed the next number with no `--sessions-dir`).

## Flags

| Flag | Effect | Side effect |
|---|---|---|
| `--state` | Prints the resolved `{ state, number, sessionId, pointerPath, pointer, ... }` as JSON. `state` is `"open"` or `"not-opened"`. When open, also includes `pointerSessionId` (the pointer's own recorded sessionId) and `sessionIdMismatch` (boolean — `true` only when BOTH the env sessionId and the pointer's sessionId are present and differ; a missing env sessionId never flips this). | none |
| `--open` | Ensures a session is open. **Idempotent** — verified: calling `--open` twice in a row against the same pointer returns the SAME `number` with `isNew: false` on the second call, and does not rewrite `openedAt`. On a fresh/closed pointer, allocates via the same logic as `--next-number` and writes a new pointer with `isNew: true`. | writes the pointer file (only when actually opening) |
| `--seal` | Closes the current open session (stamps `closedAt`). **Verified:** calling `--seal` with nothing open errors `current-session: nothing is currently open to seal.` and exits 1 (the double `current-session:` prefix — `main()`'s catch block plus the thrown message's own literal prefix — is real; see `findings/HANDOFF.md`'s non-blocking findings). | writes the pointer file |
| `--next-number` | Prints the next allocation (e.g. `"0001"`, `"0008"`) with **no side effect** — does not write the pointer or create any folder. Computed as `highest existing session-NNNN folder + 1` (or `"0001"` if none exist), zero-padded to **four** digits. **Continuity with pre-v1.0 folders:** the folder scan still recognizes three-digit `session-NNN` dirs, so a workspace whose newest folder is `session-019` allocates `0020` next (**verified:** a dir holding only `session-019` → `--next-number` → `0020`). Allocation counts *folders*, not the version preamble — a pre-v1.0 folder is skipped by the readers (`boot-read`/`review`) but is still counted here so its number is never reused. **Verified quirk (non-blocking finding #2):** it counts `session-NNNN/` *folders on disk*, not entries in the pointer's history — so if a session is opened and sealed WITHOUT ever writing a `session-NNNN/` folder (no note file ever created), `--next-number` returns the SAME number again on the next call (`--open` → `0001` → `--seal` (no folder) → `--next-number` → `0001` again). This causes no visible harm (the number was never consumed). | none |

## Exit codes

| Code | When |
|---|---|
| `0` | The requested mode ran and returned its JSON/text output, or `--help` was passed. |
| `1` | No args passed; `--sessions-dir` missing; none of `--state`/`--open`/`--seal`/`--next-number` passed; `--seal` called with nothing currently open. |

## Worked example (run against the sandbox)

```
$ tpm session current --sessions-dir "$SDIR" --state
{ "state": "not-opened", "number": null, "sessionId": "...", "pointerPath": "...", "pointer": null }

$ tpm session current --sessions-dir "$SDIR" --open
{ "number": "0001", "sessionId": "...", "isNew": true, "pointerPath": "..." }

$ tpm session current --sessions-dir "$SDIR" --open   # idempotent
{ "number": "0001", "sessionId": "...", "isNew": false, "pointerPath": "..." }

$ tpm session current --sessions-dir "$SDIR" --next-number
0001

$ tpm session current --sessions-dir "$SDIR" --seal
{ "number": "0001", "closedAt": "2026-08-30T09:16:42.622Z" }

$ tpm session current --sessions-dir "$SDIR" --seal   # nothing open now
current-session: current-session: nothing is currently open to seal.

$ tpm session current --sessions-dir "$SDIR" --state
{ "state": "not-opened", "number": null, "sessionId": "...", "pointerPath": "...",
  "pointer": { "sessionId": "...", "number": "0001", "openedAt": "...", "closedAt": "..." } }
```

## See also

- `tools/session/config.md` — resolves `--sessions-dir` for this tool (via `--get
  notes.sessionsDir` / `--sessions-dir`).
- `tools/session/tpm-session-ops.md` — the write surface; the skill uses this tool's `--open`/`--seal`
  to allocate/close the CURRENT session number, then passes it to `ops` as `--session`.
- `out/skills/tpm-session/SKILL.md` — drives this tool's `--state` output to pick a mode
  (not-opened → `open`, open → `save`) for the skill's bare-invocation default.
