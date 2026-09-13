# `tpm-fix-git-rename-refs.js` — find & fix references to renamed/deleted files

Finds every reference to a file that was **renamed or deleted** in a batch git operation, fixes the
ones it can *prove* are safe (rewriting them to point at the new location), and loudly flags the rest
for a human. A migration aid, not a magic wand.

Its one guiding value is **"never silently corrupt a valid reference."** Every automatic edit is
either **provably correct** or **explicitly opted into via `--force`**; anything the tool cannot prove
safe is left untouched and reported, never guessed at.

**Domain-agnostic & reusable.** Nothing in the tool knows about any project. It **never calls `git`**
and **never shells out to `diff`** — its only inputs are a git-status *text file* plus a scan-root. No
project paths are baked in, and **no special meaning is given to any variable/placeholder**: a
`${FOO}` segment is opaque and therefore unresolvable/ambiguous by design.

## Install / usage

Zero runtime dependencies (Node built-ins only). Run it directly:

```
node tpm-fix-git-rename-refs.js <verb> <git-status-file> [flags]
```

- `<git-status-file>` — **required positional.** A text file containing `git status` output (the
  `renamed:` / `deleted:` lines). The tool parses this file; it does not run git. Git-quoted paths
  (spaces / non-ASCII, octal-escaped) are decoded. No-op renames (`OLD == NEW`) are dropped; malformed
  status lines become warnings on stderr, never a crash. For `apply-plan` the positional is instead a
  `<plan.json>` file.
- **`--scan-root <dir>`** — the tree to scan/fix. **Default: the current working directory.** (This is
  the one path that carries a default; all other inputs are explicit.)

The tool writes its artifacts (ledger, JSON reports) into the **current working directory**, and always
excludes its own output artifacts, `*.tmp`/`*.tmp1`/`*.tmp2` files, `.git`, and `node_modules` from the
scan.

## Verbs

| Verb | Mutates? | What it does |
|---|---|---|
| `identify` | No | Scan the tree and classify every reference to a renamed/deleted file. Prints a human ledger + summary; with `--json`, also writes the machine-readable result and the ambiguous worklist. **Always exits 0** (hits are not an error) unless `--fail-on-ambiguous` trips (exit 5). Use it to survey the blast radius before touching anything. |
| `fix` | Yes (unless `--dry`) | Rewrite the **Provable** references in place (style-preserving), each guarded by the diff-safety assertion. With `--dry`, previews only (never mutates originals). With `--force`, *also* rewrites Ambiguous refs by a blind basename swap (see Safety model). Use it to apply the safe, automatic fixes. |
| `apply-plan` | Yes (unless `--dry`) | Apply a `plan.json` of **expected-text-asserted, targeted edits** — the bridge that lets an external process (see the agent-ambiguous-resolution docs) resolve the Ambiguous residue and hand the edits back to the tool's safety rails. Each edit is pinned by line/occurrence (or exact col), optional content hash, and expected old-text. Use it after a human/agent has dispositioned the ambiguous worklist. |

There is no per-verb help; `--help` (or `-h`) anywhere prints the single usage block and exits 0.

## Flags

Verbatim from `--help`:

| Flag | Effect |
|---|---|
| `--scan-root <dir>` | tree to scan (default: current working directory) |
| `--exclude <glob>` | extra path/basename glob to exclude (**repeatable**) |
| `--only <path-prefix>` | only report/fix refs in files under this subtree (**repeatable**) |
| `--only-rename <old>` | only chase refs to this renamed/deleted file, by OLD path (**repeatable**) |
| `--dry` | preview only, never mutate originals (`fix` / `apply-plan`) |
| `--force` | also rewrite ambiguous refs by blind basename swap (`fix`) |
| `--fail-on-ambiguous` | exit non-zero if any ambiguous refs remain (`identify` / `fix`) |
| `--suppress <json>` | allowlist of disposed `itemId`s excluded from `--fail-on-ambiguous` |
| `--json` | also write machine-readable result + ambiguous worklist JSON |
| `--log <file>` | mirror stdout to a log file |
| `--help`, `-h` | show the usage message |

