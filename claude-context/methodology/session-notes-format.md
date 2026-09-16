# Session-notes format — the `tpm-session` tool's contract + a human-editing reference

**What this is.** The canonical shape of `session-NNN/session-notes.md`, written by
`tools/session/tpm-session-notes.js` (task B1) and read by `tools/session/tpm-session-review.js` (task B2).
The tool OWNS this format — headings, tokens, section placement — so the orchestrator never has to
memorize or hand-emit it; this doc is the format's single source of truth (`tools/session/tpm-session-format.js` derives its parse/render logic from exactly what's below — don't hand-edit a second copy
of the token list anywhere else). Hand-edits to a note file are still supported and round-tripped
leniently (same posture as `tpm-task.js`), as long as the canonical headings/tokens stay intact.

## Why this exists

Three jobs, unchanged from the original design brief (Jason's north-star):
1. **Resume-if-it-dies** — enough state that a cold resume works.
2. **Decisions + rationale** — so they're not re-litigated later.
3. **Informal open items** — things drifting / not circled back to, captured WITHOUT inventing formal
   `tasks.md` entries. (Session-notes "open items" are *candidates* for promotion to `tasks.md` — v1
   promotion is manual, no `--from-note` assist.)

## The shape

```
# SESSION <NNN> — <date> — <theme>

## RESUME
**Where we are:** <one dense paragraph — current state, what shipped, what's in flight, what's blocked>
**Next action:** <the one next step, or "None pending.">
**In flight:** <what's running + where its output lands + what to do with it, or "Nothing in flight.">

## Open items
- [ ] OPEN(<owner>) #<id>: <text>
- [x] OPEN(<owner>) #<id>: <text>
(or the literal line "None open." when empty — this section is ALWAYS present)

## Decisions
- **Decided:** <what> — <rationale>
(or "_None yet._" when empty)

## Log
- [<STATUS>] <ISO timestamp> — <text>
(or "_Nothing logged yet._" when empty)

SEALED <date>          <- appended by `seal`, only once, at the very end
```

## The two-zone rule

- **STATE zone** (`## RESUME` + `## Open items`) — **edited IN PLACE**, always reflects NOW. When
  something progresses, the top gets UPDATED — never leave "need to do X" stranded above a later "did
  X part A." The write-API enforces this structurally: `resume` REWRITES the RESUME block; `open
  add`/`open done` mutate the open-items list in place. Neither verb has an "append a second RESUME"
  or "append a second open-items block" mode — there is exactly one of each per note.
- **LOG zone** (`## Log`) — **append-only** chronological history. This is the "what did happen"
  record, and it's valuable, not second-class: the pivots + build-and-reject trail that stops a future
  session re-walking a dead end. `log` only ever appends; there is no verb that rewrites a past log
  line. `## Decisions` is append-only too, for the same reason (a decision, once made, is a fact about
  the past, not a piece of live state to edit).

## Tokens (the SSOT — `tpm-session-format.js` regexes match these exactly)

| Token | Meaning | Owning verb |
|---|---|---|
| `## RESUME`, `## Open items`, `## Decisions`, `## Log` | canonical section headings | (structural) |
| `- [ ] OPEN(<owner>) #<id>: <text>` | an open, informal catch-all item | `open add` |
| `- [x] OPEN(<owner>) #<id>: <text>` | the same item, resolved | `open done <id>` |
| `#<id>` | a small monotonic per-note integer, never reused — stable addressing across edits | (auto-assigned) |
| `- **Decided:** <what> — <why>` | a landmarked decision, prose rationale after the em-dash | `decide … --why …` |
| `- [<STATUS>] <ISO date> — <text>` | one log entry; `<STATUS>` is free text (a closed-set convention — `DONE`/`WIP`/`BLOCKED`/`HELD`/`PARKED`/`DROPPED` — but not tool-enforced, per the resolved "verbs take free text" build answer) | `log --status <TAG> …` |
| `SEALED <date>` | write-once immutability stamp, appended at close | `seal` |

## Immutability

Your CURRENT session's note is yours — edit/reformat/organize freely via the write API for as long as
`closedAt` is unset on the current-session pointer. At `close`, `seal` stamps `SEALED <date>` and
marks the pointer closed — from then on the note is **write-once**: the write API refuses any further
change to it (or any past session's note) unless the caller passes BOTH `--edit-sealed <NNN>` AND
`--confirm`. That combination is a deliberate, rare, human-directed override (e.g. purging
proliferating misinfo) — never something a routine `save`/`log`/`decide` call does by accident. Prefer
a VISIBLE correction (a new log line noting what was wrong) over silently rewriting history; the rare
exception that truly removes a wrong claim should still leave a one-line breadcrumb saying so.

**Structurally, a subagent can never touch any of this at all** — `claude-context/` is off-limits to
subagent writes (`project-workspace.md` §"Subagent write boundaries"), full stop, independent of the
seal mechanism above.

## Legacy notes (session-001 … 007)

Those predate this tool: freeform prose, no `# SESSION NNN — …` title, no canonical headings. They are
**not retroactively reformatted** — sealed notes are write-once, and there's no reader-side cost to
supporting both shapes. `tpm-session open`'s "load latest notes" step, and `tpm-session-review.js`, both
check for `session-notes.md` first and fall back to `notes.md` — read the legacy ones as prose, not as
token-parseable data. `tpm-session-notes.js` will refuse (`ENOTCANONICAL`) if ever pointed at one of these
via `--edit-sealed`, rather than silently trying to force them into the new structure.

## Length + tone

Maintained band: **~100–450 lines**. A long session reconciles at `close` (one coherent RESUME
rewrite), not via N addenda piling up in the Log. Keep it dense + landmarked, not prose-paragraphs
end-to-end — narrative WITHIN a block is fine, the headings/tokens above are what's fixed.
