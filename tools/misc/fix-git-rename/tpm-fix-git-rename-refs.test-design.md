# `tpm-fix-git-rename-refs` — test-coverage design

> Companion to `tpm-fix-git-rename-refs.design.md`. This spec is deliberately exhaustive: the builder
> subagent has far less context than we do, so every scenario, fixture, and assertion the tool must
> satisfy is written down here. If a behavior in the design doc isn't covered by a case here, that's a
> gap — §12 is the traceability checklist that maps every design decision to its test(s).

---

## 1. Testing philosophy & hard constraints

- **`git` is unavailable** (blocked). Tests must NEVER call git. The tool's only input is a status
  *text file*, which tests **fabricate** — so we get full control and no repo dependency.
- **Zero runtime deps** (Node builtins only), same as the tool. Tests use `node:assert` + `node:test`
  (or a tiny hand-rolled harness if we want zero reliance on `node:test`); no jest/mocha.
- **Hermetic & self-cleaning.** Every test builds its own throwaway tree under a fresh temp dir
  (`fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-fixrefs-'))`), runs against it, asserts, and removes it
  in a `finally`. **No test ever touches the real `claude-tpm` tree.** The mutating `fix` path is only
  ever exercised against these fabricated trees.
- **Deterministic.** No time/random dependence in assertions (timestamps in output are normalized or
  ignored). Running the suite twice yields identical results.
- **Two layers:**
  - **Unit** — `require()` the tool's exported pure helpers and assert on them directly (fast, precise).
  - **Integration** — spawn the CLI (`spawnSync(process.execPath, [TOOL, ...args], {cwd})`) against a
    fabricated tree and assert on stdout / exit code / resulting file bytes / filesystem state.
- **Assert on all four surfaces** for integration cases: (a) exit code, (b) stdout/ledger/JSON content,
  (c) post-run **file bytes** (what changed and what didn't), (d) **filesystem state** (no stray temps,
  originals intact/restored).

---

## 2. Fixture strategy

### 2.1 The builder helper
A `makeTree(spec)` helper writes a nested file tree from a JS object (path → contents), returning the
temp root. A `readTree(root)` helper snapshots path → bytes for before/after diffing. A `statusFile(entries)`
helper renders a realistic `git status` block (with the leading tab + `renamed:`/`deleted:` lines,
including quoted paths) to a file. Teardown via `fs.rmSync(root, {recursive:true, force:true})`.

### 2.2 Two fixture modes (both required)
1. **Synthetic minimal trees** — tiny, purpose-built per case (2–5 files). Best for pinpointing one
   behavior with an unambiguous expected result.
2. **A canonical "kitchen-sink" mock repo** — one richer fabricated tree (built by the test, not copied
   from the real repo) that packs one instance of *every* category so `identify`/`fix --dry` can be
   asserted holistically, and the summary counts pinned. Described in §2.3.

> We fabricate rather than copy the real tree so tests are stable regardless of how the real repo
> evolves. (If we ever want a smoke test against real data, keep it separate and read-only —
> `identify` / `fix --dry` only — never mutating.)

### 2.3 The kitchen-sink mock repo (contents)
A status file with these entries (covering every shape):

```
renamed: src/a/foo.js            -> src/a/foo-bar.js               # basename change, same dir
renamed: src/a/keep.js           -> src/b/keep.js                  # DIR-MOVE, basename unchanged
renamed: src/a/config.js         -> src/a/sess-config.js           # collision basename (1 of 2)
renamed: src/c/config.js         -> src/c/task-config.js           # collision basename (2 of 2)
renamed: src/a/only.js           -> src/a/only-1.js                # unique basename (force-clean)
renamed: "src/a/with space.js"   -> "src/a/with-space.js"          # git-quoted path w/ space
deleted: src/a/gone.js                                             # deleted, no target
renamed: src/a/foo.js            -> src/a/foo.js                   # NO-OP (must be dropped)
```

Referencing files exercising each anchor & category (illustrative):

