#!/usr/bin/env node
/**
 * tpm-fix-git-rename-refs.js — find (and, later, fix) every reference to a file that was RENAMED or
 * DELETED in a batch git operation, so the now-stale references can be updated safely.
 *
 * Domain-agnostic & reusable: nothing here knows about any project. Input is a git-status *text file*
 * plus a scan-root. The tool NEVER calls `git` and NEVER shells out to `diff`. No project paths are
 * baked in; no special meaning is given to any variable/placeholder (a `${FOO}` segment is opaque).
 *
 * PHASE 1: full CLI + the COMPLETE `identify` mode with all shared/core machinery.
 * PHASE 2 (this file): the mutating `fix` verb (Provable rewrites with the §9 diff-safety assertion;
 *   `--dry`; `--force` blind basename swaps), the `apply-plan` verb (§18: expected-text-asserted
 *   targeted edits), and the `--fail-on-ambiguous` + `--suppress` CI gate (§18.1). See:
 *   tpm-fix-git-rename-refs.design.md  and  tpm-fix-git-rename-refs.test-design.md
 *
 * USAGE
 *   tpm-fix-git-rename-refs.js identify   <git-status-file> [--fail-on-ambiguous] [--suppress <json>] [scoping] [output]
 *   tpm-fix-git-rename-refs.js fix        <git-status-file> [--dry] [--force] [--fail-on-ambiguous] [--suppress <json>] [scoping] [output]
 *   tpm-fix-git-rename-refs.js apply-plan <plan.json> [--dry] [--scan-root <dir>] [--log <file>]
 *   tpm-fix-git-rename-refs.js --help
 *
 *   scoping:  [--scan-root <dir>] [--exclude <glob> ...] [--only <path-prefix> ...] [--only-rename <old-path> ...]
 *   output:   [--json] [--log <file>]
 *
 *   Exit codes: 0 clean (identify is 0 unless --fail-on-ambiguous trips); 2 bad args / unknown verb;
 *   1 status/plan unreadable or empty; 4 a `fix` file failed its safety assertion/lint (aborted+
 *   restored); 5 --fail-on-ambiguous gate tripped; 6 `apply-plan` had stale/notfound/failed edits.
 *   TEST-ONLY: env TPM_FIX_GIT_RENAME_TEST_CORRUPT=<rel> forces one file's edit to fail the assertion
 *   so the abort-and-restore rails can be exercised hermetically (no effect unless set).
 *
 * CONVENTIONS: Node.js, zero runtime deps (builtins only); `module.exports` of all pure helpers for
 *   unit testing. Reuses the verified rename-map parse + basename/word-boundary matching ideas from
 *   the predecessor find-tool-rename-usages.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tool version — echoed into the machine-readable run reports (§11 / §17.2).
const TOOL_VERSION = '2.0.0';

// Directories never worth scanning (name-based).
const EXCLUDE_DIRS = new Set(['.git', 'node_modules']);

// Fixed basenames of this tool's own output artifacts — always excluded from the scan.
const OUTPUT_BASENAMES = new Set([
  'tpm-fix-git-rename-refs-ledger.txt',
  'tpm-fix-git-rename-refs-result.json',
  'tpm-fix-git-rename-refs-ambiguous.json',
]);

// Characters that make up a path-like reference token (incl. variable syntax `$ { }` and `~`).
const TOKEN_CHAR = /[A-Za-z0-9_./\-${}~]/;
// Characters that would *continue* a path — used for full-path boundary/terminator safety.
// Verifier note #3 (reconciled): this set is now identical to TOKEN_CHAR's continuation class, so the
// boundary rules used by `matchFullPath`/`boundarySafeReplace` (Phase-2 `fix`) agree with the token
// extractor (`extractToken`) used by `identify`. Concretely this means a full-path rewrite never fires
// inside an emacs/backup `foo.js~`, a `${VAR}`-prefixed template, or a `}`-terminated interpolation —
// the trailing/leading `$ { } ~` now count as path-continuation, so those are left for the ambiguous
// pass instead of being blindly rewritten. (`identify`'s scan matches by basename, not `matchFullPath`,
// so its category counts are unaffected.)
const PATH_CONT = /[A-Za-z0-9_./\-${}~]/;

// ── pure helpers (unit-testable) ─────────────────────────────────────────────

// Escape a string for safe literal use inside a RegExp.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// basename without its final extension: 'foo.js' -> 'foo'; 'foo' -> 'foo'; '.env' -> '.env'.
function stripExt(name) {
  const e = path.posix.extname(name);
  return e ? name.slice(0, -e.length) : name;
}

// Unquote a git-quoted path. `git status` wraps paths with spaces/non-ASCII in double quotes and
// octal-escapes bytes (`"a b.js"`, `"src/\303\251.js"`). Decodes \\ \" \t \n \r and \NNN octal into
// raw bytes, then interprets the byte stream as UTF-8. A path that is not quoted is returned as-is.
function unquoteGitPath(p) {
  p = String(p).trim();
  if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') {
    const inner = p.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '\\') {
        const n = inner[i + 1];
        if (n === undefined) { bytes.push(0x5c); }
        else if (n === '\\') { bytes.push(0x5c); i++; }
        else if (n === '"') { bytes.push(0x22); i++; }
        else if (n === 't') { bytes.push(0x09); i++; }
        else if (n === 'n') { bytes.push(0x0a); i++; }
        else if (n === 'r') { bytes.push(0x0d); i++; }
        else if (n >= '0' && n <= '7') {
          const oct = (inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/) || ['0'])[0];
          bytes.push(parseInt(oct, 8) & 0xff);
          i += oct.length;
        } else { bytes.push(0x5c); } // unknown escape: keep the backslash literally
      } else {
        for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return p;
}

// Build `byOldPath` (OLD -> entry) and `byBasename` (basename -> [entries]) indexes.
function buildIndexes(entries) {
  const byOldPath = new Map();
  const byBasename = new Map();
  for (const e of entries) {
    byOldPath.set(e.old, e);
    if (!byBasename.has(e.oldBase)) byBasename.set(e.oldBase, []);
    byBasename.get(e.oldBase).push(e);
  }
  return { byOldPath, byBasename };
}

// Parse a git-status text file. Returns { entries, warnings, byOldPath, byBasename }.
//   entries: [{ kind:'rename'|'delete', old, new|null, oldBase, newBase|null }]
// Drops no-op renames (OLD == NEW). Unquotes git-quoted paths. Ignores non-status lines. Tolerates
// variable whitespace and multiple spaces around `->`. Malformed status lines surface as warnings,
// never a crash.
function parseStatus(text) {
  const entries = [];
  const warnings = [];
  for (const raw of String(text).split('\n')) {
    const trimmed = raw.trim();
    let m = trimmed.match(/^renamed:\s*(.+)$/);
    if (m) {
      const arrow = m[1].match(/^(.*?)\s+->\s+(.*)$/);
      if (!arrow) { warnings.push(`malformed 'renamed' line (no ' -> '): ${trimmed}`); continue; }
      const oldP = unquoteGitPath(arrow[1]);
      const newP = unquoteGitPath(arrow[2]);
      if (!oldP || !newP) { warnings.push(`malformed 'renamed' line: ${trimmed}`); continue; }
      if (oldP === newP) continue; // no-op guard
      entries.push({
        kind: 'rename', old: oldP, new: newP,
        oldBase: path.posix.basename(oldP), newBase: path.posix.basename(newP),
      });
      continue;
    }
    m = trimmed.match(/^deleted:\s*(.+)$/);
    if (m) {
      const oldP = unquoteGitPath(m[1]);
      if (!oldP) { warnings.push(`malformed 'deleted' line: ${trimmed}`); continue; }
      entries.push({ kind: 'delete', old: oldP, new: null, oldBase: path.posix.basename(oldP), newBase: null });
      continue;
    }
    // any other line (On branch, Changes to be committed:, blank, "(use ...)", etc.) is ignored
  }
  return { entries, warnings, ...buildIndexes(entries) };
}

// Return the start-indices of word-boundary basename matches on a line. `config.js` matches, but not
// inside `myconfig.js` / `config.json` / `config-resolver.js`. (A trailing `.` is allowed so the broad
// net still catches e.g. `foo.js.bak`, which resolution later classifies.)
function matchBasename(line, base) {
  const re = new RegExp('(?<![A-Za-z0-9_.\\-])' + escapeRegExp(base) + '(?![A-Za-z0-9_\\-])', 'g');
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    out.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  return out;
}

// Boundary/terminator-safe full-path matcher: `fullPath` must be preceded by a non-path char (or
// start) AND followed by a non-path char (or EOL) so `src/a/foo.js` never matches inside
// `src/a/foo.js.bak` or `src/a/foobar.js`. Returns start-indices of safe matches.
function matchFullPath(line, fullPath) {
  const out = [];
  if (!fullPath) return out;
  let from = 0;
  while (true) {
    const idx = line.indexOf(fullPath, from);
    if (idx === -1) break;
    const before = idx > 0 ? line[idx - 1] : '';
    const afterIdx = idx + fullPath.length;
    const after = afterIdx < line.length ? line[afterIdx] : '';
    const beforeOk = before === '' || !PATH_CONT.test(before);
    const afterOk = after === '' || !PATH_CONT.test(after);
    if (beforeOk && afterOk) out.push(idx);
    from = idx + 1;
  }
  return out;
}

// Expand outward from [start,end) to capture the full path-like token the match sits in.
function extractToken(line, start, end) {
  let s = start, e = end;
  while (s > 0 && TOKEN_CHAR.test(line[s - 1])) s--;
  while (e < line.length && TOKEN_CHAR.test(line[e])) e++;
  return line.slice(s, e);
}

// Determine a reference token's anchor and resolve it to a scan-root-relative POSIX path.
//   { anchor:'variable'|'relative'|'rooted'|'bare', token, resolved|null, unresolvable, variable?, escape? }
// - variable/templated (`${FOO}`, `$FOO`, any `${...}`/`$NAME`) -> unresolvable (never expanded).
// - relative (`./`, `../`) -> resolved against the referencing file's dir.
// - rooted (contains `/`, not relative) -> resolved against the scan-root (i.e. the token itself).
// - bare (no `/`) -> no anchor, unresolvable.
// A relative/rooted resolution escaping the scan-root (leading `..`) is flagged (escape) and not resolved.
function resolveRef(token, referencingFileRel) {
  if (/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(token)) {
    return { anchor: 'variable', token, resolved: null, unresolvable: true, variable: true };
  }
  if (token.startsWith('./') || token.startsWith('../')) {
    const dir = path.posix.dirname(referencingFileRel || '.');
    const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, token));
    const escape = joined.startsWith('..');
    return { anchor: 'relative', token, resolved: escape ? null : joined, escape, unresolvable: escape };
  }
  if (token.includes('/')) {
    const norm = path.posix.normalize(token);
    const escape = norm.startsWith('..') || norm.startsWith('/');
    return { anchor: 'rooted', token, resolved: escape ? null : norm, escape, unresolvable: escape };
  }
  return { anchor: 'bare', token, resolved: null, unresolvable: true };
}

// Classify a resolved reference into a category. `rr` is a resolveRef result, `base` the matched
// basename. Returns { category, sub?, entry?, entries?, resolved?, anchor? }.
function classify(rr, indexes, base) {
  if (rr.variable) return { category: 'ambiguous', sub: 'variable' };
  if (rr.resolved && indexes.byOldPath.has(rr.resolved)) {
    const entry = indexes.byOldPath.get(rr.resolved);
    if (entry.kind === 'delete') return { category: 'deleted', entry };
    if (entry.oldBase === entry.newBase) return { category: 'dirmove', entry, anchor: rr.anchor };
    return { category: 'provable', sub: rr.anchor === 'rooted' ? 'rooted' : 'resolved', entry, anchor: rr.anchor };
  }
  if (rr.resolved) return { category: 'ignored', resolved: rr.resolved };
  // unresolvable / bare (incl. escape-flagged)
  const list = indexes.byBasename.get(base) || [];
  if (list.length > 1) return { category: 'ambiguous', sub: 'collision', entries: list };
  return { category: 'ambiguous', sub: 'unique', entries: list };
}

// Style-preserving rewrite of a provable reference token to point at the NEW location.
// - rooted -> the NEW path (`entry.new`), which correctly handles dir-moves.
// - relative -> recomputed `path.relative(referencingDir, entry.new)`, preserving a leading `./`.
function rewriteRef(token, anchor, referencingFileRel, entry) {
  if (anchor === 'rooted') return entry.new;
  if (anchor === 'relative') {
    const dir = path.posix.dirname(referencingFileRel || '.');
    let rel = path.posix.relative(dir === '.' ? '' : dir, entry.new);
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  }
  return token; // variable / extensionless / bare are not rewritten in the provable pass
}

// The `--force` collision pick: first-in-status-file wins, end of story. Returns chosen + ordered
// alternatives. Deterministic across calls.
function pickForce(base, byBasename) {
  const list = byBasename.get(base) || [];
  return { chosen: list[0] || null, alternatives: list.slice(1) };
}

// Detect extensionless module specifiers (`require('./foo')`, `import x from '../foo'`) whose stem
// matches a rename/delete oldBase stem. Only inside specifier strings, so prose is never caught.
function detectExtensionless(line, entries) {
  const out = [];
  const re = /(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s+)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const spec = m[2];
    if (path.posix.extname(spec) !== '') continue; // has an extension -> handled by the basename net
    const stem = path.posix.basename(spec);
    // Verifier note #4 (double-count guard): only treat a specifier as "extensionless" when the RENAMED
    // file actually HAS an extension the specifier omitted (`foo.js` referenced as `./foo`). If the
    // renamed file is itself extensionless (oldBase === its own stem, e.g. a `bin/tool` -> `bin/cli`
    // rename), then `require('./tool')` is caught by the ordinary basename net and must NOT also be
    // reported here — otherwise the same hit is counted twice (once extless, once basename).
    const entry = entries.find((e) => path.posix.extname(e.oldBase) !== '' && stripExt(e.oldBase) === stem);
    if (entry) out.push({ index: m.index, spec, stem, entry });
  }
  return out;
}

// Boundary/terminator-safe replacement of every full-path occurrence of `oldStr` with `newStr`. Mirrors
// `matchFullPath`'s rules: a match must be bounded by a non-PATH_CONT char (or string edge) on both
// sides, so `src/a/foo.js` never rewrites inside `src/a/foo.js.bak`, `src/a/foobar.js`, `foo.js~`, or a
// `${VAR}`-prefixed template. Never re-scans a freshly written token (the cursor advances past the
// inserted `newStr`), satisfying §10's "no re-matching a freshly written token".
function boundarySafeReplace(text, oldStr, newStr) {
  if (!oldStr) return String(text);
  const s = String(text);
  let out = '';
  let from = 0;
  while (true) {
    const idx = s.indexOf(oldStr, from);
    if (idx === -1) { out += s.slice(from); break; }
    const before = idx > 0 ? s[idx - 1] : '';
    const afterIdx = idx + oldStr.length;
    const after = afterIdx < s.length ? s[afterIdx] : '';
    const beforeOk = before === '' || !PATH_CONT.test(before);
    const afterOk = after === '' || !PATH_CONT.test(after);
    if (beforeOk && afterOk) {
      out += s.slice(from, idx) + newStr;
      from = afterIdx; // skip the ORIGINAL old; the just-written newStr is not re-scanned
    } else {
      out += s.slice(from, idx + 1); // not a boundary-safe hit; keep one char and advance
      from = idx + 1;
    }
  }
  return out;
}

// Word-boundary basename swap (used only by `--force`, blind by design). Replaces `base` with `newBase`
// using the same boundary rules as `matchBasename`, never re-scanning a freshly written token.
function basenameSafeReplace(text, base, newBase) {
  if (!base) return String(text);
  const s = String(text);
  const re = new RegExp('(?<![A-Za-z0-9_.\\-])' + escapeRegExp(base) + '(?![A-Za-z0-9_\\-])', 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index) + newBase;
    last = m.index + base.length;
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
  }
  out += s.slice(last);
  return out;
}

// Count boundary-safe full-path occurrences of `oldStr` across a whole (multi-line) text — mirrors the
// replace semantics of boundarySafeReplace. Used only to populate per-edit `occurrence` counts in the
// machine-readable run report (§11); has no effect on what is written.
function countBoundarySafe(text, oldStr) {
  if (!oldStr) return 0;
  let n = 0;
  for (const ln of String(text).split('\n')) n += matchFullPath(ln, oldStr).length;
  return n;
}

// Count word-boundary basename occurrences across a whole text — mirrors basenameSafeReplace. Run-report
// only (per-edit `occurrence` count for forced basename swaps).
function countBasenameHits(text, base) {
  if (!base) return 0;
  let n = 0;
  for (const ln of String(text).split('\n')) n += matchBasename(ln, base).length;
  return n;
}

// Apply an ordered list of {old,new} full-path substitutions to `text`, LONGEST-OLD-FIRST (§10) so a
// shorter path that prefixes a longer one can't clobber it. Boundary-safe throughout.
function applyProvableSubs(text, subs) {
  const ordered = subs.slice().sort((a, b) => b.old.length - a.old.length);
  let out = String(text);
  for (const sub of ordered) out = boundarySafeReplace(out, sub.old, sub.new);
  return out;
}

// Assert that the only differences between two texts are known OLD->NEW token swaps (§9 / §17.1). subs:
// [{old, new}]. Reproduces the expected text by applying the SAME boundary-safe, longest-first
// substitution used by the real writer, then requires byte-equality per line. Catches: line-count
// changes; any delta on a changed line that isn't a known token swap (collateral, corruption); and —
// per verifier note #2 — it will NOT false-positive when a shorter OLD path is a substring of a longer
// one on the same line, because the reproduction is boundary-safe (unlike a naive split/join, which
// would have rewritten `foo.js` inside `foo.js.bak`). Returns { ok, reason?, line? }.
function assertOnlyIntended(originalText, modifiedText, subs) {
  const o = String(originalText).split('\n');
  const mo = String(modifiedText).split('\n');
  if (o.length !== mo.length) return { ok: false, reason: 'line-count' };
  const ordered = subs.slice().sort((a, b) => b.old.length - a.old.length);
  for (let i = 0; i < o.length; i++) {
    if (o[i] === mo[i]) continue;
    let expected = o[i];
    for (const s of ordered) expected = boundarySafeReplace(expected, s.old, s.new);
    if (expected !== mo[i]) return { ok: false, reason: 'unexpected-delta', line: i + 1 };
  }
  return { ok: true };
}

// PER-SUBSTITUTION variant of assertOnlyIntended for a file processed under --force (Decision C,
// refined). The strict only-intended-change / untouched-context / line-count checks still guard the
// PROVABLE substitutions, while the FORCED basename swaps are exempt (allowed through unasserted). It
// works by reproducing the writer's EXACT pipeline — provable subs (boundary-safe, longest-OLD-first)
// then forced basename swaps — and requiring per-line byte-equality against the actual edited text:
// a forced change therefore always reproduces (never fails), whereas any delta on a provable-touched
// or untouched line that is NOT explained by these subs (collateral / corruption) is caught. When
// `forceSubs` is empty this is byte-for-byte equivalent to assertOnlyIntended(subs=provSubs).
// Returns { ok, reason?, line? }.
function assertProvableExemptForced(originalText, modifiedText, provSubs, forceSubs) {
  const o = String(originalText).split('\n');
  const mo = String(modifiedText).split('\n');
  if (o.length !== mo.length) return { ok: false, reason: 'line-count' };
  let expected = String(originalText);
  if (provSubs && provSubs.length) expected = applyProvableSubs(expected, provSubs);
  for (const s of (forceSubs || [])) expected = basenameSafeReplace(expected, s.old, s.new);
  const ex = expected.split('\n');
  for (let i = 0; i < o.length; i++) {
    if (o[i] === mo[i]) continue;            // unchanged line — fine
    if (ex[i] !== mo[i]) return { ok: false, reason: 'unexpected-delta', line: i + 1 };
  }
  return { ok: true };
}

// Locate the `occ`-th BOUNDARY-SAFE occurrence of `oldText` on a line and return its start index, or -1
// if there is no such standalone occurrence. Used by `apply-plan`'s occurrence addressing so a request
// like `{oldText:'config.js', occurrence:1}` on `myconfig.js and config.js` never targets the substring
// buried inside `myconfig.js`: a match only counts when it is a standalone token — the char before and
// after must not be a path-continuation char (the SAME boundary rule as matchFullPath /
// boundarySafeReplace). If `oldText` appears only as a substring of a larger token, no occurrence is
// counted and the edit is treated as not-found (skipped + reported). `col` addressing is the exact-path
// escape hatch and is unaffected by this guard.
function findBoundedOccurrence(lineText, oldText, occ) {
  if (!oldText) return -1;
  const s = String(lineText);
  const want = occ && occ > 0 ? occ : 1;
  let count = 0, from = 0;
  while (true) {
    const at = s.indexOf(oldText, from);
    if (at === -1) return -1;
    const before = at > 0 ? s[at - 1] : '';
    const afterIdx = at + oldText.length;
    const after = afterIdx < s.length ? s[afterIdx] : '';
    const boundaryOk = (before === '' || !PATH_CONT.test(before)) && (after === '' || !PATH_CONT.test(after));
    if (boundaryOk) { count++; if (count === want) return at; }
    from = at + 1;
  }
}

// sha256 hex of a Buffer/string — the staleness pin used by `apply-plan`'s `expectHash`.
function hashContent(buf) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')).digest('hex');
}

// Normalize a single line of text for the content-window hash: strip a trailing CR, collapse internal
// runs of spaces/tabs to a single space, and trim the ends. This makes the window stable under
// whitespace reflow while still distinguishing genuinely different content.
function normalizeWindowLine(s) {
  let t = String(s);
  if (t.endsWith('\r')) t = t.slice(0, -1);
  return t.replace(/[ \t]+/g, ' ').trim();
}

// Build the CONTENT WINDOW for a match: the matched line plus `radius` neighbor lines on each side
// (default ±2), each normalized (normalizeWindowLine) and joined by '\n'. Out-of-range neighbors are
// included as empty strings so the window has a fixed shape. Because it is anchored to the SURROUNDING
// CONTENT rather than the absolute line number, the same reference keeps the same window after pure
// line-number shifts (inserting/removing unrelated lines elsewhere in the file), yet two references
// with different neighbors produce different windows. This is the id's staleness-resistant anchor.
const ID_WINDOW_RADIUS = 2;
function buildContentWindow(lines, i, radius = ID_WINDOW_RADIUS) {
  const parts = [];
  for (let j = i - radius; j <= i + radius; j++) {
    parts.push(j >= 0 && j < lines.length ? normalizeWindowLine(lines[j]) : '');
  }
  return parts.join('\n');
}

// Content-anchored id for an ambiguous finding — stable input to the `--suppress` allowlist (§18.1) and
// the future agent process's worklist (agent-ambiguous-resolution §3). Derived from the referencing
// file, the normalized matched token/basename, and a hash of the SURROUNDING CONTENT WINDOW (§5 step 2)
// — deliberately NOT the absolute line number, so the id is "content-anchored, stable across line
// shifts." When two truly-identical references collide on the same (file, token, window), a per-run
// occurrence ordinal (`f.idOccurrence`, assigned by disambiguateItemIds) is folded in to keep ids
// distinct and deterministic. `f.window` is set by the scanner; the `f.text` fallback keeps the helper
// usable in isolation (unit tests / callers that only have the matched line).
function computeItemId(f) {
  const token = String(f.token || f.base || '').trim();
  const windowSrc = f.window != null ? String(f.window) : normalizeWindowLine(f.text || '');
  const ctx = hashContent(windowSrc).slice(0, 12);
  const occ = f.idOccurrence ? '\0#' + f.idOccurrence : '';
  return crypto.createHash('sha256')
    .update(String(f.file) + '\0' + token + '\0' + ctx + occ)
    .digest('hex').slice(0, 16);
}

// Assign a deterministic per-run occurrence ordinal to ambiguous findings that would otherwise share an
// identical content-anchored id (same file + token + content window — a genuine collision, e.g. an
// identical reference repeated inside an identically-surrounded block). The FIRST such finding keeps the
// bare id (ordinal 0, no suffix); the 2nd gets #1, the 3rd #2, and so on, in deterministic scan order.
// Findings whose base id is unique are left untouched. Call once, after scoping, before any itemId is
// emitted or gated.
function disambiguateItemIds(findings) {
  const counts = new Map();
  for (const f of findings) {
    if (f.category !== 'ambiguous') continue;
    f.idOccurrence = 0;
    const baseId = computeItemId(f);
    const n = counts.get(baseId) || 0;
    if (n > 0) f.idOccurrence = n; // 2nd identical -> #1, 3rd -> #2, ...
    counts.set(baseId, n + 1);
  }
  return findings;
}

// Convert a simple glob (`*`, `?`) to an anchored RegExp. `*` and `?` do not cross `/`.
function globToRegExp(glob) {
  let re = '';
  for (const c of glob) {
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// ── scan ─────────────────────────────────────────────────────────────────────

// Walk the scan-root and produce findings + corpus stats. NEVER follows symlinks. Skips binary
// (null-byte) files and excluded paths.
function scanTree(scanRoot, parsed, opts) {
  const { entries, byOldPath, byBasename } = parsed;
  const indexes = { byOldPath, byBasename };
  const uniqueBasenames = [...byBasename.keys()];
  const excludeRes = (opts.excludes || []).map(globToRegExp);
  const statusBasename = opts.statusBasename;

  const findings = [];
  const referenced = new Set();
  const stats = { filesScanned: 0, binarySkipped: 0, symlinksSkipped: 0, excluded: 0 };

  function isExcludedFile(rel, name) {
    if (name === statusBasename) return true;
    if (OUTPUT_BASENAMES.has(name)) return true;
    if (/\.tmp[12]?$/.test(name)) return true;
    for (const re of excludeRes) { if (re.test(rel) || re.test(name)) return true; }
    return false;
  }

  function pushFinding(f, olds) {
    f.olds = olds || [];
    for (const o of f.olds) referenced.add(o);
    findings.push(f);
  }

  function scanContent(content, fileRel) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let text = lines[i];
      if (text.endsWith('\r')) text = text.slice(0, -1);
      if (!text) continue;
      const lineNo = i + 1;
      // Content window for content-anchored itemIds (§5 step 2 / computeItemId): the matched line plus
      // ±ID_WINDOW_RADIUS neighbors, whitespace-normalized. Stable across pure line-number shifts.
      const window = buildContentWindow(lines, i);

      // Extensionless module specifiers (their own ambiguous bucket; never overlap the basename net).
      for (const ex of detectExtensionless(text, entries)) {
        pushFinding({
          file: fileRel, line: lineNo, text, window, category: 'ambiguous', sub: 'extless',
          token: ex.spec, stem: ex.stem, entry: ex.entry,
        }, [ex.entry.old]);
      }

      // Basename net + two-step resolution.
      for (const base of uniqueBasenames) {
        for (const mi of matchBasename(text, base)) {
          const token = extractToken(text, mi, mi + base.length);
          const rr = resolveRef(token, fileRel);
          const cls = classify(rr, indexes, base);
          const f = { file: fileRel, line: lineNo, text, window, token, base, anchor: rr.anchor, category: cls.category, sub: cls.sub };
          if (rr.escape) f.escape = true;
          if (cls.category === 'provable' || cls.category === 'dirmove' || cls.category === 'deleted') {
            f.entry = cls.entry;
            // Both 'provable' and 'dirmove' carry a style-preserving newToken: a `dirmove` finding only
            // ever arises from a RESOLVED rooted/relative ref (bare mentions fall to 'ambiguous'), so it
            // is fixable by recomputing the whole path (§6.1). It keeps its own display category in
            // `identify`, but the Phase-2 fix pass treats it as Provable-by-path.
            if (cls.category === 'provable' || cls.category === 'dirmove') f.newToken = rewriteRef(token, rr.anchor, fileRel, cls.entry);
            pushFinding(f, [cls.entry.old]);
          } else if (cls.category === 'ignored') {
            f.resolved = cls.resolved;
            pushFinding(f, []);
          } else { // ambiguous
            if (cls.sub === 'variable') {
              const list = byBasename.get(base) || [];
              f.entries = list;
              pushFinding(f, list.map((e) => e.old));
            } else {
              f.entries = cls.entries || [];
              pushFinding(f, (cls.entries || []).map((e) => e.old));
            }
          }
        }
      }
    }
  }

  function walk(dirAbs, dirRel) {
    let ents;
    try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(dirAbs, e.name);
      const rel = dirRel ? dirRel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) { stats.symlinksSkipped++; continue; } // never follow — Decision G
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) { stats.excluded++; continue; }
        walk(abs, rel);
      } else if (e.isFile()) {
        if (isExcludedFile(rel, e.name)) { stats.excluded++; continue; }
        let buf;
        try { buf = fs.readFileSync(abs); } catch { continue; }
        if (buf.includes(0)) { stats.binarySkipped++; continue; } // binary
        stats.filesScanned++;
        scanContent(buf.toString('utf8'), rel);
      }
    }
  }

  walk(scanRoot, '');
  return { findings, referenced, stats };
}

// ── filtering (scoping flags) ─────────────────────────────────────────────────

function applyScoping(findings, opts) {
  let out = findings;
  if (opts.only && opts.only.length) {
    const prefixes = opts.only.map((p) => p.replace(/\/+$/, ''));
    out = out.filter((f) => prefixes.some((p) => f.file === p || f.file.startsWith(p + '/')));
  }
  if (opts.onlyRename && opts.onlyRename.length) {
    const set = new Set(opts.onlyRename);
    out = out.filter((f) => (f.olds || []).some((o) => set.has(o)));
  }
  return out;
}

// ── ledger / report ────────────────────────────────────────────────────────

const CATEGORY_ORDER = [
  { key: 'provable-rooted', label: 'Safe fix (rooted)', match: (f) => f.category === 'provable' && f.sub === 'rooted' },
  { key: 'provable-resolved', label: 'Safe fix (resolved)', match: (f) => f.category === 'provable' && f.sub === 'resolved' },
  { key: 'dirmove', label: 'Dir-move (path-only)', match: (f) => f.category === 'dirmove' },
  { key: 'ignored', label: 'Ignored (elsewhere)', match: (f) => f.category === 'ignored' },
  { key: 'amb-unique', label: 'Ambiguous (unique)', match: (f) => f.category === 'ambiguous' && f.sub === 'unique' },
  { key: 'amb-collision', label: 'Ambiguous (collision)', match: (f) => f.category === 'ambiguous' && f.sub === 'collision' },
  { key: 'amb-variable', label: 'Ambiguous (variable)', match: (f) => f.category === 'ambiguous' && f.sub === 'variable' },
  { key: 'amb-extless', label: 'Ambiguous (extless)', match: (f) => f.category === 'ambiguous' && f.sub === 'extless' },
  { key: 'deleted', label: 'Deleted ref', match: (f) => f.category === 'deleted' },
];

function describeFinding(f) {
  switch (f.category) {
    case 'provable':
      if (f.sub === 'rooted') return `(${f.entry.old} -> ${f.entry.new})`;
      return `(${f.token}  ->  ${f.newToken})     [anchor: ${f.anchor}]`;
    case 'dirmove':
      return `(${f.entry.old} -> ${f.entry.new})`;
    case 'ignored':
      return `(${f.base} resolves to ${f.resolved} — not renamed)`;
    case 'deleted':
      return `(${f.entry.old} — deleted, no target)`;
    case 'ambiguous':
      if (f.sub === 'unique') {
        const e = (f.entries || [])[0];
        return e ? `(${e.old} -> ${e.new})          [forceable]` : `(${f.base} — no target)`;
      }
      if (f.sub === 'collision') {
        const { chosen, alternatives } = { chosen: (f.entries || [])[0], alternatives: (f.entries || []).slice(1) };
        const alts = alternatives.map((a) => a.new).join(', ');
        return `(${f.base} -> ${chosen ? chosen.new : '?'}${alts ? ' | alt: ' + alts : ''})`;
      }
      if (f.sub === 'variable') return `(${f.token} — variable, unresolvable)`;
      if (f.sub === 'extless') return `(${f.token} — stem '${f.stem}', never auto-fixed)`;
      return `(${f.token})`;
    default:
      return `(${f.token || f.base})`;
  }
}

function buildLedger(findings, parsed, ctx) {
  const L = [];
  const push = (s = '') => L.push(s);
  const bar = '='.repeat(80);

  push(bar);
  push('tpm-fix-git-rename-refs — identify');
  push(bar);
  push(`status file : ${ctx.statusFile}`);
  push(`scan root   : ${ctx.scanRoot}`);
  push(`generated   : ${ctx.timestamp}`);
  push(`files scanned: ${ctx.stats.filesScanned} | binary skipped: ${ctx.stats.binarySkipped} | ` +
       `symlinks skipped: ${ctx.stats.symlinksSkipped} | excluded: ${ctx.stats.excluded}`);
  push('');

  push('--- Findings ' + '-'.repeat(67));
  const counts = {};
  for (const cat of CATEGORY_ORDER) {
    const items = findings.filter(cat.match);
    counts[cat.key] = items.length;
    if (!items.length) continue;
    for (const f of items) {
      push(`${(cat.label + ':').padEnd(23)} ${f.file}:${f.line}  ${describeFinding(f)}`);
    }
  }
  if (!findings.length) push('(no references found)');
  push('');

  // Summary
  const total = findings.length;
  const distinctFiles = new Set(findings.map((f) => f.file)).size;
  const renameCount = parsed.entries.filter((e) => e.kind === 'rename').length;
  const deleteCount = parsed.entries.filter((e) => e.kind === 'delete').length;
  const deadEntries = parsed.entries.filter((e) => !ctx.referenced.has(e.old));

  const provable = counts['provable-rooted'] + counts['provable-resolved'];
  const ambiguous = counts['amb-unique'] + counts['amb-collision'] + counts['amb-variable'] + counts['amb-extless'];

  push('--- Summary ' + '-'.repeat(68));
  for (const cat of CATEGORY_ORDER) {
    push(`${(cat.label).padEnd(22)}: ${counts[cat.key]}`);
  }
  push('--');
  push(`total findings        : ${total}`);
  push(`distinct files        : ${distinctFiles}`);
  push(`entries parsed        : ${renameCount} renames, ${deleteCount} deletes`);
  push(`renames with no refs  : ${deadEntries.length}${deadEntries.length ? '  (' + deadEntries.map((e) => e.old).join(', ') + ')' : ''}`);
  push('--');
  push(`Provable ${provable} · Dir-move ${counts['dirmove']} · Ambiguous ${ambiguous} · ` +
       `Deleted ${counts['deleted']} · Ignored ${counts['ignored']}`);
  push('');

  return {
    text: L.join('\n'),
    counts: {
      rootedSafe: counts['provable-rooted'],
      resolvedSafe: counts['provable-resolved'],
      dirmove: counts['dirmove'],
      ignored: counts['ignored'],
      ambiguousUnique: counts['amb-unique'],
      ambiguousCollision: counts['amb-collision'],
      ambiguousVariable: counts['amb-variable'],
      ambiguousExtless: counts['amb-extless'],
      deleted: counts['deleted'],
      provable, ambiguous, total, distinctFiles,
      deadEntries: deadEntries.length,
    },
  };
}

function findingToJSON(f) {
  const out = { file: f.file, line: f.line, category: f.category };
  if (f.sub) out.sub = f.sub;
  if (f.anchor) out.anchor = f.anchor;
  if (f.token) out.token = f.token;
  if (f.base) out.base = f.base;
  if (f.newToken) out.newToken = f.newToken;
  if (f.resolved) out.resolved = f.resolved;
  if (f.stem) out.stem = f.stem;
  if (f.entry) out.target = { old: f.entry.old, new: f.entry.new, kind: f.entry.kind };
  if (f.entries) out.candidates = f.entries.map((e) => ({ old: e.old, new: e.new }));
  if (f.escape) out.escape = true;
  if (f.category === 'ambiguous') {
    out.itemId = computeItemId(f);
    // Verifier note #1: the ambiguous worklist filters on `category==='ambiguous'` and thereby EXCLUDES
    // the `dirmove` category — which is correct, because a finding only lands in `dirmove` when a
    // rooted/relative reference RESOLVED onto a dir-move rename (i.e. it is Provable-by-path and the fix
    // pass rewrites it). An *unfixable* bare mention of a dir-moved file never reaches `dirmove`; it is
    // classified `ambiguous` (bare basename) and so is already in this worklist. We flag those here so
    // the 3rd mechanism knows a blind basename swap is a NO-OP for them (see `dirmoveOnly`).
    const cands = f.entries || [];
    if (cands.length && cands.every((e) => e.oldBase === e.newBase)) out.dirmoveOnly = true;
  }
  return out;
}

// ── fix / apply-plan engine (Phase 2: mutating) ───────────────────────────────

// Tracks ONLY the temp files this run created, so cleanup deletes only ours (Decision F / §17.1). A
// pre-existing temp is never claimed, overwritten, deleted, or reported as an error.
function makeTempTracker() {
  const created = new Set();
  return {
    // Claim a temp path by writing `buf` to it. Returns false (claim refused) if it already exists —
    // the caller must then skip the whole file, touching nothing.
    claim(tmpAbs, buf) {
      if (fs.existsSync(tmpAbs)) return false;
      fs.writeFileSync(tmpAbs, buf);
      created.add(tmpAbs);
      return true;
    },
    drop(tmpAbs) {
      if (created.has(tmpAbs)) { try { fs.unlinkSync(tmpAbs); } catch { /* leftover */ } created.delete(tmpAbs); }
    },
    // Delete every temp we still own; return the list of OUR temps we failed to delete (reported).
    cleanup() {
      const leftover = [];
      for (const t of [...created]) { try { fs.unlinkSync(t); } catch { leftover.push(t); } created.delete(t); }
      return leftover;
    },
  };
}

