Notes WRITE verbs are TOP-LEVEL session verbs (`tpm session <verb> --session <NNNN> [args]`). One canonical
`session-NNNN.json` + a derived `session-NNNN.md`; every write is atomic and the `.md` is regenerated from the JSON.
- `note (--log --status <TAG> --text "<text>" | --decision --what "<what>" --why "<why>")` — the append-only ledger.
- `punchlist --action add|close|reopen|drop|carry-in` — the work items (`add --text "…" [--slug s]`; `close/reopen/drop --item <id|slug>`; `carry-in --from <prior json> --item <id|slug>`). There is **no `list`** — read open items from the derived `.md` `## Punchlist` section or `export`.
- `import-handoff (--json-file <f> | --txt-file <f> --next "…"|--next-file <f> [--in-flight "…"]… [--must-not-redo "…"]…)` — REPLACE the handoff. Fails loud (exit `1`) if the required `next` is absent or the JSON is unreadable.
- `save` — re-persist + re-render the current record (no content args).
- `close` — the seal: **REFUSES (exit `1`, naming what's missing) unless a handoff AND at least one punchlist item are present**; otherwise stamps `meta.closedAt`.
- `import-log` / `import-punchlist` — file-based append/add.
- `tpm session export --last N | --session NNNN[,NNNN] --style json|human|both` — the notes READ API.
