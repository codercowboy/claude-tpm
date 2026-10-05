# `tpm render` — compose a skill template against the resolved config

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Render a template whose conditional regions are driven by claude-tpm config flags. The engine is
`tools/lib/tpm-template.js` (pure, fail-safe, zero deps); this verb is its CLI.

## Usage

```
tpm render <template-file> [--explain | --list-flags | --lint]
           [--slot name=@file | name=text]... [--config <json-file>] [--project-root <dir>] [--no-banner]
tpm render --help
```

- default: print the composed text to stdout; warnings go to stderr as `render: <code> (line N): <message>`.
- `--explain`: print the kept/dropped region table and the driving flag values (instead of the text).
- `--list-flags`: list each referenced flag once with its shipped default (static; no config resolution).
- `--lint`: unbalanced `if`/`endif`, a flag absent from `defaults.json`, malformed directives (raw-aware).
- `--slot name=@file` fills `<!-- tpm:inject name -->` from a file; `--slot name=text` fills it literally.
- `--config <file>` uses a JSON file as the already-resolved config (golden tests / CI).

Exit codes: `0` ok (warnings and a degraded config still exit 0) · `1` unreadable file or lint error · `2` usage.

## Directives (frozen vocabulary)

Whole-line HTML comments; the directive line is removed from the output.

| Directive | Meaning |
|---|---|
| `<!-- tpm:if FLAG -->` / `<!-- tpm:if !FLAG -->` | open a region kept iff the dotted config flag is ON (`!` inverts); nests; no else/expressions |
| `<!-- tpm:endif -->` | close the innermost region |
| `<!-- tpm:inject NAME -->` | insert the caller-supplied slot text (never re-scanned for directives) |
| `<!-- tpm:raw -->` … `<!-- tpm:endraw -->` | lines between pass through literally |

An unresolved flag turns its region OFF (even under `!`). Any other `tpm:*` line passes through with an
`unknown-directive` warning. Warning codes: `unknown-directive`, `inline-directive`, `unresolved-flag`,
`unknown-slot`, `unterminated-raw`, `stray-endraw`, `stray-endif`, `unclosed-if`, `bad-if`, `bad-flag`,
`bad-inject`, `unknown-flag` (lint only).

## Fail-safe

If config resolution fails the engine falls back to the shipped defaults, then to an empty config, and
prefixes the output with a one-line `> WARNING: tpm degraded config …` banner. The output is never empty.
