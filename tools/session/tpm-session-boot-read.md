# `tpm-session-boot-read.js` — the boot-time pickup emitter

Emits the PRIOR session's state to stdout so `tpm-session open` pulls it into context via a **tool call**,
not by the model choosing which file to read. `modes-open.md` step 4 calls it. It is side-effect-free
(reads only) and **ALWAYS exits 0** — it can never crash boot, even on an internal error (a last-resort
try/catch still exits 0).

Every claim below was run against a disposable sandbox tree, never the live configured sessions dir.

## Requirements / invocation shape

```
npx tpm session boot-read [--sessions-dir <dir>]
```

- `--sessions-dir <dir>` — **optional.** When given, it is used directly (tests, explicit callers). When
  omitted, boot-read self-resolves the dir via the session config (the same value
  `npx tpm session config --sessions-dir` prints).
- `--help`/`-h` prints usage and exits 0.

## Which session it emits

It emits the **highest-numbered PRIOR** `session-NNNN` folder **that reads as v1.0** — a folder whose
`session-NNNN-handoff.md` carries the `tpm-session-version: 1.0` preamble. It reads the current-session
pointer and **excludes** the just-opened current session, so — run after `open`'s `current --open` step —
it never emits the empty session you just opened. It then iterates the priors **descending** and picks
the first that reads as v1.0, **skipping (ignoring) any pre-v1.0 or handoff-less folder** rather than
pointing at it. If no prior reads as v1.0 → a clean "first session" message.

Numbering is four digits (`session-0021`); folders are prefixed with the session number
(`session-0021-handoff.md` / `-punchlist.md` / `-log.md`).

## The open-punchlist block — headlines only, plus one `lineage` pointer

The `--- OPEN PUNCHLIST (<count>) ---` block surfaces only the prior session's **headline open items** —
each item's one-line entry (`#<id> · <text>  [<slug>, <created>]`), **including items carried in** that
session. It deliberately shows **NO item notes**: neither an inline `- note …` sub-bullet nor a `see-log:`
sentinel appears at boot. Boot stays a terse index; detail is fetched on demand.

When there is at least one open item, boot-read appends exactly ONE pointer line, using a **real slug from
the list** as the example:

```
for more detail: npx tpm session punchlist lineage <slug>
```

The `lineage` reader it points at is a **separate tool** — the pointer is a standing invitation to fold an
item's cross-session notes, not a command boot-read runs. When the prior has **0 open items**, the pointer
line is **omitted** (there is nothing to point at).

## The version read-gate (no back-compat)

boot-read reads **only** files carrying the `tpm-session-version: 1.0` preamble. There is **no**
back-compat and **no** `metadata.json`: a pre-v1.0 session (three-digit, unprefixed, or unversioned) is
simply **invisible** — it is never parsed, never crashed on, and never "pointed at." The old
point-at-path tier for an unrecognized prior has been **removed**. Consequence (accepted): a workspace's
existing pre-v1.0 sessions do not show up at boot; the first v1.0 session is `session-0020` onward.

## Degradation tiers (it never hard-fails)

| Prior session | Behavior |
|---|---|
| **v1.0 format** (`session-NNNN-handoff.md` present and reads as v1.0) | RICH emit: the `== PRIOR SESSION NNNN · <folder>/ ==` banner, a `files:` line (all three prefixed absolute paths + `(log reads bottom-to-top)`), `--- HANDOFF (read fully) ---` + the handoff **verbatim**, `--- OPEN PUNCHLIST (<count>) ---` + each open item's headline (or `(no open punchlist items)`), and — when there is ≥1 open item — ONE `for more detail: …` pointer line (see below). |
| **Pre-v1.0 / unversioned / handoff-less** | IGNORED. boot-read skips it and continues down the priors; it does not point at it or parse it. |
| **No v1.0 prior** (fresh project, or every prior is pre-v1.0) | `boot-read: no prior session found under <dir> — this looks like the first session. Nothing to pick up.` |

Every tier exits 0.

## Worked example — rich emit (run against the sandbox)

Session 0001 was saved (handoff + one open punchlist item) and sealed; session 0002 was then opened.
`boot-read` emits the prior (0001), not the current (0002):

```
$ npx tpm session boot-read --sessions-dir "$SDIR"
== PRIOR SESSION 0001 · .../session-0001/ ==
files: .../session-0001/session-0001-handoff.md · .../session-0001/session-0001-punchlist.md · .../session-0001/session-0001-log.md   (log reads bottom-to-top)
--- HANDOFF (read fully) ---
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
--- OPEN PUNCHLIST (1) ---
#1.1 · Add the backend export endpoint  [79qdq4, 2026-09-17T09:00:21-07:00]
for more detail: npx tpm session punchlist lineage 79qdq4
$ echo $?
0
```

The `for more detail:` pointer uses a **real** slug from the list above (`79qdq4`), and the block carries
no note text even when the item has inline or `see-log:` notes on it — verified against a sandbox where
`#1.1` carried both an inline note and a `see-log:` sentinel: neither appeared in the emit. With **0** open
items the `--- OPEN PUNCHLIST (0) ---` block reads `(no open punchlist items)` and the pointer line is
absent (also verified).

## Worked example — empty / ignored-prior (verified)

An empty sessions dir, or one whose only prior is pre-v1.0, both report "first session" — boot-read never
points at a pre-v1.0 folder:

```
$ npx tpm session boot-read --sessions-dir "$EMPTY_DIR"
boot-read: no prior session found under .../empty — this looks like the first session. Nothing to pick up.
$ echo $?
0

# the only prior is a pre-v1.0 session-019 (a bare session-notes.md, no version preamble):
$ npx tpm session boot-read --sessions-dir "$OLD_DIR"
boot-read: no prior session found under .../old — this looks like the first session. Nothing to pick up.
$ echo $?
0
```

A mix picks the highest v1.0 prior and skips a higher pre-v1.0 one. With a v1.0 `session-0021` and a
higher pre-v1.0 `session-0022`, boot-read emits `0021` (verified — the banner reads
`== PRIOR SESSION 0021 · .../session-0021/ ==`, and `0022` never appears).

## See also

- `tools/session/tpm-session-save.md` — writes the `session-NNNN-handoff.md` this tool emits verbatim.
- `tools/session/tpm-session-punchlist.md` — its open items are the "OPEN PUNCHLIST" block.
- `tools/session/tpm-session-review.md` — the on-demand "look back over the last N sessions" read tool.
- `claude-context/methodology/session-notes-format.md` — the canonical three-file format + version gate.
- `.claude/skills/tpm-session/modes-open.md` — step 4 calls this tool at boot.