Notes:
- Glob syntax for `--exclude` is simple (`*`, `?`); neither crosses `/`. It is tested against both the
  scan-root-relative path and the basename.
- `--suppress` accepts a bare JSON array of ids, or an object with a `suppressed` / `items` / `disposed`
  array (of ids or `{itemId}` records). The `tpm-fix-git-rename-refs-suppress.json` that `apply-plan`
  emits is a drop-in for this flag.
- `apply-plan` honours `--dry`, `--scan-root`, `--log`, and `--json` (the scoping/gate flags apply to
  `identify`/`fix`).

## Classification categories

The scan works in **two steps**: (1) find word-boundary **basename** hits across the tree; (2) for
each hit, **resolve the reference's anchor to a path** and classify it. An anchor is `rooted` (contains
`/`, resolved against the scan-root), `relative` (`./`, `../`, resolved against the referencing file's
dir), `variable` (`${FOO}`/`$FOO` — never expanded), or `bare` (no `/`, unresolvable). A
relative/rooted path that escapes the scan-root is flagged and left unresolved.

| Category (ledger label) | Confidence | Meaning |
|---|---|---|
| **Provable — rooted** (`Safe fix (rooted)`) | Provable | A rooted ref resolved exactly onto a rename's OLD path. Rewritten to the NEW path. |
| **Provable — resolved** (`Safe fix (resolved)`) | Provable | A `./`/`../` ref resolved onto a rename's OLD path. Rewritten to a recomputed relative path (leading `./` preserved). |
| **Dir-move** (`Dir-move (path-only)`) | Provable-by-path | A resolved ref where the file moved directories but the **basename is unchanged**. Fixable by rewriting the whole path; the `fix` pass treats it as Provable. |
| **Ignored** (`Ignored (elsewhere)`) | — | A resolved ref that points at a real file which was **not** renamed/deleted. Reported, never touched. |
| **Ambiguous — unique** | Ambiguous | A bare basename whose basename matches exactly **one** rename. `--force`-able (a single candidate), but not provable. |
| **Ambiguous — collision** | Ambiguous | A bare basename matching **two or more** renames (e.g. two `config.js` in different dirs). Cannot be resolved by basename alone. |
| **Ambiguous — variable** | Ambiguous | The token contains a variable/placeholder (`${ROOT}/dup.js`) — unresolvable by design. |
| **Ambiguous — extensionless** | Ambiguous | An extensionless module specifier (`require('./foo')`, `import x from '../foo'`) whose stem matches a renamed file that *had* an extension. Detected only inside specifier strings so prose is never caught; **never auto-fixed, even under `--force`**. |
| **Deleted** (`Deleted ref`) | Unfixable | The ref resolved onto a **deleted** file — there is no new target. Reported for human action. |

The **three confidence tiers** map cleanly: **Provable** (rooted / resolved / dir-move) is what `fix`
rewrites automatically; **Ambiguous** (the four sub-buckets) is what `--force` may blind-swap or what
the `apply-plan` bridge resolves; **Unfixable** (Deleted only) is only ever reported. (An escaped-root
ref — one that resolves *outside* the scan-root — is **not** Unfixable: it's flagged `escape:true` and
classified **Ambiguous**, so `--force` / `apply-plan` can still touch it; it is simply never auto-fixed
by the provable pass.)

## Safety model (concise)

- **Confidence tiers gate mutation.** Only Provable refs are rewritten automatically. Ambiguous refs
  are touched *only* under `--force` (blind basename swap) or via `apply-plan` (expected-text-asserted).
  Unfixable refs are never written.
- **Byte-exact preservation.** Edits are exact token substitutions; nothing else in the file changes.
  Provable subs are applied **longest-OLD-path-first** so a short path can't clobber a longer one, and
  are **boundary-safe** (a match must be bounded by a non-path char / string edge), so `src/a/foo.js`
  never rewrites inside `src/a/foo.js.bak`, `foobar.js`, `foo.js~`, or a `${VAR}`-prefixed template. A
  freshly written token is never re-scanned.