// Group Provable findings into per-file, de-duplicated {old,new} substitution records. Only 'provable'
// findings (with a computed newToken) produce substitutions; longest-OLD-first ordering is applied at
// write time (§10) by applyProvableSubs.
function planProvableSubs(findings) {
  const byFile = new Map();
  for (const f of findings) {
    // 'dirmove' is Provable-by-path for the fix pass (see scanContent note); it always has a newToken.
    if ((f.category !== 'provable' && f.category !== 'dirmove') || !f.newToken) continue;
    if (!byFile.has(f.file)) byFile.set(f.file, { subs: [], seen: new Set(), lines: [] });
    const rec = byFile.get(f.file);
    const key = f.token + '\0' + f.newToken;
    if (!rec.seen.has(key)) { rec.seen.add(key); rec.subs.push({ old: f.token, new: f.newToken, entry: f.entry }); }
    rec.lines.push(f.line);
  }
  return byFile;
}

// Plan the --force blind basename swaps (§8). One record per ambiguous basename: the first-in-status
// winner (pickForce), its alternatives (for the auditable candidate dump), whether the winner is a
// dir-move (basename unchanged → a swap is a NO-OP), and which files/lines it touches. Extensionless
// findings are excluded entirely — never fixed even under --force (Decision A).
function planForce(findings, byBasename) {
  const byBase = new Map();
  for (const f of findings) {
    if (f.category !== 'ambiguous' || f.sub === 'extless' || !f.base) continue;
    const pick = pickForce(f.base, byBasename);
    if (!pick.chosen) continue;
    if (!byBase.has(f.base)) {
      byBase.set(f.base, {
        base: f.base, oldBase: pick.chosen.oldBase, newBase: pick.chosen.newBase,
        chosen: pick.chosen, alternatives: pick.alternatives,
        dirmove: pick.chosen.oldBase === pick.chosen.newBase,
        files: new Set(), occurrences: [],
      });
    }
    const rec = byBase.get(f.base);
    rec.files.add(f.file);
    rec.occurrences.push({ file: f.file, line: f.line });
  }
  return byBase;
}

