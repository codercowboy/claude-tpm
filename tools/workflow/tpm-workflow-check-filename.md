# check-filename.js

Blocked-filename guard for subagent-authored files.

**Canonical location:** `tools/check-filename.js` (documented from `dev/workflow-module-build/01-foundational-tools/tools/check-filename.js`).

## Purpose

Subagents are forbidden from naming a deliverable with a blocked word
(`report` / `summary` / `analysis` / `findings`) — the pattern is server-side blocked and a
recurring failure mode this project guards against in tooling too. This tool flags a filename
whose **basename** (case-insensitive) contains any blocked pattern as a plain substring.

It is both a CLI and a `require()`-able module.

## Usage

```
node check-filename.js <filename> [--patterns a,b,c] [--config <path>] [--help]
```

`<filename>` is a required positional argument. Only the **basename** is inspected — directory
segments in the path are ignored (so `some/findings-dir/plan.md` passes: only `plan.md` is checked).

## Flags

| Flag | Effect |
|---|---|
| `<filename>` (positional) | Required. The filename or path to check. Basename only. |
| `--patterns a,b,c` | Comma-separated pattern list. When given, **replaces** the pattern list entirely — built-in defaults and any `--config` value are both ignored. Substring, case-insensitive. |
| `--config <path>` | Read `workflow.blockedFilenamePatterns` from a claude-tpm `config.json` and use that array as the pattern list (replacing the defaults). A missing / unreadable / malformed config, or one with no `workflow.blockedFilenamePatterns`, silently falls back to the built-in defaults (never an error). |
| `--help`, `-h` | Print usage and exit 0. |

### Precedence

`--patterns` > `--config` > built-in defaults. If both `--patterns` and `--config` are supplied,
`--patterns` wins and the config is ignored. If neither supplies a usable list, the built-in
defaults apply.

**Default patterns:** `report`, `summary`, `analysis`, `findings`.

## Exit codes

| Exit | Meaning | Stream |
|---|---|---|
| `0` | Basename matches no blocked pattern (prints an `OK:` line), or `--help`. | stdout |
| `1` | Basename contains a blocked pattern (prints a `BLOCKED:` line naming the matched pattern), or the required `<filename>` argument is missing (prints an error + usage). | stderr |

## Reusable API

The file is also a module (`require('./check-filename.js')`):

- `isBlockedFilename(filename, patterns) -> { blocked, pattern, basename }` — `patterns` defaults to `DEFAULT_PATTERNS`.
- `loadPatternsFromConfig(configPath) -> string[] | null` — `null` signals "fall back to defaults"; never throws.
- `DEFAULT_PATTERNS -> string[]` — `['report', 'summary', 'analysis', 'findings']`.

## Worked example

Verified run (Node v24.16.0), invoked from `dev/workflow-module-build/18-shipdocs-foundational-v2/`
with the canonical tool at `../01-foundational-tools/tools/check-filename.js`:

```console
$ node check-filename.js my-findings.md
BLOCKED: "my-findings.md" contains blocked pattern "findings". Rename it (avoid: report, summary, analysis, findings).
$ echo $?
1

$ node check-filename.js plan.md
OK: "plan.md" does not match any blocked pattern.
$ echo $?
0
```

More verified behavior:

```console
# --patterns replaces the defaults entirely (a normally-blocked name now passes):
$ node check-filename.js my-findings.md --patterns notes
OK: "my-findings.md" does not match any blocked pattern.          # exit 0

# ...and blocks its own list:
$ node check-filename.js notes.md --patterns notes,scratch
BLOCKED: "notes.md" contains blocked pattern "notes". Rename it (avoid: notes, scratch).   # exit 1

# --patterns wins when --config is also present:
$ node check-filename.js wip-notes.md --config custom.json --patterns notes
BLOCKED: "wip-notes.md" contains blocked pattern "notes". Rename it (avoid: notes).   # exit 1

# case-insensitive:
$ node check-filename.js MySummaryDoc.md
BLOCKED: "MySummaryDoc.md" contains blocked pattern "summary". ...   # exit 1

# only the basename is inspected (a "findings" directory does not trip it):
$ node check-filename.js some/findings-dir/plan.md
OK: "plan.md" does not match any blocked pattern.                 # exit 0

# missing/unreadable/malformed --config silently falls back to defaults (no crash):
$ node check-filename.js my-findings.md --config does-not-exist.json
BLOCKED: "my-findings.md" contains blocked pattern "findings". ...   # exit 1
```

Where `custom.json` is `{ "workflow": { "blockedFilenamePatterns": ["draft", "wip"] } }`:

```console
$ node check-filename.js draft-doc.md --config custom.json
BLOCKED: "draft-doc.md" contains blocked pattern "draft". Rename it (avoid: draft, wip).   # exit 1

$ node check-filename.js my-findings.md --config custom.json
OK: "my-findings.md" does not match any blocked pattern.          # exit 0 (defaults replaced)
```
