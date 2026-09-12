# `tpm-session-current.js` — current-session state resolver

Answers "is a session currently open, or not?" and owns allocating the next `session-NNN` folder
number. Backs the `tpm-session` skill's bare-invocation state check (open → `save`, not-opened →
`open`) and `tpm-session-notes.js`'s "which folder is CURRENT" guard — both the skill and the write
API call this directly, on the same footing as `tpm-session-notes.js`/`tpm-session-review.js`.

Every claim below was run against a disposable sandbox tree
(`tmp/bug-fixer-r1/sandbox/`), never the live `claude-context/sessions/`.

## Purpose

A single pointer file — `<sessionsDir>/.current-session.json` — tracks whether a session is open,
which `session-NNN` it is, and when it opened/closed. This is deliberately **not** a
`sessionId -> NNN` map: `$CLAUDE_CODE_SESSION_ID` is read as a best-effort diagnostic
(`sessionIdMismatch` is reported, never gates state), because the open/close lifecycle of the
pointer itself is the reliable disambiguator — see the header docstring in `tpm-session-current.js`
for the full rationale.

## Requirements / invocation shape

```
node tpm-session-current.js --sessions-dir <dir> (--state | --open | --seal | --next-number) [--help]
```

- `--sessions-dir <dir>` — **required.** No default — resolve it via `node tpm-session-config.js
  --sessions-dir` (see `config.md`).
- Exactly one of `--state` / `--open` / `--seal` / `--next-number` must be passed. **Verified:**
  passing none of them (with `--sessions-dir` present) prints `nothing to do — pass one of --state
  / --open / --seal / --next-number.` and exits 1; `--help` prints usage and exits 0.
- Missing `--sessions-dir` errors `--sessions-dir is required.` and exits 1, even before the
  no-mode check.

## Flags

| Flag | Effect | Side effect |
|---|---|---|
| `--state` | Prints the resolved `{ state, number, sessionId, pointerPath, pointer, ... }` as JSON. `state` is `"open"` or `"not-opened"`. When open, also includes `pointerSessionId` (the pointer's own recorded sessionId) and `sessionIdMismatch` (boolean — `true` only when BOTH the env sessionId and the pointer's sessionId are present and differ; a missing env sessionId never flips this). | none |
| `--open` | Ensures a session is open. **Idempotent** — verified: calling `--open` twice in a row against the same pointer returns the SAME `number` with `isNew: false` on the second call, and does not rewrite `openedAt`. On a fresh/closed pointer, allocates via the same logic as `--next-number` and writes a new pointer with `isNew: true`. | writes the pointer file (only when actually opening) |
| `--seal` | Closes the current open session (stamps `closedAt`). **Verified:** calling `--seal` with nothing open errors `current-session: nothing is currently open to seal.` and exits 1 (the double `current-session:` prefix — `main()`'s catch block plus the thrown message's own literal prefix — is real; see `findings/HANDOFF.md`'s non-blocking findings). | writes the pointer file |
| `--next-number` | Prints the next allocation (e.g. `"001"`, `"008"`) with **no side effect** — does not write the pointer or create any folder. Computed as `highest existing session-NNN folder + 1` (or `"001"` if none exist), zero-padded to 3 digits. **Verified quirk (matches the verifier's non-blocking finding #2):** this counts `session-NNN/` *folders on disk*, not entries in the pointer's history — so if a session is opened and sealed WITHOUT ever writing a `session-NNN/` folder (no note file ever created), `--next-number` returns the SAME number again on the next call. Confirmed: `--open` → `001` → `--seal` (no folder ever created) → `--next-number` → `001` again → a following `--open` reopens `001`. This causes no visible harm (nothing was lost — the number was never consumed) and is out of this bug-fixer round's scope (non-blocking finding #2 in the verdict). | none |

## Exit codes

| Code | When |
|---|---|
| `0` | The requested mode ran and returned its JSON/text output, or `--help` was passed. |
| `1` | No args passed; `--sessions-dir` missing; none of `--state`/`--open`/`--seal`/`--next-number` passed; `--seal` called with nothing currently open. |

## Worked example (run against the sandbox)

```
$ node tools/session/tpm-session-current.js --sessions-dir "$SDIR" --state
{ "state": "not-opened", "number": null, "sessionId": "...", "pointerPath": "...", "pointer": null }

$ node tools/session/tpm-session-current.js --sessions-dir "$SDIR" --open
{ "number": "001", "sessionId": "...", "isNew": true, "pointerPath": "..." }

$ node tools/session/tpm-session-current.js --sessions-dir "$SDIR" --open   # idempotent
{ "number": "001", "sessionId": "...", "isNew": false, "pointerPath": "..." }

$ node tools/session/tpm-session-current.js --sessions-dir "$SDIR" --next-number
001

$ node tools/session/tpm-session-current.js --sessions-dir "$SDIR" --seal
{ "number": "001", "closedAt": "2026-08-30T09:16:42.622Z" }

$ node tools/session/tpm-session-current.js --sessions-dir "$SDIR" --seal   # nothing open now
current-session: current-session: nothing is currently open to seal.

$ node tools/session/tpm-session-current.js --sessions-dir "$SDIR" --state
{ "state": "not-opened", "number": null, "sessionId": "...", "pointerPath": "...",
  "pointer": { "sessionId": "...", "number": "001", "openedAt": "...", "closedAt": "..." } }
```

## See also

- `tools/session/config.md` — resolves `--sessions-dir` for this tool (via `--get
  notes.sessionsDir` / `--sessions-dir`).
- `tools/session/tpm-session-notes.md` — the write API; calls `resolveCurrentSession`/`sealSession`
  from this module directly to find/close the CURRENT session before writing.
- `out/skills/tpm-session/SKILL.md` — drives this tool's `--state` output to pick a mode
  (not-opened → `open`, open → `save`) for the skill's bare-invocation default.