```
docs/readme.md         : rooted `src/a/foo.js`; bare "see foo.js"; deleted ref `src/a/gone.js`;
                          `${FOO}/src/a/foo.js` (variable → ambiguous)
src/a/skill.md         : relative `./foo.js`; relative dir-move `./keep.js`
deep/x/y/note.md       : relative `../../src/a/foo.js`; collision bare `config.js`
src/z/uses.js          : require('./foo')  (extensionless → ambiguous)
src/other/config.js    : a REAL non-renamed file
docs/points-elsewhere.md: rooted `src/other/config.js` (resolves elsewhere → Ignored)
docs/edge.md           : `src/a/foo.js.bak` and `src/a/foobar.js` (boundary: must NOT match foo.js path)
weird/crlf.md          : CRLF line endings + a rooted `src/a/foo.js` (byte-exact test)
weird/nonl.txt         : no trailing newline + `src/a/foo.js`
weird/bom.md           : UTF-8 BOM + `src/a/foo.js`
assets/pic.bin         : a null-byte binary containing "foo.js" (must be skipped)
link-dir              -> symlink to src/a  (must NOT be followed)
```

Pin the expected category counts for this repo as a single golden assertion.

---

## 3. Unit tests (exported helpers)

### 3.1 Status parser (`parseStatus`)
- Parses `renamed: OLD -> NEW` and `deleted: OLD`.
- **Drops no-op renames** (`OLD == NEW`).
- **Unquotes git-quoted paths** — `"src/a/with space.js"` → `src/a/with space.js`; octal-escaped
  non-ASCII decoded.
- Ignores non-status lines (`On branch`, `Changes to be committed:`, blank lines, `(use "git…")`).
- Tolerates variable leading whitespace / tabs and multiple spaces around `->`.
- **Malformed input:** a `renamed:` line with no `->` → surfaced as a parse warning, not a crash.
- Builds `byOldPath` and `byBasename`; `byBasename['config.js'].length === 2` (collision),
  `byBasename['only.js'].length === 1` (unique).

### 3.2 Anchor detection & resolution (`resolveRef`)
- **Rooted** `src/a/foo.js` → `src/a/foo.js`.
- **Relative-to-file** `./foo.js` in `src/a/skill.md` → `src/a/foo.js`; `../../src/a/foo.js` in
  `deep/x/y/note.md` → `src/a/foo.js`.
- **Variable** `${FOO}/src/a/foo.js`, `$FOO/...` → **unresolvable** (no expansion, no env lookup).
- **Extensionless** `require('./foo')` → recognized only in specifier context; flagged extensionless.
- **Bare** `foo.js` in prose → no anchor.
- **Escape guard:** `../../../../etc/foo.js` resolving outside scan-root → flagged, not resolved.

### 3.3 Classifier (`classify`)
Given a resolved `P`, returns the right category:
- `P == rename OLD` → Provable (sub-type rooted / resolved-relative).
- `P == rename OLD` but basename unchanged (dir-move) → Provable **Dir-move**.
- `P == deleted OLD` → Deleted-ref.
- `P` is a real non-renamed file → Ignored.
- unresolvable/bare → Ambiguous; variable → Ambiguous(variable); extensionless → Ambiguous(extless).

### 3.4 Boundary matcher
- Full-path match requires a terminator after the path: `src/a/foo.js"` matches; `src/a/foo.js.bak`
  and `src/a/foobar.js` do **NOT** match the path `src/a/foo.js`.
- Basename word-boundary: `config.js` matches; `myconfig.js`, `config.json`, `config-resolver.js` do
  **NOT**.
- Multiple matches on one line all counted.