// Load an itemId allowlist for --suppress (§18.1). Accepts a bare array of ids, or an object with a
// `suppressed` / `items` / `disposed` array of ids or {itemId} records.
function loadSuppress(p) {
  if (!p) return new Set();
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw.suppressed) ? raw.suppressed
      : Array.isArray(raw.items) ? raw.items
        : Array.isArray(raw.disposed) ? raw.disposed : [];
  const set = new Set();
  for (const it of list) set.add(typeof it === 'string' ? it : it && it.itemId);
  return set;
}

// The --fail-on-ambiguous gate (§18.1). Returns the count of ambiguous refs a human still must resolve
// after subtracting suppressed itemIds and (under --force) the ones --force would rewrite.
function ambiguousGate(findings, suppressSet, force) {
  let remaining = findings.filter((f) => f.category === 'ambiguous');
  if (force) {
    remaining = remaining.filter((f) => {
      if (f.sub === 'extless') return true;               // never fixed
      const cands = f.entries || [];
      return cands.length > 0 && cands.every((e) => e.oldBase === e.newBase); // dir-move winner: no-op
    });
  }
  const items = remaining.filter((f) => !suppressSet.has(computeItemId(f)));
  return { totalAmbiguous: remaining.length, remaining: items.length, items };
}

// Test-only fault injection (documented deviation): when the env var names a scan-root-relative file,
// its edited content is deliberately corrupted so the §9 strict assertion fires — the ONLY hermetic way
// to exercise the abort-and-restore rails against an otherwise-correct writer. No effect unless set.
function maybeInjectCorrupt(fileRel, text) {
  return process.env.TPM_FIX_GIT_RENAME_TEST_CORRUPT === fileRel ? text + '!' : text;
}

