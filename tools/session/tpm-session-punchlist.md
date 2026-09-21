# `tpm-session-punchlist.js` — the session punchlist (mini task-manager)

Maintains the current session's `session-NNNN-punchlist.md` — the open/done work list, a small
session-scoped sibling of the `tpm-task` ledger. The file is prefixed with the four-digit session number
and carries a `tpm-session-version: 1.0` preamble in its shared header. The TOOL owns the format
(session-prefixed ids, slug + timestamp tags, the `## Open`/`## Done` partition); the orchestrator
supplies only item text. The verbs are **live** — usable any time, not just at save — because they are
append/mark-only, one write path each.

Its open items are the single source of truth for open work: `tpm-session-save.js` rebuilds the
handoff's "What remains" from them, and `tpm-session-boot-read.js` emits them at the next boot.

Since #1093 the tool also reaches **across sessions**: `carry` and cross-session `close` copy a prior
session's item forward into the current punchlist, and every mutating op is written to the ledger. A
sealed prior session is an immutable snapshot — these verbs record a copy in the CURRENT session and
**never edit the source file**. The cross-session scan (`carry`/`close`/`origin`) is gated on the
`tpm-session-version: 1.0` preamble, so it ignores pre-v1.0 folders — consistent with the readers' clean
version cut (no back-compat).

Every claim below was run against a disposable sandbox tree, never the live configured sessions dir.

## Requirements / invocation shape

```
npx tpm session punchlist --sessions-dir <dir> <verb> [args] [--all]
```

- `--sessions-dir <dir>` — **required.** Resolve it via `npx tpm session config --sessions-dir`.
- Requires a session to be open — the session number is read from the current-session pointer and used
  as the id prefix. With none open, every verb is refused: `punchlist: no session is currently open —
  run \`tpm-session open\` first.` (exit 1).
- The tool always WRITES to the **current** session's `session-NNNN-punchlist.md` (created on the first
  `add`). It READS a prior session's `session-NNNN-punchlist.md` for `carry`/`close`/`origin`, but never
  writes one.
- `--help`/`-h` prints usage and exits 0.

## Refs — the slug is the key; the number is cosmetic

Every item carries two identifiers:

- **The slug** — a 6-char base36 handle minted once at `add`, never reused, and **preserved across
  carry/close/reopen** (only a fresh `add` mints a new one). This is the item's durable, operational
  identity — the key `carry`/`close`/`origin`/`reopen`/`drop` resolve on.
- **The number `#<session>.<n>`** — e.g. `#1.4` = session 1, item 4. `n` is monotonic within the session.
  This is **cosmetic display, frozen at origin**: it is NOT re-minted when an item is carried into a
  later session, so `#1.1` reads `#1.1` in every session it travels to. The session number is an integer
  (leading zeros stripped): `#20.4`, not `#020.4`.

A verb accepts **either form** as its ref token:

- a **slug** (`[0-9a-z]+`) — resolves anywhere in the corpus (for cross-session verbs, to the item's
  origin);
- a bare `<n>` — resolves in the **current** session;
- `<session>.<n>` — names the id explicitly.

`n` is 1-based: `0` (or `<s>.0`) is rejected as invalid, not reported as "no item".

## Verbs

