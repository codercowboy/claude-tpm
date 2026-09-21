# `tpm-session-save.js` — the gated, linted checkpoint

Rewrites the current session's `session-NNNN-handoff.md` wholesale from a small JSON payload, seeds its
"What remains" mechanically from the live `session-NNNN-punchlist.md`, and refreshes the shared
wayfinding header on all three session files. This is the **mechanical gate** of a session save: the one
thing always true of a save is that the handoff ends up complete, so a cold resume can always pick up.

The three files in a `session-NNNN/` folder are all **prefixed with the session number** —
`session-NNNN-handoff.md`, `session-NNNN-punchlist.md`, `session-NNNN-log.md` (the ledger) — and each
opens with a `tpm-session-version: 1.0` preamble in its wayfinding header (see
`claude-context/methodology/session-notes-format.md`). Numbering is four digits, zero-padded.

`save` OWNS the handoff only. It **reads** `session-NNNN-punchlist.md` (never writes items — that is
`tpm-session-punchlist.js`) and refreshes the header on `session-NNNN-log.md` (never rewrites its body —
the ledger stays append-only).

Every claim below was run against a disposable sandbox tree, never the live configured sessions dir.

## Requirements / invocation shape

```
npx tpm session save --sessions-dir <dir> --payload <file.json>
```

- `--sessions-dir <dir>` — **required.** Resolve it via `npx tpm session config --sessions-dir`.
- `--payload <file.json>` — **required. A file path only (no stdin).** A flat JSON object:
  ```jsonc
  { "where": "…",              // REQUIRED, non-empty after trim
    "next":  "…",              // REQUIRED, non-empty after trim
    "in_flight": "…",          // optional → string OR list of strings; defaults to "Nothing in flight."
    "must_not_redo": ["…"] }   // optional → string OR list of strings; section omitted when absent
  ```
- `--help`/`-h` prints usage and exits 0.
- Requires a session to be open (`tpm-session-current.js`); with none open, `save` is refused (exit 1).

## Lint (the gate)

Checked in order; the first failure names the offending field and **writes nothing**:
1. the payload must parse to a JSON **object** (an array or scalar is refused);
2. no **unknown top-level key** (typo guard — allowed keys are `where`, `next`, `in_flight`,
   `must_not_redo`);
3. `where` and `next` present and non-empty after trim;
4. `in_flight`, if present, a string **or** a list of strings (a list is joined into one line);
5. `must_not_redo`, if present, a string **or** a list of strings (a bare string is wrapped to a 1-item list).

## Exit codes

| Code | When |
|---|---|
| `0` | Handoff written. May still print a soft advisory (see NUDGE below) — an advisory does NOT block. |
| `1` | **Refused** — a lint failure OR no session open. **Nothing is written.** The message names the field. |
| `2` | **Usage/parse** — bad flag, missing `--sessions-dir`/`--payload`, unreadable file, or invalid JSON. |

Note: an array or scalar payload is a **lint refusal (exit 1)**, not a parse error — it parsed as valid
JSON, it just isn't the expected object.

## What a successful save does

1. Rewrites `session-NNNN-handoff.md` wholesale via the format SSOT: the head (`Where we are` /
   `Next action` / `In flight`) from the payload; `## What remains` rebuilt **mechanically** from the
   current `session-NNNN-punchlist.md` open items (never hand-typed); `## MUST NOT redo` from
   `must_not_redo` (omitted when absent).
2. On the **first save of a session**, creates `session-NNNN-punchlist.md` and `session-NNNN-log.md` too
   (header + empty sections), so any file a human opens reveals the other two.
3. Refreshes the wayfinding header on all three files **surgically** — it replaces only the anchored
   header block (which carries `tpm-session-version: 1.0`), so the append-only `session-NNNN-log.md` body
   stays byte-stable.

## NUDGE — the non-blocking advisory (exit 0)

