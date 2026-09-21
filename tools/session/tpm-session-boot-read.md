# `tpm-session-boot-read.js`

The boot-time pickup emitter, reworked for the JSON-first note format (#1123 Stage C). A
**pure-read** verb whose stdout **is** the boot pickup payload — `session open` (the `tpm-session`
skill's boot ritual) runs it so prior state enters context via a tool call, not by the model
choosing to open a file.

## What it emits

For the **highest-numbered PRIOR session** (never the just-opened current one):

- the prior session's **HANDOFF** (where / next / in flight / must-not-redo), rendered from the
  canonical `session-NNNN.json` via `lib/session-model.loadSession`;
- the still-**OPEN** punchlist items, HEADLINES ONLY (`#id · text  [slug]`) — done/dropped items omitted;
- the file locations of the canonical `session-NNNN.json` + derived `session-NNNN.md`;
- a pointer to the derived `.md` and to `tpm session export … --style human` for the full log + detail.

## Format (the rework)

The notes are now **ONE canonical `session-NNNN.json`** plus **ONE derived `session-NNNN.md`**
(with `## Handoff` / `## Punchlist` / `## Log` sections), nested under
`<sessionsDir>/session-NNNN/`. The OLD boot-read parsed the retired three-file `.md` layout
(`-handoff.md` / `-punchlist.md` / `-log.md`); this version reads the canonical JSON through the
session model (`read → migrate → validate`) instead — no dependence on the old markdown parser or its
v1.0 sentinel. The migrate step **refuses an unknown-NEWER `schemaVersion`**, so a session written by
a newer tool is skipped (never mis-read), not crashed on.

## Contract — never crashes boot

Exits **0 in ALL cases**: no prior session, an unreadable dir, or a corrupt / unknown-newer / partial
prior JSON (that folder is skipped). Side-effect-free (reads only). Any failure degrades to a clean
one-line message + exit 0.

## Sessions dir

`--sessions-dir <dir>` if given (used by tests + explicit callers). Otherwise resolved from the
session config — the same value `npx tpm session config --sessions-dir` prints — best-effort; a
resolution failure degrades to a clean message + exit 0.

## CLI

```
npx tpm session boot-read [--sessions-dir <dir>]
npx tpm session boot-read --help
```

### Example

```
$ npx tpm session boot-read --sessions-dir .claude/claude-tpm/sessions
== PRIOR SESSION 0022 · …/session-0022/ ==
files: …/session-0022.json · …/session-0022.md   (canonical JSON + derived .md; the log reads newest-first)
--- HANDOFF (read fully) ---
**Where we are:**
…
**Next:**
…
--- OPEN PUNCHLIST (2) ---
#22.3 · wire the export pointer  [a1b2c3]
#22.4 · rerun both suites  [d4e5f6]
for full detail: read …/session-0022.md (## Punchlist / ## Log), or run: npx tpm session export …
```
