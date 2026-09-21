# Session-notes format — the JSON-first session memory + a human-reading reference

**What this is.** The canonical shape of a session's memory. Each `session-NNNN/` folder holds **two
files**: ONE canonical `session-NNNN.json` (the single source of truth) and ONE derived
`session-NNNN.md` (a human-readable view with `## Handoff` / `## Punchlist` / `## Log` sections). Both
are prefixed with the four-digit session number, so no two sessions share a basename if pulled into a
shared folder. The tools under `tools/session/` OWN these formats — the orchestrator never hand-emits
them. The JSON is authoritative; the `.md` is **regenerated from the JSON on every write** and carries a
"do not hand-edit" banner. This doc is the reading reference; the shared `lib/` model
(`tools/session/lib/session-model.js` + `session-schema.js`) derives all read/migrate/validate/render
logic, and the per-tool docs (`tpm-session-ops.md`, `tpm-session-export.md`) are the verb-level SSOT.

## Why one JSON + one derived `.md` (not three markdown files)

An earlier design kept everything in three markdown files (`-handoff.md` / `-punchlist.md` / `-log.md`),
which coupled parse and render and let the files drift. The JSON-first design keeps a single canonical
record with one clean write path per part, and renders the human `.md` from it — the `.md` can never
drift from the JSON because it is never the source. The three jobs the original brief asked for still
hold, now as sections of one record:

1. **Resume-if-it-dies** → the `handoff` object (rendered as `## Handoff`; a cold resume reads it first).
2. **Decisions + rationale** → `log[]` entries of `type:"decision"` (rendered under `## Log`).
3. **Open items that are drifting** → the `punchlist[]` array (rendered as `## Punchlist`; items stay
   *candidates* for promotion to the task ledger; promotion stays manual).

## The tools that own it

| Part | Written by | Read by |
|---|---|---|
| the record (open / persist / seal) | `tpm session ops` (`open` / `save` / `close`) | `tpm session export`, `tpm session boot-read` |
| `handoff` | `tpm session ops import-handoff` (REPLACE) + `save` | export / boot-read |
| `log[]` | `tpm session ops note` (`--log` / `--decision`) + `import-log` (append-only) | export |
| `punchlist[]` | `tpm session ops punchlist --action add\|close\|reopen\|drop\|carry-in` + `import-punchlist` | export / boot-read (open headlines) |

Every write rewrites the canonical `session-NNNN.json` atomically, then regenerates the derived
`session-NNNN.md` from it. Reads never parse the `.md` back.

## Numbering + schema version

Session folders are `session-NNNN` — **four-digit**, zero-padded, sequential; the next number is
allocated by `tpm session current --open` (idempotent). The canonical record carries
`"schemaVersion": "1.0.0"` and `"kind": "session"`. The `lib/` model gates on the schema version: an
unknown-newer schema is refused by the migrate step (so a corrupt or future record is skipped, never
crashed on), and an old 3-file markdown session is converted only by the opt-in `tpm session migrate`
(see "Version gate + migration").

## The canonical record — `session-NNNN.json`

The source of truth (verified shape):

```json
{
  "schemaVersion": "1.0.0",
  "kind": "session",
  "meta": {
    "number": "0005",
    "sessionIds": ["abc-123"],
    "openedAt": "2026-09-21T01:38:50-07:00",
    "closedAt": "2026-09-21T01:39:26-07:00",
    "tpmVersion": "0.0.0"
  },
  "handoff": {
    "where": "wrapped stage C doc rewire",
    "next": "verify the docs",
    "in_flight": ["one thing"],
    "must_not_redo": [],
    "updatedAt": "2026-09-21T01:39:26-07:00"
  },
  "log": [
    { "seq": 1, "ts": "2026-09-21T01:38:50-07:00", "type": "log", "status": "DONE", "text": "did the thing" },
    { "seq": 2, "ts": "2026-09-21T01:38:50-07:00", "type": "decision", "what": "chose X", "why": "because Y" }
  ],
  "punchlist": [
    {
      "id": "5.1",
      "slug": "x0hvc0",
      "text": "open item one",
      "state": "open",
      "createdAt": "2026-09-21T01:38:50-07:00",
      "events": [ { "ts": "2026-09-21T01:38:50-07:00", "op": "add" } ]
    }
  ]
}
```

- **`meta`** — `number` (padded four-digit string), `sessionIds[]` (the real Claude Code session ids
  seen), `openedAt` (set by `ops open`), `closedAt` (stamped by `ops close`; unset while the session is
  live), `tpmVersion`.
- **`handoff`** — the pickup doc. `where` + `next` are the load-bearing pair; `in_flight[]` and
  `must_not_redo[]` are optional string arrays; `updatedAt` marks the last handoff write. `ops
  import-handoff` REPLACES this object wholesale (it will not invent a missing `next`).