// Classify a caught filesystem write error into the per-file failure reason routed through the exit-4
// path (§9 / §17.1): a permission problem (read-only original, unwritable containing dir) becomes
// 'eacces', anything else 'write-error'. A raw EACCES no longer escapes uncaught.
function classifyWriteError(e) {
  return (e && (e.code === 'EACCES' || e.code === 'EPERM')) ? 'eacces' : 'write-error';
}

// Best-effort check that the on-disk file is still byte-identical to `buf` (used to report `restored`
// after a graceful write-error abort). A failed open-for-write truncates nothing, so a read-only
// original / unwritable dir leaves the original intact; if the file can't even be read back, false.
function fileEquals(absFile, buf) {
  try { return fs.readFileSync(absFile).equals(buf); } catch { return false; }
}

// Process ONE file for `fix`. Returns a result record; performs all snapshot/verify/edit/assert/restore
// rails. Never touches the original in --dry mode.
function processFixFile(file, scanRoot, provRec, forceRecs, opts, tracker) {
  const absFile = path.join(scanRoot, file);
  const provSubs = (provRec && provRec.subs) || [];
  const forceSubs = (forceRecs || [])
    .filter((r) => !r.dirmove && r.oldBase !== r.newBase)
    .map((r) => ({ old: r.oldBase, new: r.newBase }))
    .sort((a, b) => b.old.length - a.old.length);
  // Decision C, refined to PER-SUBSTITUTION granularity: the strict assertion runs whenever this file
  // has PROVABLE subs to protect (even if it ALSO gets forced swaps). assertProvableExemptForced then
  // asserts the provable regions while letting the forced-basename changes through unasserted. A file
  // with ONLY forced subs (nothing provable to protect) stays exempt, exactly as before.
  const assertProvable = provSubs.length > 0;

  // never fix through a symlink (Decision G)
  let lst;
  try { lst = fs.lstatSync(absFile); } catch { return { file, status: 'failed', reason: 'missing' }; }
  if (lst.isSymbolicLink()) return { file, status: 'skipped', reason: 'symlink' };

  const tmpNames = opts.dry ? [absFile + '.tmp1', absFile + '.tmp2'] : [absFile + '.tmp'];
  for (const t of tmpNames) {
    if (fs.existsSync(t)) return { file, status: 'skipped', reason: 'temp-collision', temp: path.basename(t) };
  }

  const originalBuf = fs.readFileSync(absFile);
  const originalText = originalBuf.toString('utf8');

  // new-target-exists lint (§17.1) — applies to the Provable set (the map-asserted rewrites).
  for (const s of provSubs) {
    if (!s.entry || !s.entry.new) continue;
    if (!fs.existsSync(path.join(scanRoot, s.entry.new))) {
      return { file, status: 'failed', reason: 'new-target-missing', target: s.entry.new };
    }
  }

  // compute modified content (Provable first, longest-first; then blind force basename swaps)
  let modified = originalText;
  if (provSubs.length) modified = applyProvableSubs(modified, provSubs);
  for (const s of forceSubs) modified = basenameSafeReplace(modified, s.old, s.new);
  modified = maybeInjectCorrupt(file, modified);

  const nSubs = provSubs.length + forceSubs.length;

  // Per-edit detail for the machine-readable run report (§11): one entry per distinct substitution rule
  // applied to this file, each with its occurrence count. `nSubs` (the human "N substitution(s)" tally)
  // equals edits.length, keeping the JSON and the human summary in lock-step.
  const edits = [];
  for (const s of provSubs) edits.push({ old: s.old, new: s.new, forced: false, occurrence: countBoundarySafe(originalText, s.old) });
  for (const s of forceSubs) edits.push({ old: s.old, new: s.new, forced: true, occurrence: countBasenameHits(originalText, s.old) });

  if (modified === originalText) return { file, status: 'unchanged', subs: nSubs };

  if (opts.dry) {
    const [t1, t2] = tmpNames;
    try {
      if (!tracker.claim(t1, originalBuf)) return { file, status: 'skipped', reason: 'temp-collision', temp: path.basename(t1) };
      if (!tracker.claim(t2, originalBuf)) { tracker.drop(t1); return { file, status: 'skipped', reason: 'temp-collision', temp: path.basename(t2) }; }
      if (!fs.readFileSync(t1).equals(originalBuf) || !fs.readFileSync(t2).equals(originalBuf)) {
        return { file, status: 'failed', reason: 'snapshot-mismatch' };
      }
      fs.writeFileSync(t1, Buffer.from(modified, 'utf8')); // preview on tmp1 only; original untouched
    } catch (e) {
      // A snapshot/preview write failed (e.g. unwritable containing dir). Convert to a graceful per-file
      // failure (exit-4 path); the original is never touched in --dry, drop any temp we did claim.
      tracker.drop(t1); tracker.drop(t2);
      return { file, status: 'failed', reason: classifyWriteError(e), restored: fileEquals(absFile, originalBuf), dry: true };
    }
    if (assertProvable) {
      const a = assertProvableExemptForced(originalText, fs.readFileSync(t1).toString('utf8'), provSubs, forceSubs);
      if (!a.ok) return { file, status: 'failed', reason: a.reason, line: a.line, dry: true };
    }
    return { file, status: 'would-change', subs: nSubs, forced: forceSubs.length > 0, dry: true, edits };
  }

  // real fix
  const tmp = tmpNames[0];
  let snap;
  try {
    if (!tracker.claim(tmp, originalBuf)) return { file, status: 'skipped', reason: 'temp-collision', temp: path.basename(tmp) };
    snap = fs.readFileSync(tmp);
  } catch (e) {
    // The pristine snapshot write failed (e.g. an unwritable containing dir can't hold `<file>.tmp`).
    // We never edited the original, so it is byte-identical; drop any temp and report a graceful abort.
    tracker.drop(tmp);
    return { file, status: 'failed', reason: classifyWriteError(e), restored: fileEquals(absFile, originalBuf) };
  }
  if (!snap.equals(originalBuf)) { tracker.drop(tmp); return { file, status: 'failed', reason: 'snapshot-mismatch' }; }

  try {
    fs.writeFileSync(absFile, Buffer.from(modified, 'utf8')); // edit in place
  } catch (e) {
    // The in-place write failed (e.g. a read-only original). The failed open truncates nothing, so the
    // original is left byte-identical; drop our snapshot and report a graceful per-file exit-4 abort
    // instead of crashing the whole batch with a raw EACCES stack.
    tracker.drop(tmp);
    return { file, status: 'failed', reason: classifyWriteError(e), restored: fileEquals(absFile, originalBuf) };
  }
  if (assertProvable) {
    const edited = fs.readFileSync(absFile).toString('utf8');
    const a = assertProvableExemptForced(originalText, edited, provSubs, forceSubs);
    if (!a.ok) {
      fs.writeFileSync(absFile, snap); // restore from pristine snapshot
      const restoreOk = fs.readFileSync(absFile).equals(originalBuf);
      tracker.drop(tmp);
      return { file, status: 'failed', reason: a.reason, line: a.line, restored: restoreOk };
    }
  }
  tracker.drop(tmp); // success removes our snapshot
  return { file, status: 'changed', subs: nSubs, forced: forceSubs.length > 0, edits };
}

