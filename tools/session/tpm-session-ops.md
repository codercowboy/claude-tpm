# `tpm-session-ops.js` — session ops + import (#1115)

The node-invokable session **ops** + **#1115 import** tool for `kind:"session"` records (P06). It
operates off the canonical JSON and, on every write, regenerates the derived human `.md` via the
converter (`now` bound in a closure). Composes `lib/session-model.js` + `lib/session-converter.js` —
re-implements none of the model/converter/IO primitives.

Format authorities (cross-referenced, not restated here): [`../json-format-spec.md`](../json-format-spec.md)
(the JSON envelope + editable-vs-mechanical table) and [`../export-spec.md`](../export-spec.md) (the human
render). Overview + file map: [`README.md`](README.md). Export tool: [`tpm-session-export.md`](tpm-session-export.md).

**Run (Q5 — no bin, no npm-run):**
```
node session-tooling/tpm-session-ops.js <verb> [flags]
```
Programmatic callers `require('./tpm-session-ops')` for `opOpen / opSave / opNote / opPunchlist /
opClose / opImportHandoff / opImportLog / opImportPunchlist` (each returns the persisted record).

## Common flags
| Flag | Meaning |
|------|---------|
| `--sessions-dir <dir>` | directory of `session-<NNNN>.json` (a SCRATCH or real dir; created for `open`). **Required.** |
| `--session <NNNN>` | session number (aka `--number`). |
| `--now <iso>` | reference time for punchlist age (default: now, local offset). |

Each write: canonical JSON is written **atomically first**, then the derived `session-<NNNN>.md` is
regenerated **only after** the JSON write succeeds.

## Ops
| Verb | Flags | Effect |
|------|-------|--------|
| `open` | `--session-id <id>` `[--tpm-version v]` `[--prior-session-path <json>]` | mint a fresh session; a prior session's still-open punchlist items carry forward (same slug, new id, `{op:"carry-in", fromSession:<prior number>}`). |
| `save` | — | re-persist current session (re-stamp `handoff.updatedAt`, regenerate `.md`). |
| `note` | `--log --status NOTE --text "…"` \| `--decision --what "…" --why "…"` | append ONE log entry (append-only, monotonic seq). |
| `punchlist` | `--action add\|close\|reopen\|drop\|carry-in` | `add`: `--text "…" [--slug s]`; `close/reopen/drop`: `--item <id\|slug>`; `carry-in`: `--from <prior json> --item <id\|slug>`. |
| `close` | — | **CLOSE-GUARD (#1115):** REFUSES unless a handoff **AND** a punchlist are both present (names what's missing); else stamps `meta.closedAt`. |

## Import (#1115) — honors the LOCKED editable table (mechanical fields ignored; state never set by import)
| Verb | Flags | Semantics |
|------|-------|-----------|
| `import-handoff` | `--json-file <f>` \| `--txt-file <f> (--next "…" \| --next-file <f>) [--in-flight "…"]… [--must-not-redo "…"]…` | **REPLACE.** JSON = a handoff object OR a full session record (`.handoff` extracted). Text = raw file → `where`; `next` supplied via flag/file (replace-semantics cannot invent the required `next` → fails loud if absent). |
| `import-log` | `--txt-file <f> [--status NOTE \| --decision --why "…"]` | **APPEND-ONLY.** File contents become one log entry's body; existing entries never rewritten; monotonic seq preserved. Removes the thin-log friction (multi-line body, no shell-escaping). |
| `import-punchlist` | `--file <f>` | **ADD/merge.** File = a JSON array (strings or `{text}`), or one item per non-empty text line. Each becomes a new **open** item; state is never set by import. |

The loosened all-or-none rule (#1115 D): partial file-driven writes are allowed by design, but each
write's canonical JSON is still atomic.

## Examples
```
node session-tooling/tpm-session-ops.js open --sessions-dir /tmp/s --session 0021 \
    --session-id abc --tpm-version 1.0.0 --prior-session-path /tmp/s/session-0020.json
node session-tooling/tpm-session-ops.js import-handoff --sessions-dir /tmp/s --session 0021 \
    --txt-file where.txt --next "wire the router"
node session-tooling/tpm-session-ops.js import-log --sessions-dir /tmp/s --session 0021 --txt-file entry.txt
node session-tooling/tpm-session-ops.js punchlist --sessions-dir /tmp/s --session 0021 --action add --text "do X"
node session-tooling/tpm-session-ops.js close --sessions-dir /tmp/s --session 0021
```

Tests: `session-tooling/tests/session-ops.test.js` (auto-discovered by `tests/run-all.js`).
