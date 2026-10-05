# Template engine: authoring guide

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

claude-tpm renders some skill bodies from a template plus the resolved config, so only the branches that
apply to a project reach the model. `tpm-session` is the first user: `.claude/skills/tpm-session/SKILL.md` is a
short skeleton, and the open / save / close / info procedure is composed from `tools/session/templates/<mode>.md`.
This guide covers how to write a template, how to add your own prose to a composed mode, and what to expect when
the composition does not run.

The engine is `tools/lib/tpm-template.js` (pure, zero dependencies). Its CLI is `tpm render`. The session
composer is `tpm session compose` (see `tools/session/tpm-session-compose.md`).

## The directives

A directive is a whole line holding exactly one HTML comment. The directive line is removed from the output.

| Directive | Meaning |
|---|---|
| `<!-- tpm:if FLAG -->` | Open a region. Kept only if the config flag `FLAG` is on. |
| `<!-- tpm:if !FLAG -->` | Same, inverted: kept only if the flag is off. |
| `<!-- tpm:endif -->` | Close the innermost open region. |
| `<!-- tpm:inject NAME -->` | Replace the line with the caller-supplied slot `NAME`. |
| `<!-- tpm:raw -->` ... `<!-- tpm:endraw -->` | Lines between the two fences pass through literally. |

The vocabulary is frozen. There is no `else`, no loop, no `&&` / `||`, and no comparison. For an else, write a
second region with `!`. Anything that needs real logic belongs in code, not in a template.

Rules, each checked with `tpm render`:

- `FLAG` is a dotted config path such as `tasks.enabled` or `session.notes.enabled`. A flag is on when its value
  is `true`, a non-empty string, a non-zero number, a non-empty array or a non-empty object.
- Regions nest to any depth. A nested region is kept only if every enclosing region is kept.
- A flag that does not resolve (no such key) turns its region OFF, even under `!`. A typo drops the region
  and prints an `unresolved-flag` warning on stderr.
- A `tpm:` comment that shares a line with other text is not a directive. It is emitted literally with an
  `inline-directive` warning.
- Any other `tpm:NAME` line (for example `tpm:else`) is emitted literally with an `unknown-directive` warning.
  Nothing is silently deleted.
- Injected slot text and `tpm:raw` content are never scanned for directives, so a prose file cannot smuggle in a
  `tpm:if`.

### A worked template

`demo.md`:

```
Always here.
<!-- tpm:if tasks.enabled -->
Tasks on.
<!-- tpm:if !session.notes.enabled -->
Nested: notes off.
<!-- tpm:endif -->
<!-- tpm:endif -->
<!-- tpm:if !tasks.enabled -->
Tasks off.
<!-- tpm:endif -->
<!-- tpm:inject prose -->
<!-- tpm:raw -->
<!-- tpm:if literal.flag -->
<!-- tpm:endraw -->
```

```
$ tpm render demo.md --slot prose=PROSEHERE
Always here.
Tasks on.
PROSEHERE
<!-- tpm:if literal.flag -->
```

`--explain` prints the kept and dropped regions and the flag that drove each:

```
$ tpm render demo.md --explain
1  if  2-7  KEPT  because tasks.enabled=true (flag-on)
2  if  4-6  DROPPED  because !session.notes.enabled=true (flag-off)
3  if  8-10  DROPPED  because !tasks.enabled=true (flag-off)
4  inject  11  DROPPED  because slot prose (unknown-slot)
5  raw  12-14  KEPT  because raw (filled)
flags:
  tasks.enabled = true -> ON (line 2)
  !session.notes.enabled = true -> OFF (line 4)
  !tasks.enabled = true -> OFF (line 8)
```

(The `inject` row reads DROPPED here only because the `--explain` run supplied no `--slot prose=...`.
In the `--explain` table, `!flag=true` shows the flag's value, and the trailing `ON` / `OFF` is the result after
inversion.)

`tpm render demo.md --list-flags` lists each referenced flag once with its shipped default.
`tpm render demo.md --lint` exits 1 on an unbalanced `if`/`endif`, a malformed directive, or a flag that is not in
`tools/config/defaults.json` (the flag registry). Warnings alone exit 0. Lint ignores everything inside `tpm:raw`.

## Adding your own prose: the three injection tiers

You customize a composed mode in the project's config (`.claude/claude-tpm/config.json`) or your user config
(`$CLAUDE_TPM_USER_CONFIG`), in three tiers from lightest to heaviest.

**Tier 1: `session.proseInjections` before / after.** Each entry names a mode, a file of your prose and a location:

```
tpm config set 'session.proseInjections[+]' '{"mode":"open","file":"prose/b.md","location":"before"}'
tpm config set 'session.proseInjections[+]' '{"mode":"open","file":"prose/a.md","location":"after"}'
```

With the shipped open template, `before` text lands after the first `Reading ...` line and ahead of the procedure,
and `after` text lands at the very end. Files are project-root-relative or absolute. A missing file is skipped and
listed in a trailing `tpm notes (composer)` block.

**Tier 2: a `tpm:inject prose` marker.** A template that contains `<!-- tpm:inject prose -->` receives ALL prose
entries for the mode at that marker, in config order, and `location` is ignored. The marker obeys `tpm:if` gating:
inside an OFF region the prose is dropped. The shipped templates have no `prose` marker, so this tier applies to
your own template.

**Tier 3: `session.templates.<mode>` wholesale override.** Set a path and that file replaces the shipped template
for the mode:

```
tpm config set session.templates.open custom-open.md
```

A missing override file falls back to the shipped template with a `template-override-missing` note. An override
does NOT switch off `proseInjections`; the ladder below still applies to your template.

### Precedence ladder

For one mode, the composer decides in this order:

1. If `session.templates.<mode>` names a readable file, it is the template. Otherwise the shipped one is.
2. All `proseInjections` entries for the mode build the `prose` slot, in config order.
3. If the template has a `tpm:inject prose` marker, all prose goes there and `location` is ignored.
4. Otherwise `before` entries are prepended and `after` entries appended around the rendered body.
5. `tpm:if` regions gate the template's own text. before/after prose is outside the template, so it is not gated.

Config layers combine as defaults, then project, then user. `session.proseInjections` and `session.readingList`
STACK across layers (concatenate, drop duplicates). Every other array in the config is replaced whole by the
higher layer.

### Verified ladder run

With the two entries above and no override, `tpm session compose --mode open` prints `BEFORE-PROSE` near the top
and `AFTER-PROSE` last. With `custom-open.md` set to

```
Custom top
<!-- tpm:inject prose -->
Custom bottom
```

the output is:

```
Reading "open" as → mode: open

Custom top
BEFORE-PROSE

AFTER-PROSE
Custom bottom
```

Both prose files land at the marker, in config order, and `location` no longer matters. Wrapping the marker in
`<!-- tpm:if tasks.enabled -->` and then running `tpm config set tasks.enabled false` drops only the gated prose — the template's own `Custom top` and `Custom bottom` both remain.

## `tpm session compose`

```
tpm session compose --mode <open|save|close|info|auto|alias> [free text…]
```

`--mode` takes the user's whole argument: a mode, an alias (`wrap up` reads as close, `status` as info), a
misspelling (`opn`, `clos`), or empty / `auto` for the state-aware default (not yet opened -> open, already open ->
save). `reap` prints a pointer to `/tpm-reap`; an unmatched word such as `foo` prints the mode table.

The first output line says how the argument was read, for example `Reading "wrap up" as → mode: close`.

`compose` is read-only, so running it twice is harmless, and it always exits 0. If the project config is not valid
JSON, the procedure still prints, under a banner:

```
> WARNING: tpm degraded config (could not parse <path> as JSON: …) — rendered with shipped defaults. Run `tpm doctor` to diagnose.
```

If the composer itself fails, it prints a literal emergency boot procedure instead of nothing.

## Fallback-primary: how the skill actually runs

The skeleton has two paths to the composed procedure.

- **Primary path.** The skeleton tells Claude to run `tpm session compose --mode <mode>` as an ordinary Bash tool
  call and follow the output. This runs under the user's normal permissions and is the path that works.
- **Best-effort pre-inject.** The skeleton also carries a `!`-backtick command, which Claude Code can expand
  inline when the skill loads. It is only an optimization. Do not write templates, docs or tests that depend on it.

Why the pre-inject is not primary: the `!` command expands on invocation, never at session start, and only once
(`dev/20261004-session-open-composer/skill-expansion-probe.md`, probes 1 and 2). Those probes ran with
`--dangerously-skip-permissions`. The follow-up under normal permissions found it unreliable: with no
`allowed-tools` the command is blocked at the permission check, and with `allowed-tools: Bash(sh *)` the skill
errored on load. For that reason `tpm-session` ships no `allowed-tools`, and the skeleton's primary instruction
carries the mode itself. Re-check on each Claude Code upgrade whether a reliable normal-permissions path appeared
(tracked as #1140).

When you write your own composed skill, follow the same shape: a short skeleton that tells Claude to run the
compose command, plus an optional pre-inject.