// Build the machine-readable application report (§11 / Decision K). Both `fix`/`fix --dry` and
// `apply-plan` construct their `fields` and route through here, so the three verbs emit one consistent
// JSON dialect: a fixed envelope (tool/version/mode/meta/summary/applied/skipped/failed/forceChoices/
// exitCode). Per-verb specifics live inside the arrays' entries, never in the top-level shape.
function buildApplicationReport(fields) {
  return {
    tool: 'tpm-fix-git-rename-refs',
    toolVersion: TOOL_VERSION,
    mode: fields.mode,
    meta: fields.meta,
    summary: fields.summary,
    applied: fields.applied || [],
    skipped: fields.skipped || [],
    failed: fields.failed || [],
    forceChoices: fields.forceChoices || [],
    exitCode: fields.exitCode,
  };
}

function runFix(opts) {
  let statusText;
  try { statusText = fs.readFileSync(opts.statusFile, 'utf8'); }
  catch (e) { process.stderr.write(`error: cannot read status file: ${opts.statusFile}\n${e.message}\n`); return 1; }

  const parsed = parseStatus(statusText);
  for (const w of parsed.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!parsed.entries.length) { process.stderr.write(`error: no rename/delete entries parsed from ${opts.statusFile}\n`); return 1; }

  const scanRoot = path.resolve(opts.scanRoot);
  const statusBasename = path.basename(opts.statusFile);
  const { findings: allFindings } = scanTree(scanRoot, parsed, { excludes: opts.excludes, statusBasename });
  const findings = applyScoping(allFindings, opts);
  disambiguateItemIds(findings); // stabilize content-anchored ids so the gate matches identify's worklist

  const provableByFile = planProvableSubs(findings);
  const forceByBase = opts.force ? planForce(findings, parsed.byBasename) : new Map();

  // map file -> [force records touching it]
  const forceByFile = new Map();
  for (const rec of forceByBase.values()) {
    for (const fl of rec.files) { if (!forceByFile.has(fl)) forceByFile.set(fl, []); forceByFile.get(fl).push(rec); }
  }

  const files = [...new Set([...provableByFile.keys(), ...forceByFile.keys()])].sort();

  const L = [];
  const push = (s = '') => L.push(s);
  const bar = '='.repeat(80);
  const mode = `fix${opts.dry ? ' --dry' : ''}${opts.force ? ' --force' : ''}`;
  const timestamp = new Date().toISOString();
  push(bar); push(`tpm-fix-git-rename-refs — ${mode}`); push(bar);
  push(`status file : ${opts.statusFile}`);
  push(`scan root   : ${scanRoot}`);
  push(`generated   : ${timestamp}`);
  push('');

  const tracker = makeTempTracker();
  const results = [];
  let leftover = [];
  try {
    // --force candidate audit: print every candidate with its full OLD -> NEW status line (Decision B),
    // and call out dir-move winners (a blind basename swap is a no-op for them).
    if (opts.force && forceByBase.size) {
      push('--- Force (blind basename swap) ' + '-'.repeat(48));
      for (const rec of forceByBase.values()) {
        const nOcc = rec.occurrences.length;
        push(`[--force] Ambiguous basename \`${rec.base}\` — ${nOcc} occurrence(s) in ${rec.files.size} file(s)`);
        push('  Candidates (status-file order — first wins):');
        const all = [rec.chosen, ...rec.alternatives];
        all.forEach((c, idx) => {
          const mark = idx === 0 ? '   ◀ CHOSEN' : '';
          push(`    ${idx + 1}. ${c.old}  ->  ${c.new}${mark}`);
          if (idx === 0 && rec.dirmove) push('       ⚠ basename unchanged (directory move) — a basename-global swap is a NO-OP');
        });
        if (rec.dirmove) {
          push('    Result: NO textual fix applied (chosen candidate\'s basename did not change). Affected:');
          for (const o of rec.occurrences) push(`      ${o.file}:${o.line}`);
        } else {
          push(`    Applying (basename-global, NOT diff-asserted):  ${rec.oldBase} -> ${rec.newBase}`);
        }
      }
      push('');
    }

    push('--- Files ' + '-'.repeat(70));
    for (const file of files) {
      const r = processFixFile(file, scanRoot, provableByFile.get(file), forceByFile.get(file), opts, tracker);
      results.push(r);
      switch (r.status) {
        case 'changed': push(`changed: ${file}  (${r.subs} substitution(s)${r.forced ? ', incl. forced' : ''})`); break;
        case 'would-change': push(`would-change: ${file}  (${r.subs} substitution(s)${r.forced ? ', incl. forced' : ''})`); break;
        case 'skipped': push(`skipped: ${file}  (${r.reason === 'temp-collision' ? r.temp + ' already exists — refusing to overwrite a pre-existing file' : r.reason})`); break;
        case 'failed': push(`failed: ${file}  (${r.reason}${r.line ? ' @line ' + r.line : ''}${r.target ? ' -> ' + r.target : ''}${r.restored !== undefined ? ', restored=' + r.restored : ''})`); break;
        case 'unchanged': /* nothing to report */ break;
        default: break;
      }
    }
    push('');
  } finally {
    leftover = tracker.cleanup(); // removes any --dry temps and any of OUR snapshots left over
  }

  const changed = results.filter((r) => r.status === 'changed' || r.status === 'would-change');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  push('--- Summary ' + '-'.repeat(68));
  push(`files ${opts.dry ? 'would change' : 'changed'} : ${changed.length}`);
  push(`files skipped      : ${skipped.length}`);
  push(`files failed       : ${failed.length}`);
  if (leftover.length) push(`our temp leftovers : ${leftover.length}  (${leftover.map((t) => path.basename(t)).join(', ')})`);

  // --fail-on-ambiguous gate (§18.1)
  let gateTripped = false;
  let ambiguousRemaining = null;
  if (opts.failOnAmbiguous) {
    let suppress = new Set();
    try { suppress = loadSuppress(opts.suppress); }
    catch (e) { process.stderr.write(`warning: could not read suppress file: ${e.message}\n`); }
    const gate = ambiguousGate(findings, suppress, opts.force);
    push(`ambiguous remaining: ${gate.remaining}${suppress.size ? ' (after ' + suppress.size + ' suppressed)' : ''}`);
    ambiguousRemaining = gate.remaining;
    gateTripped = gate.remaining > 0;
  }
  push('');

  let exitCode = 0;
  if (failed.length || leftover.length) exitCode = 4;   // a file failed its assertion / lint (aborted+restored)
  else if (gateTripped) exitCode = 5;                    // ambiguous refs remain (CI gate)

  const out = L.join('\n') + '\n';
  process.stdout.write(out);
  if (opts.log) {
    try { fs.writeFileSync(opts.log, out, 'utf8'); process.stderr.write(`log written to: ${opts.log}\n`); }
    catch (e) { process.stderr.write(`warning: could not write log: ${e.message}\n`); }
  }

  // --json run report (Decision K / §11): a machine-readable version of everything above, in the same
  // dialect as the apply-plan application report. Written to a fixed artifact file (like identify's
  // result/worklist), and mirrored into --log's companion `.json` when a --log path is given.
  if (opts.json) {
    const forceChoices = [...forceByBase.values()].map((rec) => ({
      base: rec.base,
      chosen: rec.chosen ? { old: rec.chosen.old, new: rec.chosen.new } : null,
      alternatives: rec.alternatives.map((a) => ({ old: a.old, new: a.new })),
      dirmove: rec.dirmove,
      occurrences: rec.occurrences,
    }));
    const applied = [];
    for (const r of changed) {
      for (const e of (r.edits || [])) {
        applied.push({ file: r.file, old: e.old, new: e.new, occurrence: e.occurrence, forced: e.forced, status: opts.dry ? 'would-change' : 'applied' });
      }
    }
    const report = buildApplicationReport({
      mode,
      meta: {
        mode, dry: opts.dry, force: opts.force, failOnAmbiguous: opts.failOnAmbiguous,
        scanRoot, statusFile: opts.statusFile, timestamp, version: TOOL_VERSION,
      },
      summary: {
        filesModified: changed.length,
        dry: opts.dry,
        subsApplied: changed.reduce((a, r) => a + (r.subs || 0), 0),
        filesAborted: failed.length,
        filesSkipped: skipped.length,
        forcedCount: applied.filter((e) => e.forced).length,
        ambiguousRemaining,
      },
      applied,
      skipped: skipped.map((r) => ({ file: r.file, reason: r.reason, ...(r.temp ? { temp: r.temp } : {}) })),
      failed: failed.map((r) => ({
        file: r.file, reason: r.reason,
        ...(r.line ? { line: r.line } : {}),
        ...(r.target ? { target: r.target } : {}),
        ...(r.restored !== undefined ? { restored: r.restored } : {}),
      })),
      forceChoices,
      exitCode,
    });
    const reportPath = path.join(process.cwd(), 'tpm-fix-git-rename-refs-fix-report.json');
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      process.stderr.write(`fix report written to: ${reportPath}\n`);
    } catch (e) { process.stderr.write(`warning: could not write fix report: ${e.message}\n`); }
    if (opts.log) {
      const logJson = opts.log.replace(/\.[^./]*$/, '') + '.json';
      try { fs.writeFileSync(logJson, JSON.stringify(report, null, 2) + '\n', 'utf8'); }
      catch (e) { process.stderr.write(`warning: could not write log json: ${e.message}\n`); }
    }
  }

  return exitCode;
}