- **`.tmp` snapshot + only-intended-change assertion.** Before an in-place edit the tool writes a
  pristine `<file>.tmp` snapshot (`.tmp1`/`.tmp2` under `--dry`), verifies it byte-for-byte, edits,
  then re-derives the expected text and asserts the edited file differs **only** by the known token
  swaps (any line-count change or unexplained delta = collateral/corruption). On assertion failure the
  file is **restored from the snapshot** and reported (exit 4).
- **Per-substitution `--force` exemption.** When a file has Provable subs *and* forced swaps, the strict
  assertion still guards the **Provable** regions; only the forced basename swaps pass through
  unasserted. A file with *only* forced swaps is fully exempt.
- **Temp-collision skip + cleanup-only-ours.** A pre-existing `<file>.tmp` is never claimed,
  overwritten, or deleted — the whole file is skipped. Cleanup removes only temps this run created.
- **Symlinks are never followed** — during the scan or the fix (checked with `lstat`; a symlink is
  skipped).
- **Graceful write/permission handling.** A read-only original or unwritable directory (`EACCES`/
  `EPERM`) becomes a per-file failure (`reason: eacces`) rather than a crashing stack — routed through
  the normal failure path (**exit 4** for `fix`, **exit 6** for `apply-plan`). A failed open truncates
  nothing, so the original is left byte-identical (reported `restored=true`).
- **Content-anchored `itemId`.** Each ambiguous finding gets a stable id derived from the referencing
  file + normalized token + a hash of the **surrounding content window** (±2 whitespace-normalized
  lines) — deliberately *not* the line number, so it survives unrelated line shifts. True collisions get
  a deterministic per-run ordinal. This id is the stable key for `--suppress` and for `apply-plan`.

## Exit codes

Verbatim from the tool:

| Code | Meaning |
|---|---|
| `0` | Clean run. (`identify` is 0 whether or not hits are found, unless `--fail-on-ambiguous` trips.) |
| `1` | Status/plan file unreadable, or parsed to zero rename/delete entries (empty). |
| `2` | Bad arguments / unknown verb / missing required value / missing `<git-status-file>`. |
| `4` | A `fix` file failed its safety assertion or lint (edit aborted + restored), or a temp leftover we couldn't clean. |
| `5` | The `--fail-on-ambiguous` gate tripped (ambiguous refs remain after suppression). |
| `6` | `apply-plan` had stale / not-found / failed edits (or a temp leftover). |

## `--json` output

`identify --json` writes the survey result plus a worklist:

- **`tpm-fix-git-rename-refs-result.json`** — `{ mode, statusFile, scanRoot, generated, stats, counts,
  findings[] }`. `counts` has per-bucket tallies (`rootedSafe`, `resolvedSafe`, `dirmove`, `ignored`,
  `ambiguousUnique/Collision/Variable/Extless`, `deleted`, `provable`, `ambiguous`, `total`,
  `distinctFiles`, `deadEntries`). Each finding carries `file`, `line`, `category`, and (as applicable)
  `sub`, `anchor`, `token`, `base`, `newToken`, `resolved`, `stem`, `target {old,new,kind}`,
  `candidates[]`, `escape`, and — for ambiguous findings — `itemId` (plus `dirmoveOnly` when every
  candidate is a pure dir-move).
- **`tpm-fix-git-rename-refs-ambiguous.json`** — the **ambiguous worklist**: `{ mode, generated,
  items[] }`, where `items` is exactly the ambiguous findings (with `itemId` + `candidates[]`). This is
  the hand-off to the 3rd mechanism.

`fix`, `fix --dry`, and `apply-plan --json` all emit **one shared application-report envelope**:

```jsonc
{
  "tool": "tpm-fix-git-rename-refs",
  "toolVersion": "2.0.0",
  "mode": "fix --dry",              // or "fix", "fix --force", "apply-plan", "apply-plan --dry"
  "meta":    { mode, dry, force, failOnAmbiguous, scanRoot, statusFile|planFile, timestamp, version },
  "summary": { filesModified, dry, subsApplied, filesAborted, filesSkipped, forcedCount, ambiguousRemaining, ... },
  "applied": [ /* per-edit: fix -> {file,old,new,occurrence,forced,status}; apply-plan -> {file,line,itemId,status} */ ],
  "skipped": [ /* {file, reason, ...} */ ],
  "failed":  [ /* {file, reason, line?, target?, restored?, itemId?} */ ],
  "forceChoices": [ /* fix --force: {base, chosen, alternatives[], dirmove, occurrences[]} */ ],
  "exitCode": 0
}
```