| Verb | Effect | Exit |
|---|---|---|
| `add "<text>"` | Mints a new open item (`#<session>.<n>` + slug + created ts) and prints `punchlist: added #<id>  [<slug>]`. Empty text → refused. | 0 ok · 1 empty text |
| `note <slug\|id> "<text>"` | Appends a dated inline note to the item in the **current** session's copy — a `- note <ISO-date>: <text>` sub-bullet under it. Text is ≤300 chars, single line. Prints `punchlist: noted #<id> [<slug>].` See "Notes on an item" below. | 0 ok · 1 empty/oversize/multi-line text, unknown or non-local ref |
| `note <slug\|id> --log "<full>"` | Offloads unlimited (still single-line) detail to the ledger as a `[PLNOTE]` line under a unique note-slug, then drops a `- note <ISO-date>: see-log:session-NNNN-log.md:<note-slug>` sentinel on the item. Prints `punchlist: noted #<id> [<slug>] → full text in session-NNNN-log.md [PLNOTE <note-slug>].` | 0 ok · 1 multi-line text, unknown or non-local ref |
| `close <slug\|id>` | **Local item:** flips `[ ]`→`[x]`, moves it to `## Done`, stamps `(closed <ISO-TZ>)`. **Prior-session slug/id:** copies the item forward into the current session as a DONE copy (origin number + slug + text preserved, source untouched). Closing an already-closed item is a **no-op warning** (exit 0). Unknown ref → refused, writes nothing. | 0 ok/no-op · 1 unknown ref |
| `carry <slug\|id>` | Copies a **prior** session's item forward into the current punchlist as OPEN, preserving its origin number + slug + text (and created ts). An item already in the current punchlist → **no-op** (exit 0, nothing written). | 0 ok/no-op · 1 unknown ref |
| `origin <slug\|id>` | Prints the `session-NNNN/session-NNNN-punchlist.md` the slug first appeared in (the origin = lowest-numbered session carrying it). Read-only — does not log. | 0 ok · 1 unknown ref |
| `list [--all]` | Prints the punchlist. Default: `## Open` only. `--all` also prints `## Done`. | 0 |
| `reopen <slug\|id>` | Moves a done item back to `## Open`, restored to its **id-order slot** (not appended to the end), and clears the closed stamp. Reopening an already-open item is a no-op warning (exit 0). | 0 ok/no-op · 1 unknown ref |
| `drop <slug\|id>` | **Hard-removes** the item (the session punchlist is ephemeral-per-epic, unlike `tasks.md`). | 0 ok · 1 unknown ref |

Open items render in `(session, n)` order, so a **carried** item (a lower session number) sorts **above**
the current session's items — oldest debt first.

## Notes on an item — the communication layer

The punchlist stays a mechanical checklist: an item is only **open** or **closed**. There is no BLOCKED
(or any other) state — **a stall is a note, not a state.** `note` is the channel for everything that would
otherwise want a status: why an item slipped, what's blocking it, a decision made about it.

- **Inline** (`note <slug|id> "<text>"`) — appends a `- note <ISO-date>: <text>` sub-bullet directly under
  the item. The text is a single line, ≤300 chars; longer or multi-line text is refused (exit 1, nothing
  written) with a message pointing you at `--log`.
- **Offloaded** (`note <slug|id> --log "<full>"`) — for detail too long for an inline note. The full text
  (unlimited length, but still single-line) is written to this session's `session-NNNN-log.md` as a
  `- [PLNOTE] <full text>  [<note-slug>, <ISO-TZ>]` line under a freshly-minted **note-slug**, and the item
  gets a `- note <ISO-date>: see-log:session-NNNN-log.md:<note-slug>` **sentinel** sub-bullet pointing at
  it. The write is **log-first** (the PLNOTE line exists before the sentinel that points at it), so a
  failed log write aborts (exit 1) with nothing dropped on the punchlist. The note-slug is minted distinct
  from the item slug and from any note-slug already used by a sentinel in the current punchlist.
- **Notes attach to the CURRENT session's copy only.** `note` on an item that isn't in the current
  punchlist is refused (exit 1) — carry it forward first, then note it. This keeps the tool from reaching
  into a sealed prior session.
- **`carry` and `close` do NOT copy prior notes forward.** A carried or done-copied item arrives with a
  clean slate of notes — each session's copy of an item holds only **that session's** notes. Folding an
  item's notes across all the sessions it travelled through is the job of the `lineage` reader (a separate
  tool), which reconstructs the cross-session conversation from the per-session copies; following a
  `see-log:` sentinel is a search of the named log for its note-slug.

## The ledger — every op is recorded

Every **successful** mutating op (`add`/`close`/`carry`/`reopen`/`drop`/`note`) appends one tagged line
to the current session's `session-NNNN-log.md` `## Log`:

```
- [ADDED|CLOSED|CARRIED|REOPENED|DROPPED|NOTE] #<id> [<slug>] <text>  [<ISO-TZ>]
```

An inline `note` logs a `[NOTE]` line carrying the **item's** text (like every other op — the note's own
content lives on the punchlist item). A `note --log` additionally writes a second, distinct line — `-
[PLNOTE] <full text>  [<note-slug>, <ISO-TZ>]` — which is the offloaded detail itself, tagged with the
note-slug the item's sentinel points at.