After writing, `save` echoes the still-open punchlist so a forgotten "tick it off" is confronted, not
gated:
- open items exist → `still open: #1.1 #1.3 …` (close any that are actually done and re-save).
- zero open items and none added → `⚠ punchlist has 0 open items and none were added — is that
  intended?` — fine for a genuine "just snapshot progress" save, worth a second look otherwise.

## Worked example — a save with an open item (run against the sandbox)

```
$ npx tpm session current   --sessions-dir "$SDIR" --open        # session 0001
$ npx tpm session punchlist  --sessions-dir "$SDIR" add "Add the backend export endpoint"
punchlist: added #1.1  [79qdq4]

$ cat handoff.json
{
  "where": "Toolbar button shipped and wired to exportCsv(); backend endpoint still pending.",
  "next": "Add the backend export endpoint.",
  "must_not_redo": ["Do not re-add CSV escaping — reuse exportCsv()."]
}

$ npx tpm session save --sessions-dir "$SDIR" --payload handoff.json
save: wrote session-0001-handoff.md for session 0001 (.../session-0001)
still open: #1.1
$ echo $?
0
```

Resulting `session-0001/session-0001-handoff.md` (verified):

```markdown
<!-- tpm-session: 0001 · 2026-09-17 · tpm-session-version: 1.0 · files: session-0001-handoff.md, session-0001-punchlist.md, session-0001-log.md -->
> **Session 0001 memory — three files in this folder.  THIS FILE: handoff.**
> • **session-0001-handoff.md** — READ FIRST: where we are, next action, what NOT to redo.
> • **session-0001-punchlist.md** — open/done work items (numbered).
> • **session-0001-log.md** — append-only ledger: Decisions + Log (log reads **bottom-to-top**).

# HANDOFF — session 0001 — 2026-09-17
> ⚠️ READ THIS FULLY before doing anything. Unfinished punchlist items below are required reading.

## Where we are / Next / In flight
**Where we are:** Toolbar button shipped and wired to exportCsv(); backend endpoint still pending.
**Next action:** Add the backend export endpoint.
**In flight:** Nothing in flight.

## What remains
- #1.1 · Add the backend export endpoint  [79qdq4, 2026-09-17T09:00:21-07:00]

## MUST NOT redo
- Do not re-add CSV escaping — reuse exportCsv().
```

## Refused and usage cases (verified)

```
$ printf '{"where":"only where"}' > bad.json
$ npx tpm session save --sessions-dir "$SDIR" --payload bad.json ; echo $?
save: refused — "next" is required and must be a non-empty string.
1

$ printf '{"where":"w","next":"n","bogus":1}' > bad.json
$ npx tpm session save --sessions-dir "$SDIR" --payload bad.json ; echo $?
save: refused — unknown top-level key "bogus" (allowed: where, next, in_flight, must_not_redo).
1

$ printf 'not json' > bad.json
$ npx tpm session save --sessions-dir "$SDIR" --payload bad.json ; echo $?
tpm-session-save.js: payload bad.json is not valid JSON: Unexpected token 'o', "not json" is not valid JSON
2

$ npx tpm session save --sessions-dir "$SDIR" ; echo $?
tpm-session-save.js: --payload <file.json> is required.
2
```

First-save-of-session (empty punchlist) also creates the sibling files and warns:

```
$ npx tpm session save --sessions-dir "$SDIR" --payload p.json
save: wrote session-0001-handoff.md for session 0001 (.../session-0001)
save: created session-0001-punchlist.md (first save of this session)
save: created session-0001-log.md (first save of this session)
⚠ punchlist has 0 open items and none were added — is that intended?
$ echo $?
0
```

## See also

- `tools/session/tpm-session-punchlist.md` — the open-work list `save` reads for "What remains".
- `tools/session/tpm-session-notes.md` — the ledger (`save` only refreshes its header).
- `tools/session/tpm-session-boot-read.md` — the read side: the next session's `open` emits this handoff.
- `claude-context/methodology/session-notes-format.md` — the canonical three-file format spec.
- `.claude/skills/tpm-session/SKILL.md` — the `save` mode body: the fixed 3-step ritual around this tool.