// ── apply-plan (§18) ──────────────────────────────────────────────────────────

function runApplyPlan(opts) {
  let planRaw;
  try { planRaw = fs.readFileSync(opts.statusFile, 'utf8'); }
  catch (e) { process.stderr.write(`error: cannot read plan file: ${opts.statusFile}\n${e.message}\n`); return 1; }
  let plan;
  try { plan = JSON.parse(planRaw); }
  catch (e) { process.stderr.write(`error: plan is not valid JSON: ${e.message}\n`); return 1; }
  const edits = Array.isArray(plan) ? plan : (plan.edits || plan.items || []);
  if (!edits.length) { process.stderr.write('error: plan has no edits\n'); return 1; }

  const scanRoot = path.resolve(opts.scanRoot);
  const timestamp = new Date().toISOString();
  const tracker = makeTempTracker();
  const report = { applied: [], skippedStale: [], skippedNotfound: [], failed: [] };

  const byFile = new Map();
  for (const e of edits) { if (!byFile.has(e.file)) byFile.set(e.file, []); byFile.get(e.file).push(e); }

  const L = [];
  const push = (s = '') => L.push(s);
  const bar = '='.repeat(80);
  push(bar); push(`tpm-fix-git-rename-refs — apply-plan${opts.dry ? ' --dry' : ''}`); push(bar);
  push(`plan file : ${opts.statusFile}`);
  push(`scan root : ${scanRoot}`);
  push('');

  let leftover = [];
  try {
    for (const file of [...byFile.keys()].sort()) {
      const fileEdits = byFile.get(file);
      const absFile = path.join(scanRoot, file);
      let lst;
      try { lst = fs.lstatSync(absFile); }
      catch { for (const e of fileEdits) report.skippedNotfound.push({ itemId: e.itemId, file, reason: 'file-missing' }); continue; }
      if (lst.isSymbolicLink()) { for (const e of fileEdits) report.failed.push({ itemId: e.itemId, file, reason: 'symlink' }); continue; }

      const tmpNames = opts.dry ? [absFile + '.tmp1', absFile + '.tmp2'] : [absFile + '.tmp'];
      if (tmpNames.some((t) => fs.existsSync(t))) {
        for (const e of fileEdits) report.failed.push({ itemId: e.itemId, file, reason: 'temp-collision' });
        continue;
      }

      const originalBuf = fs.readFileSync(absFile);
      const originalText = originalBuf.toString('utf8');
      const curHash = hashContent(originalBuf);
      const lines = originalText.split('\n');

      // Validate every edit against the ORIGINAL (staleness, expected-text @ occurrence, new-target).
      const validated = [];
      for (const e of fileEdits) {
        if (e.expectHash && e.expectHash !== curHash) { report.skippedStale.push({ itemId: e.itemId, file, reason: 'stale-hash' }); continue; }
        const ln = e.anchor && e.anchor.line;
        if (!ln || ln < 1 || ln > lines.length) { report.skippedNotfound.push({ itemId: e.itemId, file, reason: 'bad-line' }); continue; }
        const lineText = lines[ln - 1];
        let col;
        if (e.anchor.col != null) {
          col = e.anchor.col - 1;
          if (lineText.substr(col, e.oldText.length) !== e.oldText) { report.skippedNotfound.push({ itemId: e.itemId, file, reason: 'text-mismatch' }); continue; }
        } else {
          const occ = e.anchor.occurrence || 1;
          // Boundary/uniqueness guard: only a standalone-token occurrence counts, so a substring buried
          // inside a larger token (e.g. `config.js` inside `myconfig.js`) is never targeted.
          const idx = findBoundedOccurrence(lineText, e.oldText, occ);
          if (idx === -1) { report.skippedNotfound.push({ itemId: e.itemId, file, reason: 'occurrence-not-found' }); continue; }
          col = idx;
        }
        // new-target-exists: only when newText is a resolvable rooted/relative path (bare basenames skip)
        const rr = resolveRef(e.newText, file);
        if ((rr.anchor === 'rooted' || rr.anchor === 'relative') && rr.resolved && !fs.existsSync(path.join(scanRoot, rr.resolved))) {
          report.failed.push({ itemId: e.itemId, file, reason: 'new-target-missing', target: rr.resolved }); continue;
        }
        validated.push({ e, ln, col });
      }
      if (!validated.length) continue;

      // Apply on the original lines, right-to-left (line desc, col desc) so earlier offsets never shift,
      // and never re-match a freshly written token.
      validated.sort((a, b) => b.ln - a.ln || b.col - a.col);
      const workLines = lines.slice();
      const okEdits = [];
      for (const v of validated) {
        const lt = workLines[v.ln - 1];
        if (lt.substr(v.col, v.e.oldText.length) !== v.e.oldText) { report.failed.push({ itemId: v.e.itemId, file, reason: 'shifted-overlap' }); continue; }
        workLines[v.ln - 1] = lt.slice(0, v.col) + v.e.newText + lt.slice(v.col + v.e.oldText.length);
        okEdits.push(v);
      }
      if (!okEdits.length) continue;
      const modified = workLines.join('\n');

      // Write via the shared rails (snapshot + verify, byte-exact, cleanup-only-ours). Write/permission
      // errors on the snapshot (claim), the --dry preview write, or the in-place write (a read-only
      // original, an unwritable containing dir) are caught and converted to a graceful per-edit failure
      // routed through apply-plan's EXISTING failure path (exit 6) — mirroring the fix verb's §9/§17.1
      // hardening — so one unwritable file is reported instead of crashing the whole batch with a raw
      // EACCES stack. A failed open-for-write truncates nothing, so the original stays byte-identical and
      // any temp we claimed is dropped.
      try {
        if (opts.dry) {
          const [t1, t2] = tmpNames;
          if (!tracker.claim(t1, originalBuf) || !tracker.claim(t2, originalBuf)) {
            for (const v of okEdits) report.failed.push({ itemId: v.e.itemId, file, reason: 'temp-collision' });
            continue;
          }
          fs.writeFileSync(t1, Buffer.from(modified, 'utf8')); // original untouched
        } else {
          const tmp = tmpNames[0];
          if (!tracker.claim(tmp, originalBuf)) { for (const v of okEdits) report.failed.push({ itemId: v.e.itemId, file, reason: 'temp-collision' }); continue; }
          if (!fs.readFileSync(tmp).equals(originalBuf)) { tracker.drop(tmp); for (const v of okEdits) report.failed.push({ itemId: v.e.itemId, file, reason: 'snapshot-mismatch' }); continue; }
          fs.writeFileSync(absFile, Buffer.from(modified, 'utf8'));
          tracker.drop(tmp);
        }
      } catch (e) {
        for (const t of tmpNames) tracker.drop(t);
        const reason = classifyWriteError(e);
        const restored = fileEquals(absFile, originalBuf);
        for (const v of okEdits) report.failed.push({ itemId: v.e.itemId, file, reason, restored });
        continue;
      }
      for (const v of okEdits) report.applied.push({ itemId: v.e.itemId, file, line: v.ln });
    }
  } finally {
    leftover = tracker.cleanup();
  }

  push('--- Application report ' + '-'.repeat(57));
  push(`applied          : ${report.applied.length}`);
  push(`skipped-stale    : ${report.skippedStale.length}`);
  push(`skipped-notfound : ${report.skippedNotfound.length}`);
  push(`failed           : ${report.failed.length}`);
  for (const a of report.applied) push(`  applied   ${a.file}:${a.line}  [${a.itemId}]`);
  for (const s of report.skippedStale) push(`  stale     ${s.file}  [${s.itemId}]`);
  for (const s of report.skippedNotfound) push(`  notfound  ${s.file}  [${s.itemId}] (${s.reason})`);
  for (const s of report.failed) push(`  failed    ${s.file}  [${s.itemId}] (${s.reason}${s.restored !== undefined ? ', restored=' + s.restored : ''})`);
  if (leftover.length) push(`our temp leftovers : ${leftover.length}`);
  push('');
  push('--- Suppression entries (applied itemIds) ' + '-'.repeat(37));
  for (const a of report.applied) push(`  ${a.itemId}`);
  push('');

  const out = L.join('\n') + '\n';
  process.stdout.write(out);

  // suppression allowlist artifact (feeds --fail-on-ambiguous --suppress)
  if (!opts.dry && report.applied.length) {
    const suppressPath = path.join(process.cwd(), 'tpm-fix-git-rename-refs-suppress.json');
    try {
      fs.writeFileSync(suppressPath, JSON.stringify({ mode: 'apply-plan', generated: new Date().toISOString(), suppressed: report.applied.map((a) => a.itemId) }, null, 2) + '\n', 'utf8');
      process.stderr.write(`suppression list written to: ${suppressPath}\n`);
    } catch (e) { process.stderr.write(`warning: could not write suppression list: ${e.message}\n`); }
  }
  if (opts.log) {
    try { fs.writeFileSync(opts.log, out, 'utf8'); } catch (e) { process.stderr.write(`warning: could not write log: ${e.message}\n`); }
  }

  const bad = report.skippedStale.length + report.skippedNotfound.length + report.failed.length + leftover.length;
  const exitCode = bad ? 6 : 0;

  // --json application report (Decision K / §11): same dialect as the fix run report so fix, fix --dry,
  // and apply-plan are consistent. Written to a fixed artifact file alongside the human report.
  if (opts.json) {
    const mode = `apply-plan${opts.dry ? ' --dry' : ''}`;
    const applied = report.applied.map((a) => ({ file: a.file, line: a.line, itemId: a.itemId, status: opts.dry ? 'would-change' : 'applied' }));
    const jreport = buildApplicationReport({
      mode,
      meta: {
        mode, dry: opts.dry, force: false, failOnAmbiguous: false,
        scanRoot, planFile: opts.statusFile, timestamp, version: TOOL_VERSION,
      },
      summary: {
        filesModified: new Set(report.applied.map((a) => a.file)).size,
        dry: opts.dry,
        subsApplied: report.applied.length,
        filesAborted: report.failed.length,
        filesSkipped: report.skippedStale.length + report.skippedNotfound.length,
        forcedCount: 0,
        ambiguousRemaining: null,
        skippedStale: report.skippedStale.length,
        skippedNotfound: report.skippedNotfound.length,
      },
      applied,
      skipped: [...report.skippedStale, ...report.skippedNotfound].map((s) => ({ file: s.file, itemId: s.itemId, reason: s.reason })),
      failed: report.failed.map((s) => ({ file: s.file, itemId: s.itemId, reason: s.reason, ...(s.target ? { target: s.target } : {}), ...(s.restored !== undefined ? { restored: s.restored } : {}) })),
      forceChoices: [],
      exitCode,
    });
    const reportPath = path.join(process.cwd(), 'tpm-fix-git-rename-refs-apply-report.json');
    try {
      fs.writeFileSync(reportPath, JSON.stringify(jreport, null, 2) + '\n', 'utf8');
      process.stderr.write(`apply-plan report written to: ${reportPath}\n`);
    } catch (e) { process.stderr.write(`warning: could not write apply-plan report: ${e.message}\n`); }
  }

  return exitCode;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    verb: null, statusFile: null,
    scanRoot: process.cwd(),
    excludes: [], only: [], onlyRename: [],
    dry: false, force: false, failOnAmbiguous: false, suppress: null,
    json: false, log: null, help: false,
  };
  if (argv.includes('--help') || argv.includes('-h')) { opts.help = true; return opts; }

  let i = 0;
  const first = argv[0];
  if (first === 'identify' || first === 'fix' || first === 'apply-plan') { opts.verb = first; i = 1; }
  else { const e = new Error(`unknown verb: ${first === undefined ? '(none)' : first}`); e.exitCode = 2; throw e; }

  const need = (flag) => {
    const v = argv[++i];
    if (v === undefined) { const e = new Error(`missing value for ${flag}`); e.exitCode = 2; throw e; }
    return v;
  };

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scan-root') opts.scanRoot = need(a);
    else if (a === '--exclude') opts.excludes.push(need(a));
    else if (a === '--only') opts.only.push(need(a));
    else if (a === '--only-rename') opts.onlyRename.push(need(a));
    else if (a === '--dry') opts.dry = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--fail-on-ambiguous') opts.failOnAmbiguous = true;
    else if (a === '--suppress') opts.suppress = need(a);
    else if (a === '--json') opts.json = true;
    else if (a === '--log') opts.log = need(a);
    else if (a.startsWith('-')) { const e = new Error(`unrecognized option: ${a}`); e.exitCode = 2; throw e; }
    else if (opts.statusFile === null) opts.statusFile = a;
    else { const e = new Error(`unexpected extra argument: ${a}`); e.exitCode = 2; throw e; }
  }

  if (!opts.statusFile) { const e = new Error('missing required <git-status-file>'); e.exitCode = 2; throw e; }
  return opts;
}

