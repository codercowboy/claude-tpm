# Session 0021 · 2026-09-19

> _Generated from `session-0021.json` — do not hand-edit; regenerated and overwritten on every save._
> _Change it via `tpm session` ops or import (`#1115`). · session 0021 · **open** · schema 1.0.0 · id 31569169…98a3 (generated from: 0b190a7c8374)_

## Handoff

**Where we are:**
Base lib promoted; session model + converter landing in the shared sandbox.

**Next:**
Wire the converter into the export tool (P05).

**In flight:**
- P04 converter golden under review

**Must not redo:**
- Re-deriving the payload nesting — it is LOCKED to top-level siblings.
- Reading the clock inside render — now is injected.

## Punchlist

**Open (2)**
1. `#21.1` Confirm run-all stays green after the converter suite lands. _(6h ago)_
2. `#21.4` ⤴ _carried from 0020_ — Legacy migration mapping (#1114) — spec only, not built. _(6h ago)_

**Done (1)**
- ~~`#21.0` Lock the human-render format.~~ _(closed 07:40)_

## Log
_Newest first._

2026-09-19 09:14: NOTE — punchlist reconciled, handoff rewritten.

2026-09-19 08:40:
🔹 DECISION — JSON-first storage (#1112/#1113) is the foundation; per-ticket export ideas consolidated in, #1106/#1107 re-scoped to import-only.
why: one versioned canonical JSON + derived human beats duplicated export logic per ticket.

2026-09-19 08:05:
NOTE — Two separate sidecars decided:
compact current-config vs history (#1109).

2026-09-19 07:36: NOTE — Session 0021 opened; 20 prior sessions on disk.