### 3.5 Style-preserving rewrite (`rewriteRef`)
- Rooted basename change → `src/a/foo.js` → `src/a/foo-bar.js`.
- Relative preserved: `./foo.js` → `./foo-bar.js`; `../../src/a/foo.js` → `../../src/a/foo-bar.js`.
- **Relative dir-move**: relative ref to `keep.js` recomputed to the new dir
  (`path.relative` from referencing file's dir), incl. changed `../` depth.
- Leading `./` preserved.

### 3.6 Only-intended-change assertion (`assertOnlyIntended`)
- PASS when the only line deltas are known OLD→NEW token swaps.
- **FAIL** when a changed line has any other delta (inject a synthetic "corrupted" edit).
- Line-count invariant: adding/removing a line → FAIL.
- Untouched-context: bytes outside the token identical → any change outside token → FAIL.

### 3.7 Collision pick (`pickForce`)
- First-in-status-file wins; returns chosen + ordered alternatives.
- Deterministic across repeated calls.

---

## 4. `identify` integration tests
- Emits every category line with correct `file:line`, verified against the kitchen-sink repo.
- **Golden summary**: pinned counts per category + distinct-file counts.
- Ledger also written to the ledger file; stdout == ledger content.
- **Ignored** bucket correctly excludes `src/other/config.js` references (resolves elsewhere).
- **Variable** and **extensionless** land in Ambiguous, never Provable.
- Binary `assets/pic.bin` skipped (its "foo.js" not reported).
- Symlink `link-dir` not descended (no dup findings from `src/a` via the link).
- `--json` produces valid JSON matching the human counts; `…-ambiguous.json` worklist lists exactly the
  ambiguous + dir-move-unfixable items.
- One-line confidence summary present and correct.
- Exit 0 always (hits are not an error).

## 5. `fix` (normal, mutating) integration tests
- Only **Provable** references rewritten; Ambiguous / Ignored / Deleted / variable / extensionless
  untouched.
- **Byte-level assertions** on each changed file (only the token changed).
- **Dir-move Provable via a resolvable relative ref** IS fixed (recomputed path); a *bare* dir-move
  mention is NOT.
- `.tmp` created then removed on success; **no `.tmp` left behind**.
- **Abort/restore:** a fixture engineered so an edit would produce an unexpected delta → tool aborts
  that file, **restores original from `.tmp`** (byte-identical), marks it failed, **exits non-zero**;
  other files in the same run still succeed.
- **Snapshot-failed abort:** simulate the `.tmp` not matching the original (or unwritable) → original
  NOT edited.
- Exit code: 0 clean; non-zero if any file failed.

## 6. `fix --dry` integration tests
- **Originals are byte-identical before and after** (the central guarantee).
- `.tmp1` and `.tmp2` created during, **both removed** after; none left behind.
- Diff/preview output lists exactly the would-change lines; **same change set as a real `fix`** would
  produce (dry/real parity).
- Composes with `--force` (`fix --force --dry`) — previews forced changes too, originals untouched.

## 7. `fix --force` integration tests
- **Unique basename** (`only.js`) → clean global swap; logged as forced.
- **Collision** (`config.js`) → first-in-file winner applied; loud output lists chosen + all
  alternatives **with full `OLD -> NEW` status lines**; forced edits NOT subject to strict assertion.
- **Dir-move winner** (if a collision's first entry is a dir-move) → reports NO textual change + lists
  the affected lines (basename-global is a no-op).
- **Extensionless still excluded** even under `--force` (never rewritten).
- **Variable-prefixed** ambiguous → basename portion swapped under force (prefix irrelevant).

## 8. Safety / edge-case integration tests
- **Temp collision:** pre-create `<file>.tmp` (a bystander file with distinct contents) → that file is
  **skipped** with a clear message, original untouched, **and the bystander `.tmp` is neither edited
  nor deleted nor reported as error** after the run (assert its bytes unchanged, still present).
  Repeat for `--dry` with a pre-existing `.tmp1`.
- **Cleanup deletes only ours:** place a stray `random.tmp` elsewhere in the tree → after a run it
  still exists, unreported.
- **Symlinks:** `link-dir` → not descended; a symlinked *file* pointing at a real file → not rewritten
  through the link. No override flag exists (assert unknown-flag behavior if `--follow-symlinks` given).
- **Byte-exact:** CRLF file keeps CRLF; no-trailing-newline file still has none; BOM file keeps BOM —
  only the token changed on each.
- **Boundary:** `docs/edge.md` — `foo.js.bak` / `foobar.js` NOT rewritten by the `src/a/foo.js` path
  rule.
- **Idempotency:** run `fix` twice; second run makes zero Provable changes and exits 0.
- **Escape guard:** a ref resolving outside scan-root → flagged, never fixed.
- **New-target-exists lint:** craft a rename whose NEW path does not exist in the tree; a Provable
  rewrite to it → warn/abort per §17.1 (assert it does not silently rewrite to a missing file).
- **Multiple hits per line** all rewritten correctly.
- **Longest-path-first ordering:** overlapping OLD paths where one is a prefix of another → no clobber.

## 9. CLI / flag tests
- `--help` exits 0, prints usage.
- Missing positional / bad verb → exit 2.
- Unreadable status file → exit 1.
- `--scan-root` respected (default = cwd).
- `--exclude <glob>` (repeatable) excludes matched paths; the status file auto-excluded.
- `--only <prefix>` limits edits to that subtree; **repeatable** — multiple `--only` flags union the
  subtrees.
- `--only-rename <old>` limits to that rename's references across the tree; **repeatable** — e.g.
  `--only-rename a.js --only-rename b.js` fixes exactly those two renames' references and no others.
  Assert: a non-listed rename's references are left untouched; an unknown `--only-rename` path is a
  no-op (or warned), not a crash.
- `--fail-on-ambiguous` → non-zero when ambiguous remain, 0 when none.
- `--json` / `--log <file>` produce the expected artifacts.

## 10. Exit-code matrix (assert explicitly)
| Situation | Exit |
|---|---|
| `identify` any outcome | 0 |
| `fix` clean (all provable applied, none failed) | 0 |
| `fix` with a file that failed the assertion (aborted+restored) | non-zero |
| `fix --fail-on-ambiguous` with ambiguous remaining | non-zero |
| bad args / unknown verb | 2 |
| status file unreadable | 1 |

## 11. Test layout & running
- `tests/tpm-fix-git-rename-refs/test.js` — unit + integration, self-contained, exit non-zero on any
  failure (so it slots into the suite runner).
- Helpers (`makeTree`, `readTree`, `statusFile`, `runCli`) at the top of the file or a sibling
  `helpers.js`.
- Run: `node tests/tpm-fix-git-rename-refs/test.js` — prints `PASSED n / FAILED m`.
- Unit tests that would need real `git` do not exist (there are none — we fabricate status text).

---

## 12. Traceability checklist (design decision → test)

| Design item | Covered by |
|---|---|
| Renamed + deleted parsing; no-op drop (§4) | 3.1, kitchen-sink |
| Two-step resolution; anchors (§5) | 3.2, 4 |
| Ignored-elsewhere precision (§5) | 3.3, 4 |
| Dir-move category (§6.1) | 3.3, 3.5, 5, 7 |
| Extensionless = ambiguous, never fixed — Decision A | 3.2, 3.3, 4, 7 |
| Variable/templated = ambiguous, no expansion — Decision E | 3.2, 3.3, 4, 7 |
| `--force` first-in-file + full status lines — Decision B | 3.7, 7 |
| Forced edits exempt from strict assert — Decision C | 7 |
| Style-preserving rewrite (§7) | 3.5, 5, 6 |
| Only-intended-change / abort+restore (§9, §17.1) | 3.6, 5 |
| Temp-collision skip; cleanup only ours — Decision F | 8 |
| Symlinks never followed, no flag — Decision G | 4, 8 |
| Boundary/terminator safety (§17.4) | 3.4, 8 |
| Byte-exact preservation (§17.4) | 8 |
| Git path-quoting (§17.4) | 3.1, kitchen-sink |
| Snapshot verified before edit (§17.1) | 5 |
| Idempotency (§10, §17.1) | 8 |
| Dry/real parity; originals untouched (§9) | 6 |
| New-target-exists lint (§17.1) | 8 |
| Escape guard (§17.1) | 3.2, 8 |
| Run report / stats / confidence line (§17.2, 17.3) | 4 |
| `--only` / `--only-rename` / `--fail-on-ambiguous` / `--json` / `--log` (§17.3, 17.4) | 9 |
| Exit codes (§11) | 10 |
