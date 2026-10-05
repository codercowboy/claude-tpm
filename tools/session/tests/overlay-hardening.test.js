'use strict';
/**
 * overlay-hardening.test.js — HARDENING tests for the shared layered-config overlay lib (#1152,
 * tools/lib/tpm-config-overlay.js). EXTENDS overlay-config.test.js (the builder's unit test) — it does
 * NOT repeat it. Lives in tools/session/tests/ for the same reason overlay-config.test.js does: this dir
 * already unit-tests the shared tools/lib/* modules and is GLOBBED by the runner-registration audit (so a
 * new file here is reached by `npm test` with zero registration edits).
 *
 * Risky seams pinned here (each would go RED if the behaviour regressed — see HANDOFF mutation probes):
 *   - overlayUserOnto (the resolver-composition input): both-absent -> undefined; project-only -> project;
 *     user-only -> clone(user); both -> user WINS (deep). This is the back-compat contract decision (a).
 *   - deepMerge 3-layer precedence at ONE leaf set in all three layers (user wins over project over default).
 *   - ADDITIVE_ARRAYS empty => real name-keyed workflow arrays REPLACE wholesale (NOT mergeByName) unless
 *     the path is explicitly in the allowlist.
 *   - setPathEx: OUT-OF-RANGE [i] (JSON holes -> null), [i] OVERWRITE (not append), create-intermediate via
 *     [i], and replacing a non-array/non-object slot.
 *   - resolveLayers tolerance END TO END: invalid PROJECT JSON throws EBADJSON; invalid USER JSON warns+skips
 *     and the merge still returns; _comment survives into the raw file but never into the resolved view.
 *   - loadDefaults returns a FRESH, mutation-safe object each call.
 *
 * Run: node tests/overlay-hardening.test.js   (exit non-zero on any failure)
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const o = require('../../lib/tpm-config-overlay');

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}
function projConfig(dir, obj) {
  return writeJson(dir, path.join('.claude', 'claude-tpm', 'config.json'), obj);
}

// ── overlayUserOnto — the resolver composition input (decision (a)) ────────────────────────────────

test('overlayUserOnto: BOTH layers absent -> undefined (so merge<Section>Config(undefined) === getDefaults())', () => {
  // no user env, no project section passed in
  assert.strictEqual(o.overlayUserOnto(undefined, 'tasks', { env: {} }), undefined);
});

test('overlayUserOnto: project present, no user layer -> the project section unchanged', () => {
  const proj = { maxOpenWarn: 7, exportDir: 'out' };
  const r = o.overlayUserOnto(proj, 'tasks', { env: {} });
  assert.deepStrictEqual(r, { maxOpenWarn: 7, exportDir: 'out' });
});

test('overlayUserOnto: user present, no project layer -> a (stripped) clone of the user section', () => {
  const dir = tmpDir('ov-useronly-');
  const uf = writeJson(dir, 'user.json', { tasks: { _comment: 'c', maxOpenWarn: 42 } });
  const r = o.overlayUserOnto(undefined, 'tasks', { env: { CLAUDE_TPM_USER_CONFIG: uf } });
  assert.deepStrictEqual(r, { maxOpenWarn: 42 }, 'user clone, comment stripped');
});

test('overlayUserOnto: both present -> USER WINS at shared leaves, project kept where user is silent (deep)', () => {
  const dir = tmpDir('ov-both-');
  const uf = writeJson(dir, 'user.json', { tasks: { maxOpenWarn: 99, autoConfirm: { finish: true } } });
  const proj = { maxOpenWarn: 10, exportDir: 'proj-out', autoConfirm: { finish: false, drop: false } };
  const r = o.overlayUserOnto(proj, 'tasks', { env: { CLAUDE_TPM_USER_CONFIG: uf } });
  assert.strictEqual(r.maxOpenWarn, 99, 'user wins the shared scalar');
  assert.strictEqual(r.exportDir, 'proj-out', 'project value kept where user is silent');
  assert.deepStrictEqual(r.autoConfirm, { finish: true, drop: false }, 'nested object deep-merged, user wins its key');
});

// ── 3-layer precedence at a single leaf ────────────────────────────────────────────────────────────

test('resolveLayers: a leaf set in ALL THREE layers resolves to the USER value (user > project > default)', () => {
  const projDir = tmpDir('ov-3proj-');
  projConfig(projDir, { tasks: { maxOpenWarn: 10 } });     // default is 50
  const userDir = tmpDir('ov-3user-');
  const uf = writeJson(userDir, 'user.json', { tasks: { maxOpenWarn: 99 } });
  const full = o.resolveLayers({ projectRoot: projDir, env: { CLAUDE_TPM_USER_CONFIG: uf } });
  assert.strictEqual(full.tasks.maxOpenWarn, 99, 'user wins over project wins over default');
  // a leaf set ONLY in project (silent in user) => project wins over default
  const full2 = o.resolveLayers({ section: 'tasks', projectRoot: projDir, env: {} });
  assert.strictEqual(full2.maxOpenWarn, 10, 'project wins over default when user is absent');
  // a leaf nobody overrides => the shipped default survives
  assert.strictEqual(full2.startId, 1000, 'untouched default survives');
});

// ── ADDITIVE_ARRAYS empty => real workflow arrays REPLACE (not mergeByName) ─────────────────────────

test('deepMerge: with the shipped EMPTY allowlist, a name-keyed array REPLACES wholesale (mergeByName is NOT the default)', () => {
  const base = { subagentConfigs: [{ name: 'planning', retryCount: 1 }, { name: 'builder', retryCount: 5 }] };
  const overlay = { subagentConfigs: [{ name: 'builder', retryCount: 9 }] };
  const r = o.deepMerge(base, overlay, { _path: 'workflow' }); // child path workflow.subagentConfigs not in []
  assert.deepStrictEqual(r.subagentConfigs, [{ name: 'builder', retryCount: 9 }],
    'overlay array replaces the base array entirely — planning is dropped, builder is not name-merged');
});

test('deepMerge: blockedFilenamePatterns-style string array REPLACES (no concat) under the empty allowlist', () => {
  const r = o.deepMerge(
    { blockedFilenamePatterns: ['report', 'summary', 'analysis', 'findings'] },
    { blockedFilenamePatterns: ['scratch'] },
    { _path: 'workflow' },
  );
  assert.deepStrictEqual(r.blockedFilenamePatterns, ['scratch'], 'full REPLACE, not concat+dedup');
});

test('concatDedup: by-value dedup keeps first-seen order and de-dups equal objects (the #1153/#1154-ready path)', () => {
  assert.deepStrictEqual(o.concatDedup(['a', 'b'], ['b', 'c', 'a']), ['a', 'b', 'c']);
  assert.deepStrictEqual(o.concatDedup([{ x: 1 }], [{ x: 1 }, { x: 2 }]), [{ x: 1 }, { x: 2 }], 'equal objects dedup by value');
});

// ── setPathEx: out-of-range, overwrite, create-intermediate, slot replacement ───────────────────────

test('setPathEx: OUT-OF-RANGE [i] assigns at that index, leaving JSON holes that serialise to null', () => {
  const obj = { list: ['a'] };
  o.setPathEx(obj, 'list[3]', 'x');
  assert.strictEqual(obj.list.length, 4, 'array grew to the target index + 1');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(obj.list)), ['a', null, null, 'x'], 'holes serialise to null');
});

test('setPathEx: [i] OVERWRITES an existing element (does not append/shift)', () => {
  const obj = { list: ['a', 'b', 'c'] };
  o.setPathEx(obj, 'list[1]', 'Z');
  assert.deepStrictEqual(obj.list, ['a', 'Z', 'c']);
});

test('setPathEx: creates an intermediate array+object via [i] on a non-last segment', () => {
  const a = {};
  o.setPathEx(a, 'a[0].b', 1);
  assert.deepStrictEqual(a, { a: [{ b: 1 }] });
  const b = {};
  o.setPathEx(b, 'teams[1].name', 'ship'); // index 1 on an empty array -> hole at 0
  assert.strictEqual(JSON.parse(JSON.stringify(b.teams))[0], null);
  assert.deepStrictEqual(b.teams[1], { name: 'ship' });
});

test('setPathEx: an indexed key whose current slot is NOT an array is replaced with a fresh array', () => {
  const obj = { a: 5 };
  o.setPathEx(obj, 'a[0]', 'first');
  assert.deepStrictEqual(obj, { a: ['first'] });
});

// ── resolveLayers tolerance, END TO END ─────────────────────────────────────────────────────────────

test('resolveLayers: an invalid PROJECT config.json throws EBADJSON (strict project layer)', () => {
  const projDir = tmpDir('ov-badproj-');
  projConfig(projDir, '{ not: json');
  let code = null;
  try { o.resolveLayers({ projectRoot: projDir, env: {} }); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'EBADJSON', 'project-layer parse failure must surface as EBADJSON, not be swallowed');
});

test('resolveLayers: an invalid USER config warns+skips and the defaults/project merge still returns', () => {
  const projDir = tmpDir('ov-okproj-');
  projConfig(projDir, { tasks: { maxOpenWarn: 11 } });
  const userDir = tmpDir('ov-baduser-');
  const uf = writeJson(userDir, 'user.json', '{ broken');
  const warnings = [];
  const full = o.resolveLayers({
    projectRoot: projDir,
    env: { CLAUDE_TPM_USER_CONFIG: uf },
    warn: (m) => warnings.push(m),
  });
  assert.strictEqual(full.tasks.maxOpenWarn, 11, 'bad user layer ignored; project value survives');
  assert.strictEqual(full.tasks.startId, 1000, 'defaults survive');
  assert.strictEqual(warnings.length, 1, 'exactly one warning emitted for the bad user layer');
  assert.ok(/could not parse/.test(warnings[0]));
});

test('resolveLayers: a project _comment never leaks into the resolved view (comment strip through the merge)', () => {
  const projDir = tmpDir('ov-comment-');
  projConfig(projDir, { _comment: 'project note', tasks: { _comment: 'tasks note', maxOpenWarn: 8 } });
  const full = o.resolveLayers({ projectRoot: projDir, env: {} });
  assert.strictEqual(full.tasks.maxOpenWarn, 8);
  assert.ok(!/_comment|\$comment/.test(JSON.stringify(full)), 'no comment keys in the resolved view');
});

// ── loadDefaults is mutation-safe (resolvers call getDefaults() and may mutate the result) ──────────

test('loadDefaults returns a FRESH object each call — mutating one call does not poison the next', () => {
  const a = o.loadDefaults();
  a.tasks.maxOpenWarn = -1;
  a.workflow.subagentConfigs.push({ name: 'injected' });
  const b = o.loadDefaults();
  assert.strictEqual(b.tasks.maxOpenWarn, 50, 'second load is untouched by the first mutation');
  assert.strictEqual(b.workflow.subagentConfigs.length, 7, 'array not shared across calls');
});

done('overlay-hardening.test');
