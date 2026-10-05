# `tpm-session-compose.js`

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The composer behind the skeletonized `tpm-session` skill (#1155). `.claude/skills/tpm-session/SKILL.md`
is a short skeleton. The open / save / close / info procedure is rendered here from
`tools/session/templates/<mode>.md` and the resolved config, through the template engine
(`tools/lib/tpm-template.js`, CLI `tpm render`), so only the branches that apply to this project reach the model.
To write templates or add your own prose, see `claude-context/methodology/template-engine.md`.

## Usage

```
tpm session compose --mode <open|save|close|info|auto|alias> [free text…]
tpm session compose --help
```

- `--mode` takes the user's whole argument: a mode, an alias (`start`, `wrap`, `checkpoint`, `status`, …), a
  misspelling (`opn`, `clos`, `sav`, `stat`), or `auto`/empty for the state-aware default (not yet opened -> open,
  already open -> save). A reap-shaped word redirects to `/tpm-reap`; an unmatched or ambiguous word prints the mode table.
- Read-only. It never allocates a session (that stays the instruction `tpm session current --open`), so running
  it twice is harmless. It always exits 0 and always prints a usable procedure: an internal failure prints a
  literal emergency boot procedure, and a corrupt project config prints the procedure under a
  `degraded config` banner.
- Composer problems (missing prose file, bad entry, missing override template) are listed in a trailing
  `tpm notes (composer)` block, for example `- prose-file-missing: missing.md`. They are never fatal.

## Precedence ladder

1. `session.templates.<mode>` (a path) replaces the shipped template wholesale (missing file -> shipped + warning).
2. `session.proseInjections` entries for the mode build the `prose` slot, in config order.
3. A `<!-- tpm:inject prose -->` marker in the active template places ALL prose there (`location` ignored).
4. No marker: `location: before` entries are prepended, `after` appended around the body.
5. `<!-- tpm:if FLAG -->` regions gate the template's own text; flags resolve defaults -> project -> user.

An injected prose file is never re-scanned for directives. An override template does not switch off
`proseInjections`. `session.proseInjections` and `session.readingList` stack across config layers; other arrays
are replaced by the higher layer.

## Fallback-primary

The skill runs `tpm session compose --mode <mode>` as an ordinary Bash call; that is the primary path. The
`!`-backtick pre-inject in `SKILL.md` is best-effort, because it is unreliable under normal permissions. The
skill ships no `allowed-tools`.

## Example

```
$ tpm session compose --mode open
Reading "open" as → mode: open

## `tpm-session open` — boot the TPM engine
…

$ tpm session compose --mode "wrap up" | head -1
Reading "wrap up" as → mode: close
```

With `session.proseInjections` entries and a missing file, the output ends with:

```
tpm notes (composer):
- prose-file-missing: missing.md
```

## Tests

`tools/session/tests/session-compose.test.js`, `session-boot-survival.test.js`, `session-skeleton.test.js`.