This is a human-readable audit trail — the punchlist files stay the source of truth (the log is never
parsed back). **Refused and no-op ops do NOT log** (an unknown ref, an empty `add`, an already-closed
`close`, an already-present `carry`, a no-op `reopen`, a refused/oversize `note`). `origin` is read-only
and never logs.

Two files, no transaction: content is validated by render **before** either file is written, then the
punchlist is written, then the ledger. A rare I/O failure on the ledger append **re-throws loudly**
(exit 1) so a partial write is never silent — the honest guarantee is "validate-both-before-writing-either
+ loud error on drift," not true two-file atomicity.

## Exit codes

| Code | When |
|---|---|
| `0` | Verb succeeded, including the already-closed / already-open / already-present no-ops and any `list`/`origin`. `--help` too. |
| `1` | No session open; empty `add` text; invalid/unknown ref for `close`/`carry`/`origin`/`reopen`/`drop`/`note`; a `note` on an item not in the current session; empty, >300-char, or multi-line `note` text; a missing ref token; missing `--sessions-dir`; a ledger-write I/O failure. |

## Worked example — cross-session carry / close / origin (run against the sandbox)

A sealed `session-0001` holds two open items; `session-0002` is the current session.

```
$ npx tpm session punchlist --sessions-dir "$SDIR" add "wire the save payload lint"    # in session 0001
punchlist: added #1.1  [seujs4]
$ npx tpm session punchlist --sessions-dir "$SDIR" add "add the backend export endpoint"
punchlist: added #1.2  [2me2mr]
# ... seal 0001, open 0002 ...

$ npx tpm session punchlist --sessions-dir "$SDIR" origin 1.1
/…/sbx/session-0001/session-0001-punchlist.md

$ npx tpm session punchlist --sessions-dir "$SDIR" carry 1.1        # copy #1.1 forward as OPEN
punchlist: carried #1.1  [seujs4] forward into session 2 as open.

$ npx tpm session punchlist --sessions-dir "$SDIR" close 1.2        # prior-session id → done copy
punchlist: closed #1.2 — recorded a done copy in session 2 (source 0001 untouched).

$ npx tpm session punchlist --sessions-dir "$SDIR" list --all        # in session 0002
## Open
- [ ] #1.1 · wire the save payload lint  [seujs4, 2026-09-17T09:08:46-07:00]
## Done
- [x] #1.2 · add the backend export endpoint  [2me2mr, 2026-09-17T09:08:46-07:00] (closed 2026-09-17T09:08:48-07:00)
```

The carried `#1.1` keeps its origin number, slug, text, and created timestamp; the done copy of `#1.2`
gains a fresh `(closed <ISO-TZ>)` stamp. The item id stays **unpadded** (`#1.2`, frozen at origin) even
though the folder is `session-0001`. The `session-0001/session-0001-punchlist.md` is **byte-for-byte
unchanged** (verified by hashing it before and after both ops). Both ops appear in `session-0002`'s
`## Log`:

```
## Log
- [CARRIED] #1.1 [seujs4] wire the save payload lint  [2026-09-17T09:08:47-07:00]
- [CLOSED] #1.2 [2me2mr] add the backend export endpoint  [2026-09-17T09:08:48-07:00]
```

## Worked example — reopen restores id order

```
$ npx tpm session punchlist --sessions-dir "$SDIR" add "alpha"      # #2.1
$ npx tpm session punchlist --sessions-dir "$SDIR" add "beta"       # #2.2
$ npx tpm session punchlist --sessions-dir "$SDIR" add "gamma"      # #2.3
$ npx tpm session punchlist --sessions-dir "$SDIR" close 2          # close #2.2
punchlist: closed #2.2
$ npx tpm session punchlist --sessions-dir "$SDIR" reopen 2         # reopen #2.2
punchlist: reopened #2.2
$ npx tpm session punchlist --sessions-dir "$SDIR" list
## Open
- [ ] #2.1 · alpha  [kebjaz, …]
- [ ] #2.2 · beta  [uodz9g, …]      # back in its id-order slot, not appended to the end
- [ ] #2.3 · gamma  [teg2d7, …]
```

## Worked example — inline note + `--log` sentinel (run against the sandbox)

One open item in `session-0001`; an inline note, then a longer detail offloaded with `--log`:

```
$ npx tpm session punchlist --sessions-dir "$SDIR" add "wire the save payload lint"
punchlist: added #1.1  [okgg39]

$ npx tpm session punchlist --sessions-dir "$SDIR" note okgg39 "due Tuesday, slipped a day on the export endpoint"
punchlist: noted #1.1 [okgg39].

$ npx tpm session punchlist --sessions-dir "$SDIR" note okgg39 --log "The export endpoint stalled on the auth handshake: the CSRF token is minted per-tab but the backend expects a per-session token, so every second request 403s. ..."
punchlist: noted #1.1 [okgg39] → full text in session-0001-log.md [PLNOTE zsptpa].
```

The item now carries both notes as dated sub-bullets — the second is the sentinel pointing into the log:

```
## Open
- [ ] #1.1 · wire the save payload lint  [okgg39, 2026-09-17T11:43:59-07:00]
- note 2026-09-17: due Tuesday, slipped a day on the export endpoint
- note 2026-09-17: see-log:session-0001-log.md:zsptpa
```

…and the log holds the audit `[NOTE]` line (item text) plus the offloaded `[PLNOTE]` line under the same
note-slug (`zsptpa`) the sentinel points at:

```
## Log
- [ADDED] #1.1 [okgg39] wire the save payload lint  [2026-09-17T11:43:59-07:00]
- [NOTE] #1.1 [okgg39] wire the save payload lint  [2026-09-17T11:43:59-07:00]
- [PLNOTE] The export endpoint stalled on the auth handshake: ...  [zsptpa, 2026-09-17T11:43:59-07:00]
```

Carrying `#1.1` into `session-0002` (after sealing `0001`) forwards the item **without its notes** — the
carried copy's `## Open` block is just the item line, no `- note` sub-bullet (verified: the carried
punchlist reproduces `- [ ] #1.1 · wire the save payload lint  [okgg39, …]` and nothing else under it).

## Messages — refusals + no-ops (all run)

```
$ npx tpm session punchlist --sessions-dir "$SDIR" close            # (also reopen / drop)
punchlist: close requires an item id.                              # exit 1

$ npx tpm session punchlist --sessions-dir "$SDIR" carry            # (also origin)
punchlist: carry requires a slug.                                  # exit 1

$ npx tpm session punchlist --sessions-dir "$SDIR" close 0
punchlist: "0" is not a valid item id or slug (expected <n>, <session>.<n>, or a slug).   # exit 1

$ npx tpm session punchlist --sessions-dir "$SDIR" close 99         # unknown id in current session
punchlist: no item #2.99 in this punchlist.                        # exit 1

$ npx tpm session punchlist --sessions-dir "$SDIR" carry zzzzzz     # unknown slug
punchlist: no item with slug [zzzzzz] found in any session punchlist.   # exit 1

$ npx tpm session punchlist --sessions-dir "$SDIR" carry s3vs7y     # already in this session
punchlist: #1.1 [s3vs7y] is already in this session's punchlist — nothing to carry.   # exit 0, no write, no log

$ npx tpm session punchlist --sessions-dir "$SDIR" note okgg39      # note with no text
punchlist: note requires the note text (a non-empty string).       # exit 1

$ npx tpm session punchlist --sessions-dir "$SDIR" note okgg39 "$(printf 'x%.0s' {1..301})"   # 301 chars
punchlist: inline note is 301 chars — the cap is 300. Use `note <slug> --log "<full text>"` to offload longer detail to the log.   # exit 1, writes nothing

$ npx tpm session punchlist --sessions-dir "$SDIR" note okgg39 $'line1\nline2'   # multi-line
punchlist: "note" must be a single line — it contains a newline, which the line-oriented session format cannot store.   # exit 1, writes nothing

$ npx tpm session punchlist --sessions-dir "$SDIR" note zzzzzz "orphan"   # slug not in this session
punchlist: no item [zzzzzz] in this session's punchlist — carry it forward first (`punchlist carry <slug>`), then note it. Notes attach only to the current session's copy.   # exit 1
```

## See also

- `tools/session/tpm-session-save.md` — pulls these open items into the handoff's "What remains".
- `tools/session/tpm-session-boot-read.md` — emits these open items at the next session's boot.
- `tools/session/tpm-session-notes.md` — the ledger (Decisions + Log); the `## Log` every op is recorded to.
- `claude-context/methodology/session-notes-format.md` — the canonical three-file format spec.
- `.claude/skills/tpm-session/SKILL.md` — the `save` ritual's step 1 reconciles the punchlist.
