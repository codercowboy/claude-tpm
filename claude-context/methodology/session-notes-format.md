# Session-notes format — the three-file session memory + a human-editing reference

**What this is.** The canonical shape of a session's memory, which is split across **three files** in
each `session-NNNN/` folder — `session-NNNN-handoff.md`, `session-NNNN-punchlist.md`, and
`session-NNNN-log.md` (the ledger). Every file is **prefixed with the four-digit session number** (so no
two session files share a basename if pulled into a shared folder) and opens with a
`tpm-session-version: 1.0` preamble in its shared header. The tools under `tools/session/` OWN these
formats — headings, tokens, ids, timestamps, the shared header — so the orchestrator never has to
memorize or hand-emit them; this doc is their single source of truth
(`tools/session/tpm-session-format.js` derives all parse/render logic from exactly what's below — don't
hand-edit a second copy of the token list anywhere else). Hand-edits to any of the three files are still
round-tripped leniently, as long as the canonical headings/tokens (including the version preamble) stay
intact.

**Numbering + version gate (no back-compat).** Session folders are `session-NNNN` — **four-digit**,
zero-padded, sequential. The tools read **only** files carrying the `tpm-session-version: 1.0` preamble:
a pre-v1.0 session (three-digit, unprefixed, or unversioned) is **invisible** — never parsed, never
migrated, never "pointed at." There is deliberately **no back-compat** and **no `metadata.json`** (the
version lives in the header preamble; the number and openedAt/closedAt live in the
`.current-session.json` pointer, so a per-folder metadata file would be redundant). Accepted consequence:
a workspace's existing pre-v1.0 sessions drop out of the tools' view; the first v1.0 session is
`session-0020` onward. See the "Version gate + legacy sessions" section below.

## Why three files (not one note with sections)

The old design kept everything in one single-file note with `## RESUME` / `## Open items` /
`## Decisions` / `## Log` sections. That coupled three things with different write disciplines and let
the pickup state (RESUME) and the open-work list drift out of sync with the log. The redesign splits
them by role, each with one clean write path (`NNNN` = the four-digit session number):

| File | Role | Write discipline | Owning tool |
|---|---|---|---|
| `session-NNNN-handoff.md` | The **pickup doc**: where we are, next action, what NOT to redo | **rewritten wholesale** each `save` | `tpm-session-save.js` |
| `session-NNNN-punchlist.md` | The **open/done work list** (a mini task-manager) | mechanical in-place edits; numbered items | `tpm-session-punchlist.js` |
| `session-NNNN-log.md` | The **ledger**: Decisions + Log (renamed from the former `session-notes.md`) | append-only (Log newest-last; read bottom-to-top) | `tpm-session-notes.js` |