Fixed artifact filenames (always written to the current working directory):

| Verb / mode | Human artifact | JSON artifact(s) (`--json`) | Other |
|---|---|---|---|
| `identify` | `tpm-fix-git-rename-refs-ledger.txt` | `…-result.json`, `…-ambiguous.json` | — |
| `fix` / `fix --dry` / `fix --force` | stdout (+ `--log`) | `tpm-fix-git-rename-refs-fix-report.json` | `--log` also gets a companion `<log>.json` |
| `apply-plan` | stdout (+ `--log`) | `tpm-fix-git-rename-refs-apply-report.json` | on a real (non-dry) apply with ≥1 edit: `tpm-fix-git-rename-refs-suppress.json` |

## Worked examples

### 1. Identify the blast radius

```console
$ node tpm-fix-git-rename-refs.js identify status.txt --scan-root proj
================================================================================
tpm-fix-git-rename-refs — identify
================================================================================
status file : status.txt
scan root   : /…/proj
generated   : <ISO-8601 timestamp>
files scanned: 6 | binary skipped: 0 | symlinks skipped: 0 | excluded: 0

--- Findings -------------------------------------------------------------------
Safe fix (rooted):      docs/guide.md:1  (src/config.js -> src/settings.js)
Safe fix (resolved):    build.sh:1  (./src/config.js  ->  ./src/settings.js)     [anchor: relative]
Dir-move (path-only):   build.sh:2  (lib/util.js -> helpers/util.js)
Dir-move (path-only):   docs/guide.md:2  (lib/util.js -> helpers/util.js)
Ambiguous (collision):  docs/guide.md:3  (dup.js -> a/dup2.js | alt: b/dup3.js)
Ambiguous (variable):   docs/guide.md:5  (${ROOT}/dup.js — variable, unresolvable)
Deleted ref:            docs/guide.md:4  (old/gone.js — deleted, no target)
… (summary block follows) …                                        # exit 0
```

### 2. Preview, then apply the provable fixes

```console
$ node tpm-fix-git-rename-refs.js fix status.txt --scan-root proj --dry
--- Files ----------------------------------------------------------------------
would-change: build.sh  (2 substitution(s))
would-change: docs/guide.md  (2 substitution(s))
--- Summary --------------------------------------------------------------------
files would change : 2                                             # exit 0, nothing written

$ node tpm-fix-git-rename-refs.js fix status.txt --scan-root proj
changed: build.sh  (2 substitution(s))
changed: docs/guide.md  (2 substitution(s))                        # exit 0
```

Only the four Provable/dir-move refs are rewritten; the collision, the variable, and the deleted ref
are left exactly as they were.

### 3. A `--force` run (blind basename swap of an Ambiguous collision)

```console
$ node tpm-fix-git-rename-refs.js fix status.txt --scan-root proj --force
--- Force (blind basename swap) ------------------------------------------------
[--force] Ambiguous basename `dup.js` — 2 occurrence(s) in 1 file(s)
  Candidates (status-file order — first wins):
    1. a/dup.js  ->  a/dup2.js   ◀ CHOSEN
    2. b/dup.js  ->  b/dup3.js
    Applying (basename-global, NOT diff-asserted):  dup.js -> dup2.js
--- Files ----------------------------------------------------------------------
changed: build.sh  (2 substitution(s))
changed: docs/guide.md  (3 substitution(s), incl. forced)          # exit 0
```

`--force` picks the **first candidate in status-file order** and swaps the basename everywhere it
appears (including inside the `${ROOT}/dup.js` variable path — blind by design). A dir-move winner is
flagged as a NO-OP. The Provable subs in the same file stay diff-asserted; only the forced swap is
unasserted.