function usage() {
  return [
    'tpm-fix-git-rename-refs.js — find & (Phase 2) fix references to renamed/deleted files',
    '',
    'USAGE',
    '  tpm-fix-git-rename-refs.js identify   <git-status-file> [--fail-on-ambiguous] [--suppress <json>] [scoping] [output]',
    '  tpm-fix-git-rename-refs.js fix        <git-status-file> [--dry] [--force] [--fail-on-ambiguous] [--suppress <json>] [scoping] [output]',
    '  tpm-fix-git-rename-refs.js apply-plan <plan.json> [--dry] [--scan-root <dir>] [--log <file>]',
    '  tpm-fix-git-rename-refs.js --help',
    '',
    '  scoping:  [--scan-root <dir>] [--exclude <glob> ...] [--only <path-prefix> ...] [--only-rename <old-path> ...]',
    '  output:   [--json] [--log <file>]',
    '',
    'FLAGS',
    '  --scan-root <dir>       tree to scan (default: current working directory)',
    '  --exclude <glob>        extra path/basename glob to exclude (repeatable)',
    '  --only <path-prefix>    only report/fix refs in files under this subtree (repeatable)',
    '  --only-rename <old>     only chase refs to this renamed/deleted file (repeatable)',
    '  --dry                   preview only, never mutate originals (fix / apply-plan)',
    '  --force                 also rewrite ambiguous refs by blind basename swap (fix)',
    '  --fail-on-ambiguous     exit non-zero if any ambiguous refs remain (identify / fix)',
    '  --suppress <json>       allowlist of disposed itemIds excluded from --fail-on-ambiguous',
    '  --json                  also write machine-readable result + ambiguous worklist JSON',
    '  --log <file>            mirror stdout to a log file',
    '  --help, -h              show this message',
    '',
    'Never calls git. Never shells out to diff. Never follows symlinks. Domain-agnostic.',
    'Exit codes: 0 clean; 2 bad args; 1 status/plan unreadable or empty; 4 a fix file failed its',
    '            safety assertion/lint (aborted+restored); 5 --fail-on-ambiguous gate tripped;',
    '            6 apply-plan had stale/notfound/failed edits.',
    '',
  ].join('\n');
}

