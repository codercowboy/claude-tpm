'use strict';
/**
 * overlay-config.test.js — unit tests for the shared layered-config overlay lib (#1152,
 * tools/lib/tpm-config-overlay.js). Lives here because tools/session/tests/ already unit-tests the
 * shared tools/lib/* modules and is GLOBBED by the runner-registration audit (zero registration risk).
 *
 * Asserts: deep-merge of objects; scalar/object/array REPLACE; additive CONCAT+DEDUP behind the
 * allowlist (temp allowlist proves the mechanism; the shipped allowlist holds ONLY the #1155 session arrays);
 * _comment/$comment stripped from the resolved view but round-tripped by setLayer; setPathEx [i]/[+];
 * coerce; loadDefaults section byte-identity vs each resolver's getDefaults; user-layer tolerance
 * (unset/absent/bad-JSON -> warn+skip, never throw) vs project bad-JSON (-> throws EBADJSON).
 *
 * Run: node tests/overlay-config.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const o = require('../../lib/tpm-config-overlay');

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}

// ── deepMerge ────────────────────────────────────────────────────────────────────────────────────

test('deepMerge recurses plain objects; overlay keys win', () => {
  const r = o.deepMerge({ a: 1, n: { x: 1, y: 2 } }, { n: { y: 9, z: 3 }, b: 2 });
  assert.deepStrictEqual(r, { a: 1, n: { x: 1, y: 9, z: 3 }, b: 2 });
});

test('deepMerge REPLACES scalars and objects (later layer wins wholesale)', () => {
  assert.deepStrictEqual(o.deepMerge({ a: 1 }, { a: 5 }), { a: 5 });
  assert.deepStrictEqual(o.deepMerge({ a: { x: 1 } }, { a: 7 }), { a: 7 }); // object -> scalar
  assert.deepStrictEqual(o.deepMerge({ a: 1 }, { a: { x: 1 } }), { a: { x: 1 } }); // scalar -> object
});

test('deepMerge REPLACES arrays by default (shipped empty allowlist)', () => {
  assert.deepStrictEqual(o.deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
  assert.deepStrictEqual(o.ADDITIVE_ARRAYS, ['session.proseInjections', 'session.readingList'],
    'allowlist holds ONLY the #1155 session arrays; every other array REPLACES');
});

test('deepMerge CONCAT+DEDUPs a string array ONLY when its path is in the (temp) allowlist', () => {
  const r = o.deepMerge({ a: [1, 2] }, { a: [2, 3] }, { additiveArrays: ['a'] });
  assert.deepStrictEqual(r, { a: [1, 2, 3] }, 'concat then dedup by value, first-seen order');
});

test('deepMerge additive object arrays merge by name (mergeByName semantics)', () => {
  const r = o.deepMerge(
    { x: [{ name: 'a', v: 1 }, { name: 'b', v: 1 }] },
    { x: [{ name: 'a', v: 2 }, { name: 'c', v: 3 }] },
    { additiveArrays: ['x'] },
  );
  assert.deepStrictEqual(r, { x: [{ name: 'a', v: 2 }, { name: 'b', v: 1 }, { name: 'c', v: 3 }] });
});

test('deepMerge treats undefined layers as no-ops (both undefined -> undefined)', () => {
  assert.deepStrictEqual(o.deepMerge({ a: 1 }, undefined), { a: 1 });
  assert.deepStrictEqual(o.deepMerge(undefined, { a: 1 }), { a: 1 });
  assert.strictEqual(o.deepMerge(undefined, undefined), undefined);
});

// ── comment stripping ───────────────────────────────────────────────────────────────────────────

test('deepMerge / cloneStripped drop _comment and $comment at every level', () => {
  const r = o.deepMerge(
    { _comment: 'top', a: { $comment: 'nested', x: 1 } },
    { b: 2, _comment: 'o' },
  );
  assert.deepStrictEqual(r, { a: { x: 1 }, b: 2 });
  assert.deepStrictEqual(o.cloneStripped({ _comment: 'x', a: [{ $comment: 'y', z: 1 }] }), { a: [{ z: 1 }] });
});

test('loadDefaults strips every comment key from the resolved object', () => {
  const d = o.loadDefaults();
  const json = JSON.stringify(d);
  assert.ok(!/_comment/.test(json) && !/\$comment/.test(json), 'no comment keys survive into the resolved view');
});

// ── loadDefaults byte-identity vs each resolver's getDefaults ──────────────────────────────────────

test('loadDefaults().session deepStrictEqual the session resolver getDefaults()', () => {
  assert.deepStrictEqual(o.loadDefaults().session, require('../../session/tpm-session-config').getDefaults());
});

test('loadDefaults().tasks deepStrictEqual the task resolver getDefaults()', () => {
  assert.deepStrictEqual(o.loadDefaults().tasks, require('../../task/tpm-task-config').getDefaults());
});

test('workflow getDefaults() re-absolutizes each bundle-relative charterFile from loadDefaults()', () => {
  const wf = require('../../workflow/tpm-workflow-config-resolver').getDefaults();
  const raw = o.loadDefaults().workflow;
  wf.subagentConfigs.forEach((sc, i) => {
    assert.ok(path.isAbsolute(sc.charterFile), 'resolved charterFile is absolute');
    assert.ok(sc.charterFile.endsWith(raw.subagentConfigs[i].charterFile), 'absolute ends with the stored bundle-relative tail');
    assert.strictEqual(path.isAbsolute(raw.subagentConfigs[i].charterFile), false, 'stored path is bundle-relative');
  });
  // everything else is byte-identical between the stored and resolved workflow sections
  const rawNoCharters = JSON.parse(JSON.stringify(raw));
  const wfNoCharters = JSON.parse(JSON.stringify(wf));
  rawNoCharters.subagentConfigs.forEach((sc) => { delete sc.charterFile; });
  wfNoCharters.subagentConfigs.forEach((sc) => { delete sc.charterFile; });
  assert.deepStrictEqual(wfNoCharters, rawNoCharters);
});

// ── path grammar: setPathEx / getAtPath ─────────────────────────────────────────────────────────

test('setPathEx creates nested objects and assigns the leaf', () => {
  const obj = {};
  o.setPathEx(obj, 'a.b.c', 42);
  assert.deepStrictEqual(obj, { a: { b: { c: 42 } } });
});

test('setPathEx [i] sets an array element; [+] appends', () => {
  const obj = { list: ['x'] };
  o.setPathEx(obj, 'list[1]', 'y');
  assert.deepStrictEqual(obj.list, ['x', 'y']);
  o.setPathEx(obj, 'list[+]', 'z');
  assert.deepStrictEqual(obj.list, ['x', 'y', 'z']);
  // nested through an array element
  const obj2 = {};
  o.setPathEx(obj2, 'team[+].name', 'full');
  assert.deepStrictEqual(obj2, { team: [{ name: 'full' }] });
});

test('getAtPath reads dotted paths and [i] array indexes; missing -> not found', () => {
  const obj = { a: { b: [10, 20] } };
  assert.deepStrictEqual(o.getAtPath(obj, 'a.b[1]'), { found: true, value: 20 });
  assert.deepStrictEqual(o.getAtPath(obj, 'a.b'), { found: true, value: [10, 20] });
  assert.strictEqual(o.getAtPath(obj, 'a.b[9]').found, false);
  assert.strictEqual(o.getAtPath(obj, 'a.nope').found, false);
});

// ── coerce ────────────────────────────────────────────────────────────────────────────────────────

test('coerce parses JSON literals, falls back to the raw string', () => {
  assert.strictEqual(o.coerce('true'), true);
  assert.strictEqual(o.coerce('false'), false);
  assert.strictEqual(o.coerce('42'), 42);
  assert.strictEqual(o.coerce('hello'), 'hello');
  assert.deepStrictEqual(o.coerce('[1,2]'), [1, 2]);
  assert.deepStrictEqual(o.coerce('{"a":1}'), { a: 1 });
});

// ── setLayer: raw round-trip (comments preserved), create-if-absent ─────────────────────────────────

test('setLayer edits the RAW project file, round-trips _comment keys + sibling sections, creates if absent', () => {
  const dir = tmpDir('overlay-set-');
  const file = path.join(dir, '.claude', 'claude-tpm', 'config.json');
  // create-if-absent: parent dirs do not exist yet
  o.setLayer({ path: 'tasks.maxOpenWarn', value: 100, layer: 'project', projectConfigPath: file });
  let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.tasks.maxOpenWarn, 100);
  // seed a comment + sibling, then set again -> both survive the raw round-trip
  raw._comment = 'keep me';
  raw.session = { enabled: false };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  o.setLayer({ path: 'tasks.defaultListState[+]', value: 'done', layer: 'project', projectConfigPath: file });
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw._comment, 'keep me', 'comment keys are NOT stripped from the raw file');
  assert.deepStrictEqual(raw.session, { enabled: false }, 'sibling section preserved');
  assert.deepStrictEqual(raw.tasks.defaultListState, ['done'], 'append created the array');
});

test('setLayer --default targets the shipped defaults file via TPM_DEFAULTS_FILE override', () => {
  const dir = tmpDir('overlay-def-');
  const file = path.join(dir, 'defaults.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: { maxOpenWarn: 1 } }, null, 2));
  const prev = process.env.TPM_DEFAULTS_FILE;
  process.env.TPM_DEFAULTS_FILE = file;
  try {
    const res = o.setLayer({ path: 'tasks.maxOpenWarn', value: 7, layer: 'default' });
    assert.strictEqual(res.file, file);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.maxOpenWarn, 7);
  } finally {
    if (prev === undefined) delete process.env.TPM_DEFAULTS_FILE; else process.env.TPM_DEFAULTS_FILE = prev;
  }
});

test('setLayer --user throws a clear error when CLAUDE_TPM_USER_CONFIG is unset', () => {
  let threw = false;
  try { o.setLayer({ path: 'a.b', value: 1, layer: 'user', env: {} }); } catch (e) { threw = true; assert.strictEqual(e.code, 'ENOUSERCONFIG'); }
  assert.ok(threw, 'setLayer --user with no user-config env should throw');
});

test('setLayer refuses to clobber an invalid-JSON target (throws EBADJSON)', () => {
  const dir = tmpDir('overlay-badset-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ not json');
  let threw = false;
  try { o.setLayer({ path: 'a.b', value: 1, layer: 'project', projectConfigPath: file }); } catch (e) { threw = true; assert.strictEqual(e.code, 'EBADJSON'); }
  assert.ok(threw);
});

// ── layer tolerance: user tolerant, project strict ──────────────────────────────────────────────────

test('resolveUserSection: env unset -> undefined (skip)', () => {
  assert.strictEqual(o.resolveUserSection('session', { env: {} }), undefined);
});

test('resolveUserSection: env set but file absent -> undefined (skip)', () => {
  assert.strictEqual(o.resolveUserSection('session', { env: { CLAUDE_TPM_USER_CONFIG: '/no/such/file.json' } }), undefined);
});

test('resolveUserSection: present but invalid JSON -> warn(stderr) + undefined, NEVER throws', () => {
  const dir = tmpDir('overlay-baduser-');
  const bad = writeJson(dir, 'user.json', '{ broken');
  const warnings = [];
  const r = o.resolveUserSection('session', { env: { CLAUDE_TPM_USER_CONFIG: bad }, warn: (m) => warnings.push(m) });
  assert.strictEqual(r, undefined);
  assert.strictEqual(warnings.length, 1, 'exactly one warning emitted');
  assert.ok(/could not parse/.test(warnings[0]));
});

test('readSectionFromFile: an INVALID PROJECT file (tolerant:false) throws EBADJSON', () => {
  const dir = tmpDir('overlay-badproj-');
  const bad = writeJson(dir, 'config.json', '{ broken');
  let threw = false;
  try { o.readSectionFromFile(bad, 'session', { tolerant: false }); } catch (e) { threw = true; assert.strictEqual(e.code, 'EBADJSON'); }
  assert.ok(threw, 'project layer must stay strict');
});

// ── resolveLayers: 3-layer merge, user wins ─────────────────────────────────────────────────────────

test('resolveLayers merges defaults -> project -> user; user wins; missing layers tolerated', () => {
  const projDir = tmpDir('overlay-proj-');
  const projFile = path.join(projDir, '.claude', 'claude-tpm', 'config.json');
  fs.mkdirSync(path.dirname(projFile), { recursive: true });
  fs.writeFileSync(projFile, JSON.stringify({ tasks: { maxOpenWarn: 10, exportDir: 'proj-out' } }));
  const userDir = tmpDir('overlay-user-');
  const userFile = writeJson(userDir, 'user.json', { tasks: { maxOpenWarn: 99 } });

  const full = o.resolveLayers({ projectRoot: projDir, env: { CLAUDE_TPM_USER_CONFIG: userFile } });
  assert.strictEqual(full.tasks.maxOpenWarn, 99, 'user layer wins');
  assert.strictEqual(full.tasks.exportDir, 'proj-out', 'project value kept where user is silent');
  assert.strictEqual(full.tasks.tasksDir, '.claude/claude-tpm/tasks', 'default kept where both layers are silent');

  // narrowing to one section works too
  const sect = o.resolveLayers({ section: 'tasks', projectRoot: projDir, env: { CLAUDE_TPM_USER_CONFIG: userFile } });
  assert.strictEqual(sect.maxOpenWarn, 99);
});

test('#1155: session.proseInjections + session.readingList STACK across layers; other arrays still REPLACE', () => {
  const projDir = tmpDir('overlay-stack-proj-');
  const projFile = path.join(projDir, '.claude', 'claude-tpm', 'config.json');
  fs.mkdirSync(path.dirname(projFile), { recursive: true });
  const pInj = { mode: 'open', file: 'p.md', location: 'before' };
  const uInj = { mode: 'open', file: 'u.md', location: 'after' };
  fs.writeFileSync(projFile, JSON.stringify({
    session: { proseInjections: [pInj], readingList: [{ audience: 'all', file: 'a.md' }] },
    tasks: { defaultListState: ['open'] },
  }));
  const userDir = tmpDir('overlay-stack-user-');
  const userFile = writeJson(userDir, 'user.json', {
    session: { proseInjections: [uInj, pInj], readingList: [{ audience: 'orchestrator', file: 'b.md' }] },
    tasks: { defaultListState: ['done'] },
  });
  const env = { CLAUDE_TPM_USER_CONFIG: userFile };
  const full = o.resolveLayers({ projectRoot: projDir, env });
  assert.deepStrictEqual(full.session.proseInjections, [pInj, uInj], 'concat+dedup, project first');
  assert.deepStrictEqual(full.session.readingList.map((e) => e.file), ['a.md', 'b.md']);
  assert.deepStrictEqual(full.tasks.defaultListState, ['done'], 'non-allowlisted array still REPLACES');
  const sect = o.resolveLayers({ section: 'session', projectRoot: projDir, env });
  assert.deepStrictEqual(sect.proseInjections, [pInj, uInj], 'section-narrowed view stacks identically');
});

done('overlay-config.test');
