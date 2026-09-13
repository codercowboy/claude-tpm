# `tpm-fix-git-rename-refs` — design spec

> **Status:** design (pre-build). This is the genesis document for the tool's permanent reference doc;
> it will graduate into `tpm-fix-git-rename-refs.md` once the tool is built and settled. Sections
> marked **PROPOSED** are recommendations awaiting Jason's sign-off (e.g. parts of §17); the §14
> decisions (A–F) are resolved.
>
> **Companion tool (already built + independently verified):**
> `find-tool-rename-usages.js` (this folder) — the identify-only predecessor. This tool **supersedes**
> it (its `identify` mode is a superset) but reuses its verified rename-map parsing + matching logic.

---

## 1. Purpose

When a batch of files is renamed or deleted (captured in a `git status` snapshot), every other file
that *referenced* an old path or name is now stale or broken. This tool **finds** those references
and **fixes** the safe ones — updating each reference to point at the new location — while refusing to
touch the ones it can't prove are safe, and loudly flagging what a human must resolve.

It is a **migration aid**, not a magic wand: its guiding value is **"never silently corrupt a valid
reference."** Every automatic edit is either provably correct or explicitly opted into via `--force`.

**Domain-agnostic & reusable.** Nothing in the tool knows about any particular project. It takes a
git-status file plus a scan-root and works for anyone doing a batch rename/delete who wants references
updated automatically as far as is provably safe. It hardcodes **no** project paths and gives **no**
special meaning to any project-specific placeholder (e.g. a `${TPM_HOME}`-style variable is just an
opaque, unexpandable part of a path — see §5/§6.3). The claude-tpm rename batch is merely its first
use case, not a dependency.

---

## 2. Scope & non-goals

**In scope**
- Parse a git-status text file for `renamed: OLD -> NEW` and `deleted: OLD` entries.
- Scan a project tree for references to the OLD names/paths.
- Classify each reference by how confidently it can be fixed.
- Rewrite the safe references (default) and, opt-in, the ambiguous ones (`--force`).
- A no-mutation preview (`--dry`).

**Non-goals**
- **The tool never calls `git`.** `git` is intentionally blocked in this environment; the tool's only
  input is the status *text file*. (This also makes it testable without a repo.)
- It does not rename files (git already did that) — it only fixes *references*.
- It does not resolve symbol-level references (variables holding a path, dynamically built paths).
- It is not a general codemod engine; it is scoped to path/filename references from a rename/delete set.

---

## 3. Safety philosophy — three confidence tiers

Every candidate reference falls into one of three tiers, and each tier has a different automatic
posture:

| Tier | Meaning | Default `fix` | `fix --force` |
|---|---|---|---|
| **Provable** | We resolved the reference and it lands exactly on a renamed OLD path | **rewritten** (strict diff-asserted) | rewritten |
| **Ambiguous** | A bare name match we could not resolve to a specific file | left alone, flagged | rewritten (best-effort, NOT diff-asserted) |
| **Unfixable** | Reference to a *deleted* file (no target), or a rename we can't express | left alone, flagged | left alone, flagged |

The whole design turns on maximizing the **Provable** tier (via resolution, §5) so the Ambiguous pile
— which on the first pass was ~2500 of ~2660 raw hits — shrinks to only the genuinely undecidable.

---

## 4. Input: the git-status file

- Positional argument, required: `<git-status-file>` (e.g. `git-status.txt`).
- Parsed lines:
  - `renamed:    OLD/PATH -> NEW/PATH` → a rename pair `{old, new}`.
  - `deleted:    OLD/PATH` → a delete `{old}` (no target).
- **No-op guard:** drop any rename where `OLD == NEW`.
- Paths are root-relative POSIX paths exactly as git prints them (relative to the repo root git ran
  in, which the caller passes as `--scan-root`).
- Derived indexes built once:
  - `byOldPath`: `OLD/PATH → {new?}` (rename or delete).
  - `byBasename`: `basename → [entries]` — used for collision detection and `--force`.
    - `len === 1` → **unique basename**.
    - `len > 1` → **colliding basename** (e.g. `config.js` renamed in both `tools/session/` and
      `tools/task/`).

---

## 5. The resolution model (two-step matching — the heart of the tool)

Naive matching (search for the OLD root-relative path) misses references written **relative to the
file they live in**. So matching is two steps:

### Step 1 — find candidate hits
For every entry, scan the tree for occurrences of the OLD **basename** (e.g. `foo.js`). This is the
broad net; it over-matches on purpose.

### Step 2 — resolve each hit to decide what it really points at
For each hit, read the surrounding **reference token** (the path-like string the basename sits in),
determine its **anchor**, and resolve it to a scan-root-relative path `P`:

| Anchor style | Example token | Resolves via |
|---|---|---|
| **Rooted** | `tools/session/foo.js` | relative to the scan-root |
| **Relative-to-file** | `../../../tools/session/foo.js`, `./foo.js` | relative to the referencing file's dir |
| **Variable / templated** | `${FOO}/tools/foo.js`, `$FOO/...` | **can't expand → unresolvable → Ambiguous** (§6.3) |
| **Extensionless** (JS) | `require('./lib/config')`, `from '../foo'` | resolvable, but **always Ambiguous** (see ‡) | 
| **Bare / prose** | `` `foo.js` ``, "see foo.js" | *no anchor* → unresolvable |

Then classify by what `P` is:

- **`P` equals a renamed entry's OLD path** → **Provable match.** Rewrite the reference *in its own
  style* (see §7) to point at the NEW path.
- **`P` equals a *deleted* entry's OLD path** → **Unfixable (deleted ref).** Flag; no target exists.
- **`P` resolves to a real file that was NOT renamed/deleted** → **Ignored.** This is the precision
  win: a `config.js` that genuinely points elsewhere stops being noise.
- **No anchor / unresolvable** → **Ambiguous.** Candidate for `--force` only.
- **Token contains an unexpandable variable** (`${FOO}`, `$FOO`, any `${...}`/`$NAME`) → **Ambiguous.**
  We never guess what a variable expands to, so the concrete file is unknowable. (Still `--force`-eligible
  as a plain basename swap — the variable prefix is irrelevant to a basename-global replace.)