function runIdentify(opts) {
  let statusText;
  try { statusText = fs.readFileSync(opts.statusFile, 'utf8'); }
  catch (e) { process.stderr.write(`error: cannot read status file: ${opts.statusFile}\n${e.message}\n`); return 1; }

  const parsed = parseStatus(statusText);
  for (const w of parsed.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!parsed.entries.length) {
    process.stderr.write(`error: no rename/delete entries parsed from ${opts.statusFile}\n`);
    return 1;
  }

  const scanRootAbs = path.resolve(opts.scanRoot);
  const statusBasename = path.basename(opts.statusFile);
  const { findings: allFindings, referenced, stats } = scanTree(scanRootAbs, parsed, {
    excludes: opts.excludes, statusBasename,
  });
  const findings = applyScoping(allFindings, opts);
  disambiguateItemIds(findings); // stabilize content-anchored ids (handles genuine window collisions)

  const timestamp = new Date().toISOString();
  const { text: ledgerText, counts } = buildLedger(findings, parsed, {
    statusFile: opts.statusFile, scanRoot: scanRootAbs, timestamp, stats, referenced,
  });

  const out = ledgerText.endsWith('\n') ? ledgerText : ledgerText + '\n';

  // stdout == ledger file content (notices go to stderr so equality holds).
  process.stdout.write(out);

  const outDir = process.cwd();
  const ledgerPath = path.join(outDir, 'tpm-fix-git-rename-refs-ledger.txt');
  try { fs.writeFileSync(ledgerPath, out, 'utf8'); process.stderr.write(`ledger written to: ${ledgerPath}\n`); }
  catch (e) { process.stderr.write(`warning: could not write ledger: ${e.message}\n`); }

  if (opts.log) {
    try { fs.writeFileSync(opts.log, out, 'utf8'); process.stderr.write(`log written to: ${opts.log}\n`); }
    catch (e) { process.stderr.write(`warning: could not write log: ${e.message}\n`); }
  }

  if (opts.json) {
    const result = {
      mode: 'identify', statusFile: opts.statusFile, scanRoot: scanRootAbs, generated: timestamp,
      stats, counts, findings: findings.map(findingToJSON),
    };
    const worklist = {
      mode: 'identify', generated: timestamp,
      items: findings.filter((f) => f.category === 'ambiguous').map(findingToJSON),
    };
    const resultPath = path.join(outDir, 'tpm-fix-git-rename-refs-result.json');
    const worklistPath = path.join(outDir, 'tpm-fix-git-rename-refs-ambiguous.json');
    try {
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
      fs.writeFileSync(worklistPath, JSON.stringify(worklist, null, 2) + '\n', 'utf8');
      process.stderr.write(`json result written to: ${resultPath}\n`);
      process.stderr.write(`ambiguous worklist written to: ${worklistPath}\n`);
    } catch (e) { process.stderr.write(`warning: could not write json: ${e.message}\n`); }
  }

  // identify is ALWAYS exit 0 (hits are not an error) UNLESS the caller opts into the --fail-on-ambiguous
  // CI gate (§18.1), which may also carry a --suppress allowlist of disposed itemIds.
  if (opts.failOnAmbiguous) {
    let suppress = new Set();
    try { suppress = loadSuppress(opts.suppress); }
    catch (e) { process.stderr.write(`warning: could not read suppress file: ${e.message}\n`); }
    const gate = ambiguousGate(findings, suppress, false);
    if (gate.remaining > 0) {
      process.stderr.write(`--fail-on-ambiguous: ${gate.remaining} ambiguous reference(s) remain` +
        `${suppress.size ? ' after ' + suppress.size + ' suppressed' : ''}\n`);
      return 5;
    }
  }
  return 0;
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { process.stderr.write(`error: ${e.message}\n\n`); process.stderr.write(usage()); return e.exitCode || 2; }

  if (opts.help) { process.stdout.write(usage()); return 0; }

  if (opts.verb === 'identify') return runIdentify(opts);
  if (opts.verb === 'fix') return runFix(opts);
  if (opts.verb === 'apply-plan') return runApplyPlan(opts);

  process.stderr.write('error: no verb\n\n');
  process.stderr.write(usage());
  return 2;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  // parsing / indexing
  parseStatus, unquoteGitPath, buildIndexes,
  // matching / resolution / classification
  matchBasename, matchFullPath, extractToken, resolveRef, classify, rewriteRef,
  // force / extensionless / assertion
  pickForce, detectExtensionless, assertOnlyIntended, assertProvableExemptForced,
  // phase-2 substitution / hashing / ids
  boundarySafeReplace, basenameSafeReplace, applyProvableSubs, countBoundarySafe, countBasenameHits,
  hashContent, computeItemId, normalizeWindowLine, buildContentWindow, disambiguateItemIds,
  findBoundedOccurrence,
  // misc pure helpers
  escapeRegExp, stripExt, globToRegExp,
  // scanning / reporting
  scanTree, applyScoping, buildLedger, findingToJSON, buildApplicationReport,
  // fix / apply-plan engine
  makeTempTracker, planProvableSubs, planForce, loadSuppress, ambiguousGate,
  processFixFile, runFix, runApplyPlan,
  // cli
  parseArgs, usage, main,
};