- **`log[]`** — append-only, `seq`-ordered. Each entry is `type:"log"` (`status` + `text`) or
  `type:"decision"` (`what` + `why`), with an ISO-TZ `ts`.
- **`punchlist[]`** — each item has an `id` (`#<session>.<n>`), a durable base36 `slug`, `text`, a
  `state` (`open`/`closed`/dropped), `createdAt`, and an `events[]` audit trail (`add`/`close`/`reopen`/
  `drop`/`carry-in`). See `tpm-session-ops.md` for the full verb + carry-in mechanics.

## The derived view — `session-NNNN.md`

Regenerated from the JSON on every write; **do not hand-edit** (the banner says so). Verified render:

```markdown
# Session 0005 · 2026-09-21

> _Generated from `session-0005.json` — do not hand-edit; regenerated and overwritten on every save._
> _Change it via `tpm session` ops or import (`#1115`). · session 0005 · **open** · schema 1.0.0 · id abc-123 (generated from: 2f20b593efd2)_

## Handoff

**Where we are:**
wrapped stage C doc rewire

**Next:**
verify the docs

**In flight:**
- one thing

## Punchlist

**Open (1)**
1. `#7.2` item B _(0m ago)_

**Done (1)**
- ~~`#7.1` item A~~ _(closed 01:51)_

## Log
_Newest first._

2026-09-21 01:38:
🔹 DECISION — chose X
why: because Y

2026-09-21 01:38: DONE — did the thing
```

- **Header banner** carries the "generated from JSON" warning + the session number, open/closed state,
  schema version, and session id. It is a human-readable comment, not front-matter.
- **`## Handoff`** renders `where` / `next` / `in_flight`; before the first handoff write it reads
  `_No handoff yet — session opened, not yet saved._`. `must_not_redo` renders only when non-empty.
- **`## Punchlist`** splits into `**Open (N)**` (numbered) and `**Done (N)**` (struck-through, stamped
  `(closed HH:MM)`); each item shows its `#<session>.<n>` id.
- **`## Log`** reads **newest first** (note the `_Newest first._` header — the opposite of the old
  file's bottom-to-top log), decisions marked `🔹 DECISION`, log lines as `<TAG> — <text>`.

## Write disciplines, restated

- **`handoff` — REPLACE.** `ops import-handoff` rewrites the whole handoff object each time (fails loud,
  exit 1, if the required `next` is missing or the JSON is unreadable); `ops save` re-persists +
  re-renders. Pickup state can't drift because the `.md` is regenerated, never authored.
- **`log[]` — append-only.** `note --log` / `note --decision` (and `import-log`) only ever append; no
  verb rewrites a past entry. A long session reconciles the *handoff* at close, not by piling addenda
  into the log.
- **`punchlist[]` — mechanical.** `add` appends; `close`/`reopen`/`drop` flip state; `carry-in` copies a
  prior item forward. Safe to run any time, one path per verb.

## The close-guard + immutability

`ops close` is the seal. It **REFUSES (exit 1, naming what's missing) unless a handoff AND at least one
punchlist item are present**; otherwise it stamps `meta.closedAt`. The current-session pointer is closed
separately by `tpm session current --seal`, so the next bare `tpm-session` opens fresh instead of
reusing the folder. `claude-context/` is off-limits to subagent writes
(`project-workspace.md` §"Subagent write boundaries"), so a subagent never touches session memory at all.

## Version gate + migration (opt-in, no silent back-compat)

The `lib/` model reads records at `schemaVersion 1.0.0`; an unknown-newer schema is refused by the
migrate step and simply skipped (never crashed on) — this is why `boot-read` and `doctor` degrade
cleanly. Old 3-file markdown sessions are **not** read in place: `tpm session migrate --in <dir>
--out-dir <dir>` is the opt-in converter that rewrites ONE old session into the canonical JSON, and
`tpm session doctor` detects drift and suggests a migrate. `boot-read` iterates priors descending and
emits the highest readable record, ignoring anything it can't parse; if none qualify it reports the
first-session case. It always exits 0.

## Timestamps — ISO-8601 with a real timezone offset

All timestamps are local time with an explicit offset: `2026-09-21T01:38:50-07:00`. The model builds
this from local components and derives the offset from the machine's timezone — it deliberately does
**not** use `Date.toISOString()` (always UTC `Z`). On a UTC host the offset renders `+00:00`. Tools and
tests assert the *shape* (`…[+-]HH:MM`), never a literal offset.

## Length + tone

Keep the record dense and landmarked. The handoff is short by design (`where` / `next` + two optional
lists); a long session's history lives in the append-only `log[]`, and the coherent "where we are"
summary is re-snapshotted into the handoff at each save, so it never grows addenda.