- **‡ Extensionless module specifier** (`require`/`import` without `.js`, matched *only* inside
  module-specifier strings so prose isn't caught) → **Ambiguous, always.** Never auto-fixed — **not
  even under `--force`** — this pass; reported for the future 3rd mechanism (§15). (Decision A.)

> **Why this matters:** resolution is what turns "2500 scary basename hits" into a small, honest
> Ambiguous set plus a large Provable set plus a large Ignored set.

---

## 6. Reference anchors & the hard cases

1. **Directory-move renames where the basename is unchanged.** Several entries move a file to a new
   directory without changing its name, e.g.
   `tools/workflow/audit.js -> tools/workflow/tests/tpm-workflow-audit-cost/tools/audit.js`.
   Consequences:
   - A global basename swap does **nothing** (name unchanged) — so `--force` **cannot** fix these.
   - A bare `audit.js` is *doubly* ambiguous.
   - They are fixable **only** through a resolvable rooted/relative reference (recompute the whole
     path). → tracked as a distinct **Dir-move** sub-category so they never *look* fixed when they're
     not.
2. **Extensionless JS references** (`require('./lib/config')`). The `.js` is absent, so a `foo.js`
   search misses them. → **DECIDED (A):** detect them **only inside require/import module-specifier
   strings** (match the path *stem*), and **report them as Ambiguous — never auto-fix, not even under
   `--force`**, this pass. Restricting to specifier contexts keeps the word out of prose matches. They
   belong to the future 3rd mechanism (§15).
3. **Paths containing variables/placeholders are unresolvable — by design.** A reference like
   `${FOO}/tools/foo.js` or `$FOO/tools/foo.js` (any `${...}` / `$NAME` segment) cannot be resolved to
   a concrete file without knowing the variable's value, which the tool refuses to guess. The tool is
   **domain-agnostic**: it gives no special meaning to any particular variable name (no `${TPM_HOME}`
   special case, no environment lookup). So such a reference is classified **Ambiguous** and skipped
   for provable auto-fix. It remains `--force`-eligible only as a blind basename swap (the variable
   prefix plays no part in a basename-global replace). *Rationale:* baking in one project's placeholder
   would make the tool project-specific and could mis-resolve someone else's identically-named variable.
4. **Same basename, multiple renames (collision).** `byBasename[name].length > 1`. Provable matches
   are still fine (path disambiguates). Only *bare* occurrences are ambiguous, and `--force` must pick
   deterministically and disclose alternatives (§8).

---

## 7. Rewriting a provable reference (style-preserving)

A fix must preserve the *form* the author wrote, only redirecting the target:

- **Rooted** `tools/session/foo.js` → `tools/session/foo-bar.js` (or the new dir for a dir-move).
- **Relative-to-file** `../../../tools/session/foo.js` → recompute
  `path.relative(dirname(referencingFile), NEW_ABS)` (preserving a leading `./`). This correctly
  handles dir-moves in relative refs, where the `../` prefix itself changes.
- **Variable/templated & extensionless** → not rewritten in the provable pass (Ambiguous, §5/§6).

The general rule: **compute the NEW reference as the same-anchored path to the NEW location.**

---

## 8. `--force` (opt-in, best-effort)

`--force` additionally rewrites **Ambiguous** references by **global basename substitution**
(`foo.js → foo-bar.js`), accepting that unrelated same-named files may be changed. The user's stated
acceptance: *"oh well — it's up to me to fix any bad ones, which is easy in a visual git differ."*
(Extensionless refs are excluded even here — §5 ‡.)

**The pick rule — dead simple (Decision B):** when a basename maps to more than one status entry, the
**first occurrence in the status file wins, end of story.** No "longest match", no heuristics — a flat
convention a human can reason about at a glance ("that's why `audit.js` went to X and not the later
Y"). We always print **every** candidate *and its full `OLD -> NEW` status line* so the choice is
auditable.

- **Unique basename:** clean global swap; logged as forced.
- **Colliding basename (both change name):**
  ```
  [--force] Ambiguous basename `config.js` — 5 occurrences in 3 files
    Candidates (status-file order — first wins):
      1. tools/session/lib/config.js  ->  tools/session/tpm-session-config.js   ◀ CHOSEN
      2. tools/task/lib/config.js     ->  tools/task/lib/tpm-task-config.js
    Applying (basename-global, NOT diff-asserted):  config.js -> tpm-session-config.js
    Rewritten at:
      tools/README.md:66
      docs/consuming-claude-tpm.md:41
      ...
  ```
- **Colliding basename where the winner is a DIR-MOVE (basename unchanged):** `--force` cannot help —
  a basename-global swap is a no-op. We say so and leave the refs for manual/path-resolved fixing:
  ```
  [--force] Ambiguous basename `audit.js` — 3 occurrences in 2 files
    Candidates (status-file order — first wins):
      1. tools/workflow/audit.js  ->  tools/workflow/tests/tpm-workflow-audit-cost/tools/audit.js  ◀ CHOSEN
         ⚠ basename unchanged (directory move) — a basename-global swap is a NO-OP
      2. tools/workflow/tests/audit-cost/tools/audit.js  ->  tools/workflow/tpm-workflow-audit.js
    Result: NO textual fix applied (chosen candidate's basename did not change).
            These references need a resolvable path or a manual fix:
      tools/README.md:66
      tools/session/notes.md:12
  ```
- **Decision C (refined to PER-SUBSTITUTION exemption):** forced edits are applied and logged but are
  **exempt from the strict diff-assertion** of §9 — that exemption is the entire meaning of `--force`.
  The exemption is **per-substitution, not per-file.** When a file receives BOTH a forced (ambiguous /
  basename) swap AND one or more PROVABLE rewrites, the strict only-intended-change / untouched-context
  / line-count checks **still validate the provable substitutions**; only the forced-basename changes
  are allowed through unasserted. (Implementation: `assertProvableExemptForced` reproduces the writer's
  exact pipeline — provable subs, then forced basename swaps — and requires per-line byte-equality, so a
  forced change always reproduces while any unexplained delta on a provable-touched or untouched line is
  caught.) A file with **only** forced subs has nothing provable to protect and stays fully exempt, as
  before. This closes the hole where any single forced sub previously exempted the WHOLE file, letting a
  corrupted provable rewrite slip through.

---

## 9. The fix mechanism & the diff-safety assertion

Applied **one file at a time**. The `.tmp` snapshot is the safety net.

**Temp-file collision rule (never clobber, never delete, someone else's file).** A `.tmp` on disk may
be a legitimate file another process/person left there — the tool must treat any temp file it did not
itself create as untouchable:
- **Before processing a file,** if its temp name(s) already exist (`<file>.tmp` for normal;
  `<file>.tmp1` / `<file>.tmp2` for `--dry`), **skip that file entirely** with a clear message
  (`skipped: <file>.tmp already exists — refusing to overwrite a pre-existing file`) and change
  nothing. The original is not edited when we can't safely take our snapshot.
- **We create only temp files that did not already exist,** and we **record the exact set this run
  created.** Cleanup deletes **only** files in that created-set — never any other `.tmp*` it happens to
  find. A stray `jb.tmp` sitting in the tree is left alone and is **not** reported as an error.

**Normal `fix`:**
1. Copy `<file>` → `<file>.tmp` (pristine snapshot).
2. Apply all **Provable** substitutions to the **original**.
3. **Diff original vs `.tmp` in Node** (no external `diff`, no `git`). Assert every changed line
   differs *only* by a known OLD→NEW substitution (full path, relative path, or placeholder path). Any
   other delta ⇒ **abort this file**: restore from `.tmp`, mark it failed, and the run exits non-zero.
4. On success, remove `.tmp`.

**`fix --dry` (test-first posture):**
1. Copy `<file>` → `<file>.tmp1` **and** `<file>.tmp2` (both pristine).
2. Apply substitutions to `.tmp1` only.
3. Diff `.tmp1` vs `.tmp2`; print what *would* change; run the same assertion.
4. After **all** files, remove every `.tmp1`/`.tmp2`. **The original is never touched.**

`--force` composes with both; forced changes are shown/applied but skip the strict assertion (§8). The
skip is **per-substitution**: in a file that also has PROVABLE rewrites, those provable subs are still
asserted; only the forced-basename changes are exempt (Decision C, refined).

**Write / permission errors → graceful per-file abort (not a crash).** Both the `.tmp` snapshot write
and the in-place original write are wrapped in try/catch. If either fails (e.g. a read-only original or
an unwritable containing directory on a flaky file share), the file is converted to a per-file failure
routed through the same exit-4 path (`{status:'failed', reason:'eacces'|'write-error', restored:true}`):
the original is left byte-identical (a failed open-for-write truncates nothing), any temp we created is
cleaned, that one file is reported as failed, and the batch continues to the others — ending non-zero
(exit 4) rather than crashing the whole run with a raw uncaught EACCES stack. **`apply-plan` mirrors this
same hardening** on its snapshot / `--dry` preview / in-place write paths, routed through its own failure
exit code (**6**) with a per-edit `{reason:'eacces'|'write-error', restored:true}` record (§18).

---

## 10. Substitution rules (correctness details)

- **Two orderings, kept distinct (don't conflate them):**
  - *Collision pick* — which rename a bare basename becomes under `--force` — is **first-in-status-file**,
    end of story (§8). Simple and human-auditable.
  - *Substitution application order within a file* is **longest OLD path first**, so a shorter path
    that is a prefix of a longer one doesn't clobber it. Orthogonal to the collision pick.
- **No re-matching a freshly written token** (`foo.js → foo-bar.js` must not then match another rule
  looking for `foo-bar.js` or re-trigger on the substring).
- **Word-boundary basename matching** so `config.js` never bites `config-resolver.js` /
  `myconfig.js` / `config.json` (this boundary logic is inherited from the verified predecessor).
- **Idempotency:** re-running after a successful fix is a no-op on already-fixed references (a
  post-condition worth asserting in tests).

---

## 11. CLI

```
tpm-fix-git-rename-refs.js identify <git-status-file> [scoping] [output]
tpm-fix-git-rename-refs.js fix      <git-status-file> [--dry] [--force] [--fail-on-ambiguous] [scoping] [output]
tpm-fix-git-rename-refs.js --help

  scoping:  [--scan-root <dir>] [--exclude <glob> ...] [--only <path-prefix> ...] [--only-rename <old-path> ...]
  output:   [--json] [--log <file>]
```

- `--only <path-prefix>` (repeatable): only touch references in files under these subtree(s).
- `--only-rename <old-path>` (repeatable): only chase references to these renamed file(s); pass the
  flag once per file, e.g. `--only-rename path/a.js --only-rename path/b.js --only-rename path/c.js`.
- `--fail-on-ambiguous`: exit non-zero if any Ambiguous references remain (CI gate).
- `--json`: machine-readable result for **every verb** (Decision K). `identify` → the result + an
  `…-ambiguous.json` worklist. `fix` / `fix --dry` → a run report: metadata (mode, flags, scan-root,
  status file, timestamp, version), summary (files modified — or *would-change* in `--dry* — subs
  applied, files aborted with reason [assertion / new-target-missing / snapshot-mismatch], files skipped
  [temp-collision], forced count), per-edit detail (each applied edit `file`+`old→new`+occurrence; each
  failure+reason; each `--force` collision choice + alternatives), and the exit code echoed. In `--dry`
  the JSON *is* the change-plan preview. It shares the same dialect as the `apply-plan` application
  report, so `fix`, `fix --dry`, and `apply-plan` all emit consistent JSON.
- `--log <file>`: mirror stdout.

- `<git-status-file>`: required positional.
- `--scan-root <dir>`: default = current working directory (`.`) — the tree to scan/fix. No
  project-specific path is baked in.
- **Scan exclusions:** `.git/`, `node_modules/`, the passed `<git-status-file>`, this tool's own output
  files (ledger/log), and any `*.tmp` / `*.tmp1` / `*.tmp2`. Add more with a repeatable
  `--exclude <glob>`. Binary files skipped via null-byte detection.
- **Exit codes (shipped):** `0` clean (hits are not an error; `identify` always 0); `1` status file
  unreadable/empty; `2` bad args / unknown verb or flag; `4` a `fix` file failed its only-intended
  assertion / new-target lint / write(EACCES) error (aborted + restored); `5` `--fail-on-ambiguous`
  gate tripped; `6` `apply-plan` had a stale / not-found / failed edit.

---

## 12. Output — the ledger

`identify` prints one line per finding, grouped by category, then a summary. Same ledger written to
`tpm-fix-git-rename-refs-ledger.txt`. Categories:

```
Safe fix (rooted):     <file>:<line>  (tools/x/foo.js -> tools/x/foo-bar.js)
Safe fix (resolved):   <file>:<line>  (../../foo.js  ->  ../../foo-bar.js)     [anchor: relative]
Dir-move (path-only):  <file>:<line>  (tools/w/audit.js -> tools/w/tests/.../audit.js)
Ignored (elsewhere):   <file>:<line>  (config.js resolves to tools/other/config.js — not renamed)
Ambiguous (unique):    <file>:<line>  (foo.js -> foo-bar.js)          [forceable]
Ambiguous (collision): <file>:<line>  (config.js -> tpm-session-config.js | alt: tpm-task-config.js)
Ambiguous (extless):   <file>:<line>  (require('./lib/config') — stem 'config', never auto-fixed)
Deleted ref:           <file>:<line>  (tools/x/gone.js — deleted, no target)
```

Summary counts per category + distinct-file counts. `fix`/`fix --dry` add a per-file change summary
and a final tally (files changed / would-change, substitutions applied, files failed).

---

## 13. Known limitations

- Only path/filename references; not symbolic or dynamically-assembled paths.
- Extensionless matching is heuristic (require/import contexts) — see decision A.
- `--force` colliding-basename choice may be wrong by design; the loud output + git diff is the
  backstop.
- Dir-move renames with unchanged basenames are only auto-fixable when a reference resolves; bare
  mentions of them are unfixable here (they belong to the future 3rd mechanism, §15).

---

## 14. Decisions (resolved 2026-09-12)

- **A. Extensionless JS refs — DECIDED: detect but never auto-fix.** Found only inside require/import
  module-specifier strings (stem match); reported as **Ambiguous**; not fixed even under `--force` this
  pass. Deferred to the future 3rd mechanism (§15).
- **B. `--force` collision pick — DECIDED: first-in-status-file wins, end of story.** No heuristics.
  Always print every candidate *with its full `OLD -> NEW` status line* (§8) so the choice is auditable.
- **C. Forced edits exempt from the strict diff-assertion — DECIDED: yes.** That exemption is the whole
  meaning of `--force`; the resolvable Provable set keeps the strict assertion.
- **D. Fate of the predecessor `find-tool-rename-usages.js` — DECIDED: keep as-is, do not delete.**
  This tool supersedes its identify function.
- **E. Domain-agnostic & reusable — DECIDED.** No project-specific knowledge or paths. `--scan-root`
  defaults to the current directory. Paths containing variables/placeholders (`${TPM_HOME}`, `${FOO}`,
  `$FOO`, any `${...}`/`$NAME`) are **not** expanded — they are Ambiguous and skipped for provable fix
  (force-eligible only as a blind basename swap). No environment lookups, no baked-in variable names.
- **F. Temp-file safety — DECIDED.** Never overwrite a pre-existing temp (skip that file); cleanup
  deletes only temps this run created; stray/pre-existing `.tmp*` are left alone and not flagged.
- **G. Symlinks — DECIDED: never followed, no override flag.** The scanner does not descend symlinked
  directories or fix through symlinked files; skipped symlinks are reported. (§17.4)
- **H. Post-run undo — DECIDED: not built.** git is the backstop; no `--keep-backups`. (§17.4)
- **K. `--json` on every verb — DECIDED (2026-09-12).** `fix` and `fix --dry` emit a run report (not
  just `identify`); shared JSON dialect with the `apply-plan` application report. See §11.
- **v1 hardening — DECIDED:** full-path boundary/terminator safety, byte-exact preservation
  (line-endings / final newline / BOM), and git path-quoting in the parser (§17.4). `--fail-on-ambiguous`
  added; `--only` and `--only-rename` both added and **repeatable** (scriptable multi-value).

---

## 15. Future: the 3rd mechanism (for the genuinely Ambiguous)

The Ambiguous and unfixable-Dir-move leftovers want a human-in-the-loop pass — e.g. an interactive
review that shows each ambiguous hit with its candidate targets and asks per-hit, or emits a
patch/worklist for a visual differ. Out of scope here; this tool's job is to shrink that pile to only
what truly needs judgment.

---

## 16. Implementation notes / conventions

- Node.js, **zero runtime dependencies** (Node builtins only), `#!/usr/bin/env node`, `--help`,
  `module.exports` of the pure helpers for unit testing — per claude-tpm `tool-conventions.md`.
- No `git`, no external `diff` — the diff/compare is implemented in Node.
- Reuse the verified rename-map parser + PATH/basename matcher from `find-tool-rename-usages.js`.
- **Testing (git-unavailable):** test `identify` and `fix --dry` against the real tree (read-only to
  originals); test real mutating `fix` — including the abort-and-restore path — only against a
  throwaway fixture tree; unit-test the helpers (map parse incl. `deleted` + no-op guard;
  anchor resolution; classification; the only-intended-change assertion). Unit tests that would need
  `git` are run together with Jason.

---

## 17. Built-in safety assertions & run report (PROPOSED — under discussion)

Two families: **self-checks** that make a mutating run trustworthy, and an **end-of-run report** that
tells the human exactly what happened. Everything here is proposed; we're refining the list together.

### 17.1 Safety assertions / lints the script runs on itself

*Backup & restore integrity (matters here — the file share is flaky):*
- **Temp-file collision → skip, never clobber:** if a file's temp name already exists on disk, skip
  that file with a clear message and touch nothing (§9). We never overwrite a temp we didn't create.
- **Snapshot verified before edit:** after writing `<file>.tmp`, assert it is byte-identical to the
  original (size + content hash). If the backup didn't take, **do not edit the original** — abort.
- **Write / permission errors → graceful per-file exit-4 abort (not a crash):** the `.tmp` snapshot
  write and the in-place original write are wrapped in try/catch. A read-only original or an unwritable
  containing directory (common on the flaky file share) no longer throws an uncaught EACCES. It is
  converted to a per-file failure (`{status:'failed', reason:'eacces'|'write-error', restored:true}`)
  routed through the existing exit-4 path: the original is left byte-identical (a failed open-for-write
  truncates nothing), any temp we created is cleaned, that one unwritable file is reported as failed
  (with its `reason` echoed into the run report's `failed[]`), and the batch continues to the others,
  ending non-zero rather than crashing. **`apply-plan` applies the identical hardening** on its
  snapshot / `--dry` preview / in-place write paths, converting the same failure to a per-edit
  `failed[]` record (`{reason:'eacces'|'write-error', restored:true}`) routed through its own failure
  exit code **6** (§18) — so no apply-plan write path can throw a raw uncaught EACCES either.
- **Restore verified on abort:** after restoring from `.tmp`, re-read and assert original == snapshot.
- **Cleanup deletes only what we created:** the tool tracks the exact set of temp files it created this
  run and, at the end, removes **only** those. It **never deletes** a `.tmp*` it did not create, and
  does **not** report pre-existing/stray temp files as errors. If deleting one of *our own* temps fails
  (e.g. sandbox blocked it), that specific leftover is listed explicitly rather than pretended gone.

*Edit correctness (the Provable set):*
- **Only-intended-change** (§9): every changed line differs solely by a known OLD→NEW token.
- **Line-count invariant:** a reference rewrite must not add/remove lines — assert equal line count.
- **Untouched-context invariant:** on each changed line, the bytes *outside* the matched token are
  byte-identical before/after (no accidental collateral within a "good" line).
- **New target exists:** the NEW path we rewrite *to* must actually exist under the scan-root. Rewriting
  to a nonexistent file means a bad map or a bad computation → warn/abort. (Strong lint.)
- **Escape guard:** a relative reference that resolves *outside* the scan-root is flagged, not fixed.
- **No re-match / idempotency:** a second pass makes zero Provable changes (post-condition self-check:
  re-scan after fix, assert zero remain).

*Determinism:*
- **Dry/real parity:** compute the change plan once; assert `--dry` output == what a real `fix` would do.
- **Stable collision pick:** the first-in-file winner is identical across runs.

### 17.2 End-of-run report (stats)

Header: mode (`identify` / `fix` / `fix --dry` / `fix --force`), status file, scan-root, timestamp.

- **Corpus:** files scanned; skipped (binary / excluded); total occurrences found.
- **By category:** Provable (rooted / resolved-relative), Dir-move, Ignored-elsewhere,
  Ambiguous (unique / collision / variable / extensionless), Deleted-ref.
- **Actions:** occurrences changed (or *would-change* in dry); occurrences left unchanged, **broken
  down by reason** (ambiguous / variable / deleted / dir-move no-op / ignored / extensionless).
- **Files:** files modified vs files **skipped** (temp-file collision) vs files that **failed** the
  assertion (aborted+restored).
- **Force detail:** forced changes count, of which collision-picks (with the picked→alternatives).
- **Lint warnings:** new-target-missing count, escape-guard hits, `.tmp` leftovers.
- **Coverage:** renames with **zero** references found (dead entries), and the top rename entries by
  hit count.
- **Exit contract:** `0` clean; non-zero if any Provable file failed its assertion.

### 17.3 Accepted for v1 (2026-09-12)

All four included:
1. **`--only <path-prefix>`** — scope the run to references under one subtree (smaller, reviewable
   diffs). Filters by where the *referencing file* lives. (Complement `--only-rename <old>` is in §17.4.)
2. **`--json` output + an ambiguous-worklist file** (`…-ambiguous.json` — shipped as JSON only) — machine-readable
   result and a structured dump of the Ambiguous + dir-move leftovers; the hand-off input to the future
   3rd mechanism and a CI gate.
3. **One-line confidence summary** at the very end, e.g.
   `Provable 160 · Ambiguous 41 · Deleted 3 · Ignored 2312`.
4. **Per-run log file** (mirror of stdout, timestamped) for audit, alongside the ledger.

### 17.4 Further correctness / safety items — DECIDED (2026-09-12)

**In v1 (correctness/safety — mandatory):**
- **Symlinks: never followed — period, no override flag (Decision G).** The tree contains symlinks
  (e.g. a vendored bundle). The scanner **does not descend into symlinked directories** (prevents
  escaping the scan-root, infinite loops, and editing a vendored copy twice) and does not fix through
  symlinked files. Skipped symlinks are reported. There is deliberately **no flag** to enable following.
- **Full-path match boundary/terminator safety.** The predecessor's full-path match was an *unbounded*
  substring (a verifier caveat). Because this tool *rewrites*, a matched path must be followed by a
  non-path terminator (quote, space, backtick, `)`, `,`, `:`, EOL, …) so `tools/x/a` never rewrites
  inside `tools/x/ab`.
- **Byte-exact preservation.** Never normalize: preserve original line endings (LF/CRLF), the final
  newline, and any BOM/encoding. Only the matched tokens change. (Enforced by the untouched-context
  assertion.)
- **Git path-quoting in the parser.** `git status` quotes/escapes paths with spaces or non-ASCII
  (`"a b.js"`, octal escapes). The status parser must unquote them correctly.

**Options added:**
- **`--fail-on-ambiguous` — ADDED.** CI-friendly: exit non-zero if any Ambiguous references remain
  (pairs with the worklist).
- **`--only-rename <old-path>` — ADDED, repeatable.** Complementary scoping axis to `--only <prefix>`:
  `--only` filters by *where the referencing file lives*; `--only-rename` filters by *which renamed
  file's references* to chase. **Accepts multiple** — pass the flag once per file
  (`--only-rename a.js --only-rename b.js …`) so runs are scriptable. Lets a big diff be carved
  folder-by-folder **or** rename-by-rename. (`--only` is likewise repeatable.)

**Rejected:**
- **Post-run undo / `--keep-backups` — NOT building (Decision H).** Beyond the transient `.tmp` there is
  no rollback; **git is the backstop** (visual differ / `git checkout`).

---

## 18. `apply-plan` mode — the safe bridge for agent-authored edits (Decision I)

The agent process (`agent-ambiguous-resolution.design.md`, the "3rd mechanism") resolves *Ambiguous*
references by reading context, then needs to apply **targeted, single-occurrence edits**. Neither
existing mutation path fits: the **Provable pass** asserts changes against the *rename map*, and a
resolved bare-basename edit has no resolvable path so it would be rejected; **`--force`** is a blind
basename-global swap **exempt** from the safety assertion. So we add a third mode whose assertion is
**against the caller's explicitly stated expected text**, not the rename map.

```
tpm-fix-git-rename-refs.js apply-plan <plan.json> [--dry] [--scan-root <dir>] [--log <file>]
```

**Plan schema** — `plan.json` is a list of edits, each:
- `itemId` — the **content-anchored** id (stable across line shifts; from the ambiguous worklist).
- `file` — scan-root-relative path.
- `anchor` — `{ line, col }` **or** `{ line, occurrence }` — enough to locate ONE occurrence.
- `oldText` — the exact substring expected at the anchor.
- `newText` — the replacement.
- `expectHash` — hash of the file (or of a surrounding window) as the resolver last saw it (staleness pin).
- `meta` (optional) — chosen rename target, evidence ref — recorded in the report, not used for the edit.

**Assertions (the point of this mode):**
- **Expected-text match:** `oldText` must be present **exactly at the addressed occurrence** and be
  uniquely locatable there; else skip that edit, report, exit non-zero. (Not asserted against the
  rename map — that's what lets agent basename edits be expressed.)
- **Staleness pin:** `expectHash` must still match; if the file changed since the resolver saw it,
  skip → the caller re-resolves. (Per-item `if_version`.)
- **New-target-exists:** the rewritten reference's target must exist under scan-root.
- Reuses the shared rails: **`.tmp` snapshot + verify, byte-exact preservation, cleanup-only-ours,
  never-follow-symlinks, temp-collision skip, single-writer.** Within a file, apply in a deterministic
  order and never re-match a freshly written token.
- **Write / permission errors → graceful per-file exit-6 failure (not a crash):** the snapshot (claim)
  write, the `--dry` preview write, and the in-place original write are all wrapped in try/catch — the
  same hardening the `fix` verb applies (§9 / §17.1), routed here through apply-plan's **existing**
  failure exit code **6** (the same code used for stale / notfound / failed edits). A read-only original
  or an unwritable containing directory (common on the flaky file share) no longer throws an uncaught
  EACCES with an exit-1 stack. It is converted to a per-edit failure
  (`{itemId, file, reason:'eacces'|'write-error', restored:true}`) recorded in the application report's
  `failed[]`: the original is left byte-identical (a failed open-for-write truncates nothing), any temp
  we created is cleaned, and the run **continues to the other planned edits** instead of crashing. The
  `restore` write is unaffected — it runs only after a successful in-place write, so writability is
  already established there.
- **`--dry`:** preview on `.tmp1`/`.tmp2`, originals untouched (same contract as `fix --dry`).

**Outputs:** an application report (`applied` / `skipped-stale` / `skipped-notfound` / `failed`), and,
for each applied `itemId`, a **suppression entry** the CI gate can consume (below). The caller is
expected to **commit per apply-plan batch** so a bad batch is one `git revert`.

## 18.1 `--fail-on-ambiguous` suppression list (Decision J)

A successful agent run disposes items as FIXED / LEFT / ESCALATED — but LEFT/ESCALATED are still
"Ambiguous" to the tool, so a clean run would permanently re-trip `--fail-on-ambiguous` in CI. Fix: the
gate accepts a **suppression/allowlist** file keyed to the same content-anchored `itemId`s:

```
tpm-fix-git-rename-refs.js identify <status> --fail-on-ambiguous --suppress <disposed.json>
```

Suppressed items don't count toward the gate. The disposition record (from the agent process) is the
source of that file, so "the tool's notion of resolved" and "the process's notion of disposed"
reconcile instead of fighting.

> **Decisions I & J (2026-09-12):** add `apply-plan` (expected-text-asserted targeted edits) as the
> safe apply path for the agent process; add a content-anchored `itemId` to the ambiguous worklist and a
> `--suppress` allowlist so disposed items don't re-trip `--fail-on-ambiguous`. **Both are now SHIPPED
> (not deferred):** `apply-plan`, `--suppress`, and the content-anchored `itemId` (emitted from
> `identify`, stable across line shifts) are implemented and tested (113-test suite).

### `itemId` derivation — PINNED (Decision A, 2026-09-12)

The `itemId` is **content-anchored** and deliberately does **not** fold in the absolute line number, so
the same reference keeps the same id after unrelated line insertions/removals shift it up or down. It is
`sha256(file "\0" token "\0" windowHash [ "\0#" ordinal ])`, truncated to 16 hex chars, where:

- **`file`** — scan-root-relative POSIX path of the referencing file.
- **`token`** — the matched reference token (or basename), trimmed.
- **`windowHash`** — the first 12 hex chars of `sha256` of the **content window**: the matched line plus
  **±2 neighbor lines** (`ID_WINDOW_RADIUS = 2`), each **whitespace-normalized** (trailing CR stripped,
  internal space/tab runs collapsed to one space, ends trimmed) and joined by `\n`. Out-of-range
  neighbors (top/bottom of file) are included as empty strings so the window has a fixed shape. This
  window is what makes the id stable under pure line shifts yet distinct for references with different
  surroundings.
- **`ordinal`** — omitted for the common case. Only when two references genuinely collide on identical
  `(file, token, window)` does a deterministic per-run occurrence ordinal disambiguate them: the first
  keeps the bare id, the second gets `#1`, the third `#2`, in scan order. Ids remain deterministic
  across runs.