### 4. Apply an agent-authored plan for the Ambiguous residue

`plan.json` (one edit resolving the `dup.js` collision, keyed by the worklist `itemId`):

```json
{ "mode": "apply-plan",
  "edits": [ { "itemId": "687e509e439004bd", "file": "docs/guide.md",
               "anchor": { "line": 3, "occurrence": 1 },
               "oldText": "dup.js", "newText": "a/dup2.js" } ] }
```

```console
$ node tpm-fix-git-rename-refs.js apply-plan plan.json --scan-root proj
--- Application report ---------------------------------------------------------
applied          : 1
skipped-stale    : 0
skipped-notfound : 0
failed           : 0
  applied   docs/guide.md:3  [687e509e439004bd]
--- Suppression entries (applied itemIds) -------------------------------------
  687e509e439004bd                                                 # exit 0
# also writes tpm-fix-git-rename-refs-suppress.json
```

An edit is skipped-stale if `expectHash` no longer matches, skipped-notfound if the line/occurrence/
expected-text can't be located, or failed on symlink/temp-collision/new-target-missing/write-error —
any of which yields exit 6. Occurrence addressing is boundary-safe (a `config.js` buried inside
`myconfig.js` is never targeted); `anchor.col` is the exact-position escape hatch. The emitted
`…-suppress.json` feeds a later `--fail-on-ambiguous --suppress` gate so resolved items stop tripping
CI.

### 5. CI gate

```console
$ node tpm-fix-git-rename-refs.js identify status.txt --scan-root proj --fail-on-ambiguous
… ledger …
# stderr: --fail-on-ambiguous: 1 ambiguous reference(s) remain      # exit 5
```

Add `--suppress disposed.json` to subtract already-dispositioned `itemId`s from the count.

## Pointers / breadcrumbs

- **Design:** `tpm-fix-git-rename-refs.design.md` — the full rationale. Key sections the code cites:
  §3 confidence tiers · §5 two-step resolution model (the heart of the tool) · §6.1 dir-moves / §6.3
  variable paths · §7 style-preserving rewrite · §8 `--force` · §9 the diff-safety assertion · §10
  substitution ordering (longest-OLD-first) · §11 CLI + `--json` run report · §17.1 self-lints / §17.2
  run report / §17.4 further safety decisions (symlinks, boundary safety, byte-exact, git path-quoting)
  · §18 `apply-plan` / §18.1 the `--fail-on-ambiguous` + `--suppress` gate.
- **Tests:** `tpm-fix-git-rename-refs.test-design.md` — the coverage spec (hermetic, git-free tests of
  the exported pure helpers plus CLI integration tests for every verb, a kitchen-sink mock repo with
  pinned golden category counts, and an exit-code matrix). This is what verifies the behavior above.
- **The 3rd mechanism** (resolving the Ambiguous residue): `agent-ambiguous-resolution.design.md`. The
  tool fixes only what is provable and refuses the rest; this process uses Claude agents to disposition
  the Ambiguous worklist under the same "never silently corrupt a valid reference" value. Flow:
  `identify --json` emits the ambiguous worklist (§3 worklist contract: `itemId`, occurrence-level
  addressing, `matchedText`/`contextWindow` as data, `category`, `candidates[]`) → a resolver proposes
  RESOLVE/LEAVE/ESCALATE → an independent verifier votes → the orchestrator applies only ACCEPTED edits
  through this tool's **`apply-plan`** mode → emits a disposition report + a suppression file for the
  gate.
- **Eval:** `agent-ambiguous-resolution.eval-design.md` — the statistical (N-run) evaluation design for
  that agent process, built on a hand-labeled gold set, where false-resolution rate is the hard safety
  gate.

## Predecessor

`find-tool-rename-usages.js` (same folder) is the **superseded, identify-only predecessor**: it greps
for OLD-name references and reports full-path vs. bare-basename hits, but it has no fix/apply
capability, always exits 0, and bakes in hardcoded default paths. It is **kept, not deleted**, for
reference; use `tpm-fix-git-rename-refs.js` for all new work.