The three jobs the original design brief (Jason's north-star) asked for still hold — they just live in
their own files now:

1. **Resume-if-it-dies** → `session-NNNN-handoff.md` (a cold resume reads this first, in full).
2. **Decisions + rationale** → the `## Decisions` block in `session-NNNN-log.md`.
3. **Open items that are drifting** → `session-NNNN-punchlist.md` (still *candidates* for promotion to
   `tasks.md`; promotion stays manual).

`RESUME` is retired as a notes section — it became the head of `session-NNNN-handoff.md`, always current
because the handoff is rewritten on every save. `## Open items` is retired too — it became
`session-NNNN-punchlist.md`.

## The shared wayfinding header (top of ALL three files)

Every one of the three files opens with the same tool-generated **comment-block header** (an HTML
comment + a blockquote), so a Claude that opens ANY one file immediately knows where the other two live
and what each is for (verified output for session `0001`):

```markdown
<!-- tpm-session: 0001 · 2026-09-17 · tpm-session-version: 1.0 · files: session-0001-handoff.md, session-0001-punchlist.md, session-0001-log.md -->
> **Session 0001 memory — three files in this folder.  THIS FILE: handoff.**
> • **session-0001-handoff.md** — READ FIRST: where we are, next action, what NOT to redo.
> • **session-0001-punchlist.md** — open/done work items (numbered).
> • **session-0001-log.md** — append-only ledger: Decisions + Log (log reads **bottom-to-top**).
```

- It is a **human-readable comment block, not YAML front-matter** — it reads cleanly when a human opens
  the file.
- The anchor line carries **`tpm-session-version: 1.0`** — the version sentinel every reader gates on
  (`boot-read`/`review`/`notes`/`punchlist`/`save` read ONLY files that carry it; anything else is
  ignored). It also lists the three prefixed `files:` in the folder.
- The only per-file difference is the `THIS FILE: <handoff|punchlist|log>.` token (the ledger's token is
  now `log`).
- The `<!-- tpm-session: NNNN … -->` line is the stable anchor. `save` **refreshes** the header on all
  three files surgically — it find-and-replaces only the anchored block, so an append-only ledger body
  stays byte-stable underneath.

## `session-NNNN-handoff.md` — the pickup doc

Rewritten wholesale on every `save` from the payload plus the current punchlist. Shape (verified output):

```markdown
<wayfinding header>

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

- `## Where we are / Next / In flight` is the structured "orient me" head (the old RESUME). `In flight`
  defaults to `Nothing in flight.` when the payload omits it.
- `## What remains` is **populated mechanically** from `session-NNNN-punchlist.md`'s open items — the
  handoff never re-types open work by hand. Each line is a punchlist Open line minus the checkbox.
- `## MUST NOT redo` is load-bearing (borrowed from the workflow HANDOFF convention). It is **omitted
  entirely** when the payload carries no `must_not_redo`.

## `session-NNNN-punchlist.md` — the mini task-manager

A small, session-scoped sibling of the `tpm-task` ledger. The TOOL owns the format and the mechanics;
the orchestrator supplies only item text. Shape (verified output):

```markdown
<wayfinding header>

# Punchlist — session 0001 — 2026-09-17

## Open
- [ ] #1.1 · Add the backend export endpoint  [79qdq4, 2026-09-17T09:00:21-07:00]

## Done
_Nothing done yet._
```

- **Session-prefixed ids — `#<session>.<n>`.** `#1.1` = session 1, item 1. `n` is monotonic within the
  session. The prefix survives carry-forward/aggregation, so `1.4` and `2.4` never collide mechanically.
  The session number in an id is an integer (leading zeros stripped): `#20.4`, not `#0020.4`, even though
  the folder and the title line show the padded four-digit `0020`.
- **Trailing machine tag — `[<slug>, <created>]`.** `slug` is a 6-char base36 handle (a stable,
  effectively unique id that survives a renumber); `created` is an ISO-8601 timestamp **with timezone**
  offset, e.g. `2026-09-17T09:00:21-07:00`.
- **`close` flips `[ ]`→`[x]`**, moves the item to `## Done`, and stamps `(closed <ISO-TZ>)`.
- Empty sections render the literal placeholders `_No open items._` / `_Nothing done yet._`.
- **The slug is the durable key; the number is cosmetic, frozen at origin (#1093).** The slug is minted
  once at `add` and preserved across `carry`/`close`/`reopen`; the `#<session>.<n>` number is never
  re-minted, so an item reads the same `#1.1` in every session it travels to. `close`/`carry`/`origin`/
  `reopen`/`drop` accept a slug, a bare `<n>` (current session), or `<session>.<n>`.
- **Cross-session provenance is recorded in the CURRENT session, never by editing a sealed source
  (#1093).** `carry <slug>` copies a prior item forward as OPEN; a prior-session `close <slug>` writes a
  DONE copy forward — both preserve the origin number + slug + text and leave the source file
  byte-unchanged. Items render in `(session, n)` order, so carried (older) items sort first. Full verb
  reference: `tools/session/tpm-session-punchlist.md`.
- **Item notes are the communication layer — a stall is a note, not a state (#1095).** An item stays only
  **open** or **closed**; there is deliberately **no BLOCKED (or any other) status** — that design was
  considered and cut. Anything you'd want a status for (why it slipped, what's blocking it, a decision
  about it) is a **note**: a dated sub-bullet under the item, `- note <ISO-date>: <text>`, single line,
  ≤300 chars. Longer detail is offloaded with `punchlist note --log`, which writes the full text to the
  ledger as a `[PLNOTE]` line under a unique **note-slug** and drops a **sentinel** sub-bullet on the item —
  `- note <ISO-date>: see-log:session-NNNN-log.md:<note-slug>` — a file-precise pointer into that log.
  Notes attach only to the CURRENT session's copy; **`carry`/`close` do NOT copy prior notes forward**, so
  each session's copy holds only its own notes and an item's lineage folds across its copies. Example:

  ```markdown
  ## Open
  - [ ] #1.1 · wire the save payload lint  [okgg39, 2026-09-17T11:43:59-07:00]
  - note 2026-09-17: due Tuesday, slipped a day on the export endpoint
  - note 2026-09-17: see-log:session-0001-log.md:zsptpa
  ```

## `session-NNNN-log.md` — the ledger (Decisions + Log)

Append-only. This is the file formerly named `session-notes.md`; the ledger's `THIS FILE` token and the
`save`/`refreshOrCreate` label are now `log`. Shape (verified output):

```markdown
<wayfinding header>

# SESSION 0001 — 2026-09-17 — Wire up CSV export

## Decisions
- **Decided:** Use the existing exportCsv() helper — avoids duplicating CSV escaping logic  [2026-09-17T09:01:00-07:00]

## Log
- [DONE] Wired the toolbar button to exportCsv()  [2026-09-17T09:01:00-07:00]

SEALED 2026-09-17          <- appended by `seal`, only once, at the very end
```

- **RESUME and Open-items are gone from this file** — no dupes with handoff/punchlist.
- Both **Log and Decisions carry a trailing `[<ISO-TZ>]` timestamp** (same shape as the punchlist tags),
  which enables future time-bounded search of the ledger. The timestamp is **trailing** — the log line
  is `- [<TAG>] <text>  [<ISO-TZ>]`, NOT the old inline `- [TAG] <ISO> — <text>`.
- Empty sections render `_None yet._` (Decisions) / `_Nothing logged yet._` (Log).
- The Log reads **bottom-to-top**: newest entry last.
- **The `## Log` is also the punchlist's audit trail (#1093).** Every successful punchlist op appends one
  line here — `- [ADDED|CLOSED|CARRIED|REOPENED|DROPPED|NOTE] #<id> [<slug>] <text>  [<ISO-TZ>]` — written
  by `tpm-session-punchlist.js` via `tpm-session-notes.js`'s `appendLogEntry`. It is a **human-readable
  trail, not a source of truth**: the punchlist files remain authoritative and the log is never parsed
  back. Refused / no-op punchlist ops (unknown ref, empty `add`, already-closed `close`, already-present
  `carry`, no-op `reopen`, a refused/oversize `note`) append **nothing**; `origin` is read-only and never
  logs.
- **`[PLNOTE]` — offloaded item-note detail (#1095).** `punchlist note --log` writes a second, distinct
  ledger line: `- [PLNOTE] <full text>  [<note-slug>, <ISO-TZ>]`. Unlike every other log line, its trailing
  tag leads with the **note-slug** (then the timestamp) — the same slug the item's `see-log:` sentinel
  points at, so following the sentinel is a search of this log for that note-slug. The full text is
  unlimited length but still single-line. This line round-trips through the same `LOG_ENTRY_RE` as any
  other log entry (the `<TAG>` is free text; the trailing `[…]` captures the composite `note-slug, ISO-TZ`).

## Tokens (the SSOT — `tpm-session-format.js` regexes match these exactly)

| Token | File | Meaning | Owning verb |
|---|---|---|---|
| `<!-- tpm-session: NNNN · <date> · tpm-session-version: 1.0 · files: … -->` | all three | wayfinding-header anchor line + version sentinel | generated / refreshed by every writer + `save` |
| `# HANDOFF — session NNNN — <date>` | handoff | handoff title | `save` |
| `## Where we are / Next / In flight` + `**Where we are:**` / `**Next action:**` / `**In flight:**` | handoff | the pickup head | `save` (from payload) |
| `## What remains` + `- #<session>.<n> · <text>  [<slug>, <created>]` | handoff | open work, pulled from punchlist | `save` (mechanical) |
| `## MUST NOT redo` + `- <text>` | handoff | do-not-redo list (omitted when empty) | `save` (from payload) |
| `## Open` / `## Done` | punchlist | the two work-item zones | (structural) |
| `- [ ] #<session>.<n> · <text>  [<slug>, <created>]` | punchlist | an open item | `punchlist add` |
| `- [x] #<session>.<n> · <text>  [<slug>, <created>] (closed <ISO-TZ>)` | punchlist | a closed item | `punchlist close` |
| `- note <ISO-date>: <text>` | punchlist | an item note (inline detail, or a `see-log:session-NNNN-log.md:<note-slug>` sentinel) attached to the preceding item | `punchlist note` |
| `# SESSION NNNN — <date> — <theme>` | log | the ledger title | `notes init` (or lazy first write) |
| `## Decisions` + `- **Decided:** <what> — <why>  [<ISO-TZ>]` | log | a landmarked decision | `notes decide … --why …` |
| `## Log` + `- [<TAG>] <text>  [<ISO-TZ>]` | log | one log entry; `<TAG>` is free text | `notes log --status <TAG> …` |
| `- [PLNOTE] <full text>  [<note-slug>, <ISO-TZ>]` | log | offloaded item-note detail; the trailing tag leads with the note-slug the item's `see-log:` sentinel points at | `punchlist note --log` |
| `SEALED <date>` | log | write-once immutability stamp | `notes seal` |

`<TAG>` is free text — the suggested set (`DONE`/`WIP`/`BLOCKED`/`HELD`/`PARKED`/`DROPPED`) is a
convention the tool does not enforce (any bracketed tag round-trips).

## Timestamps — ISO-8601 with a real timezone offset

All timestamps are local time with an explicit offset: `2026-09-16T20:13:48-07:00`. The format helper
builds this from local components and derives the offset from the machine's timezone — it deliberately
does **not** use `Date.toISOString()`, which is always UTC `Z`. On a UTC host the offset renders
`+00:00`. Tools and tests assert the *shape* (`…[+-]HH:MM`), never a literal offset.

## Write disciplines, restated

- **`session-NNNN-handoff.md` — rewritten wholesale each `save`.** There is exactly one write path (the
  gated `save`, §the save tool), so pickup state can't drift. Its "What remains" is always rebuilt from
  the live punchlist, never hand-authored.
- **`session-NNNN-punchlist.md` — mechanical in-place edits.** `add` appends; `close`/`reopen`/`drop`
  mark or remove. Append/mark-only, one path per verb — safe to run any time, not just at save.
- **`session-NNNN-log.md` — append-only.** `log` and `decide` only ever append; there is no verb that
  rewrites a past log line or decision. A decision or a log entry is a fact about the past, not live
  state to edit. A long session reconciles the *handoff* at close (one coherent rewrite), not by piling
  addenda into the Log.

## Immutability

Your CURRENT session's files are yours — edit them via the write tools for as long as the current-session
pointer's `closedAt` is unset. At `close`, `seal` stamps `SEALED <date>` on `session-NNNN-log.md` and
marks the pointer closed; from then on the write API refuses any change to that (or any past) session's
notes unless the caller passes BOTH `--edit-sealed <NNNN>` AND `--confirm` — a deliberate, rare,
human-directed override (e.g. purging proliferating misinfo), never something a routine
`save`/`log`/`decide` does by accident. `--edit-sealed` takes a **four-digit** session number. Prefer a
VISIBLE correction (a new log line noting what was wrong) over silently rewriting history.

**Structurally, a subagent can never touch any of this at all** — `claude-context/` is off-limits to
subagent writes (`project-workspace.md` §"Subagent write boundaries"), independent of the seal mechanism.

## Version gate + legacy sessions (no back-compat)

The tools read **only** files carrying the `tpm-session-version: 1.0` preamble in their wayfinding
header. There is **no back-compat** and **no `metadata.json`** — a clean version cut:

- **Pre-v1.0 sessions are invisible, not migrated.** Sessions written before this cut (single-file
  `session-notes.md` with the old `## RESUME` / `## Open items` sections, freeform prose, three-digit
  folders, or any folder lacking the `1.0` preamble) are **never parsed, never point-at-path'd, never
  flagged.** The readers simply skip them.
- `tpm-session-boot-read.js` iterates priors descending and emits the highest that reads as v1.0,
  **ignoring** any pre-v1.0 folder; if none qualify it reports "first session." (The old point-at-path
  tier was removed.) It never crashes boot.
- `tpm-session-review.js` lists **only** v1.0 sessions; a window with no v1.0 session prints
  `No sessions found.` (The old `(legacy format — not token-parseable)` render was removed, and the
  `--json` output no longer carries a `legacy` field.)
- `tpm-session-current.js` allocation still **counts** three-digit folders for continuity (so numbering
  does not restart) — e.g. a workspace whose newest folder is `session-019` allocates `0020` next — but
  allocation is a folder count, not a version gate; the invisibility is a READER concern.

Accepted consequence: a workspace's existing pre-v1.0 sessions drop out of the tools' view; the first
v1.0 session is `session-0020` onward.

## Length + tone

Keep each file dense and landmarked, not prose end-to-end. The `session-NNNN-handoff.md` is short by design (four
fields + the mechanical open list). A long session's history lives in the append-only Log; the coherent
"where we are" summary is re-snapshotted into the handoff at each save, so it never grows addenda.
