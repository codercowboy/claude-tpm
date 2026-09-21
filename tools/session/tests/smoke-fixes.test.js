'use strict';
/**
 * smoke-fixes.test.js — pins the Stage-D first-run smoke UX fixes for the SESSION suite.
 *
 * Covers:
 *   F1 — each session write-op verb reports its STATE TRANSITION (not the old identical `wrote <json> <md>`);
 *        the file paths move behind --verbose.
 *   F3 — an error prints the `tpm-session-ops:` prefix EXACTLY ONCE (the close-guard refusal was doubled).
 *   F4 — `--sessions-dir` is OPTIONAL: flag > local project config.json > FAIL LOUD (never a live default).
 *
 * Round-05 (Stage-D post-fix) session-CLI cleanup:
 *   #2 — import `--txt-file` and `--file` are aliases (every import-* verb accepts BOTH spellings).
 *   #3 — `--session` is normalized to 4-digit: `--session 1` ⇒ folder `session-0001/` AND meta.number "0001".
 *   #5 — the `close` line names WHERE carried items surface (the next session's boot-read).
 *
 * Zero-dep, Node built-ins only; auto-discovered by run-all (ends in .test.js).
 */
const { assert, test, done, tmpDir, throwsMatching, fs, path } = require('./helpers/harness');
const os = require('os');
const { spawnSync } = require('child_process');

const ops = require('../tpm-session-ops');
const model = require('../lib/session-model');
const cfg = require('../tpm-session-config');

const OPS = path.join(__dirname, '..', 'tpm-session-ops.js');
const run = (args, opts) => spawnSync('node', [OPS, ...args], Object.assign({ encoding: 'utf8' }, opts || {}));

/** A scratch PROJECT root: CLAUDE.md marker + config.json pointing sessionsDir at `rel`. */
function scratchProject(rel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-sproj-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# marker\n');
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'claude-tpm', 'config.json'),
    JSON.stringify({ version: 1, session: { notes: { sessionsDir: rel } } }, null, 2) + '\n',
  );
  return root;
}

// ── F1: distinct, transition-stating success lines ─────────────────────────────────
test('F1: describeResult states each verb\'s transition (not filenames)', () => {
  const opened = model.openSession({ number: '0001', sessionId: 's' });
  assert.strictEqual(ops.describeResult('open', {}, opened), 'session 0001 opened', 'open names the session');

  const withNote = model.appendLog(opened, { type: 'log', status: 'NOTE', text: 'hi' });
  assert.strictEqual(ops.describeResult('note', {}, withNote), 'logged NOTE (entry #1)', 'note names status + seq');

  const withItem = model.addPunchlist(withNote, { text: 'carry me' });
  const pl = ops.describeResult('punchlist', { action: 'add' }, withItem);
  assert.ok(/^added #\S+ \[\S+\]$/.test(pl), 'punchlist add names id + slug: ' + pl);

  const withHandoff = model.importHandoff(withItem, { where: 'here', next: 'there' });
  assert.strictEqual(ops.describeResult('import-handoff', {}, withHandoff), 'handoff set (where + next)');
  assert.ok(/^session 0001 saved/.test(ops.describeResult('save', {}, withHandoff)), 'save names the session');

  const closed = model.closeSession(withHandoff);
  const closeLine = ops.describeResult('close', {}, closed);
  // #5: with an open item the close line also NAMES the carry destination.
  assert.ok(/^session 0001 closed · handoff ✓ · [1-9]\d* open punchlist item\(s\) carried \(surface in the next session's boot-read\)$/.test(closeLine),
    'close confirms the guard AND names where items carry: ' + closeLine);

  // The six lines must be DISTINCT (the old bug: all six were byte-identical).
  const lines = new Set([
    ops.describeResult('open', {}, opened),
    ops.describeResult('note', {}, withNote),
    ops.describeResult('punchlist', { action: 'add' }, withItem),
    ops.describeResult('import-handoff', {}, withHandoff),
    ops.describeResult('save', {}, withHandoff),
    closeLine,
  ]);
  assert.strictEqual(lines.size, 6, 'all six verb success lines are distinct');
});

test('F1: CLI open prints the transition line; --verbose ALSO prints the paths', () => {
  const dir = tmpDir('f1-cli-');
  const plain = run(['open', '--sessions-dir', dir, '--session', '5', '--session-id', 'x']);
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.ok(/tpm-session-ops open: session 0005 opened/.test(plain.stderr), 'transition line: ' + plain.stderr);
  assert.ok(!/wrote/.test(plain.stderr), 'no file paths without --verbose');

  const verbose = run(['save', '--sessions-dir', dir, '--session', '5', '--verbose']);
  assert.strictEqual(verbose.status, 0, verbose.stderr);
  assert.ok(/session 0005 saved/.test(verbose.stderr), 'still prints the transition line');
  assert.ok(/wrote .*session-0005\.json/.test(verbose.stderr), '--verbose prints the .json path');
  assert.ok(/wrote .*session-0005\.md/.test(verbose.stderr), '--verbose prints the .md path');
});

// ── F3: single prefix ───────────────────────────────────────────────────────────────
test('F3: the close-guard refusal prints tpm-session-ops: exactly ONCE (never doubled)', () => {
  const dir = tmpDir('f3-');
  assert.strictEqual(run(['open', '--sessions-dir', dir, '--session', '7', '--session-id', 'x']).status, 0);
  const r = run(['close', '--sessions-dir', dir, '--session', '7']);   // no handoff/punchlist → refuse
  assert.strictEqual(r.status, 1, 'close-guard refuses (exit 1)');
  const hits = (r.stderr.match(/tpm-session-ops:/g) || []).length;
  assert.strictEqual(hits, 1, `exactly one tpm-session-ops: prefix, got ${hits} in: ${r.stderr}`);
  assert.ok(!/tpm-session-ops: tpm-session-ops/.test(r.stderr), 'no doubled prefix');
});

test('F3: prefixOnce strips an already-prefixed message (incl. a "<tool> <verb>:" scope)', () => {
  assert.strictEqual(ops.prefixOnce('tpm-session-ops: ', 'tpm-session-ops: boom'), 'tpm-session-ops: boom');
  assert.strictEqual(ops.prefixOnce('tpm-session-ops: ', 'tpm-session-ops close: refusing'),
    'tpm-session-ops: refusing', 'strips the "<tool> <verb>:" scope too');
});

// ── F4: optional --sessions-dir ──────────────────────────────────────────────────────
test('F4: resolveSessionsDir — flag wins, else local project config, else FAIL LOUD', () => {
  assert.strictEqual(cfg.resolveSessionsDir('/explicit').sessionsDir, '/explicit', 'flag overrides');
  const proj = scratchProject('claude-context/sessions');
  const res = cfg.resolveSessionsDir(undefined, undefined, { startDir: proj });
  assert.strictEqual(res.source, 'config', 'resolved from config');
  assert.strictEqual(res.sessionsDir, path.join(proj, 'claude-context', 'sessions'), 'config sessionsDir (project-relative)');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-f4s-bare-'));
  throwsMatching(() => cfg.resolveSessionsDir(undefined, undefined, { startDir: bare }),
    /--sessions-dir is required/, 'no flag + no local config throws loud');
});

test('F4: CLI open works with NO --sessions-dir inside a project, FAILS LOUD outside one', () => {
  const proj = scratchProject('claude-context/sessions');
  const ok = run(['open', '--session', '1', '--session-id', 'x'], { cwd: proj });
  assert.strictEqual(ok.status, 0, 'open with no flag resolves from config: ' + ok.stderr);
  assert.ok(fs.existsSync(path.join(proj, 'claude-context', 'sessions', 'session-0001', 'session-0001.json')),
    'wrote to the config-resolved store, not a live one');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-f4s-cli-'));
  const fail = run(['open', '--session', '1', '--session-id', 'x'], { cwd: bare });
  assert.strictEqual(fail.status, 1, 'no flag + no project fails loud (exit 1)');
  assert.ok(/--sessions-dir is required/.test(fail.stderr), 'names the flag in the loud error');
});

// ── #2: --txt-file and --file are aliases across every import-* verb ────────────────────
test('#2: import-log / import-punchlist / import-handoff ALL accept --file AND --txt-file', () => {
  const dir = tmpDir('alias-');
  assert.strictEqual(run(['open', '--sessions-dir', dir, '--session', '1', '--session-id', 'x']).status, 0);

  // import-log historically took --txt-file; it must now also accept --file.
  const logF = path.join(dir, 'log.txt'); fs.writeFileSync(logF, 'a log line via --file\n');
  const rl = run(['import-log', '--sessions-dir', dir, '--session', '1', '--file', logF, '--status', 'NOTE']);
  assert.strictEqual(rl.status, 0, 'import-log accepts --file: ' + rl.stderr);

  // import-punchlist historically took --file; it must now also accept --txt-file.
  const plF = path.join(dir, 'pl.txt'); fs.writeFileSync(plF, 'an item via --txt-file\n');
  const rp = run(['import-punchlist', '--sessions-dir', dir, '--session', '1', '--txt-file', plF]);
  assert.strictEqual(rp.status, 0, 'import-punchlist accepts --txt-file: ' + rp.stderr);

  // import-handoff historically took --txt-file; it must now also accept --file.
  const hoF = path.join(dir, 'ho.txt'); fs.writeFileSync(hoF, 'where we are\n');
  const rh = run(['import-handoff', '--sessions-dir', dir, '--session', '1', '--file', hoF, '--next', 'do next']);
  assert.strictEqual(rh.status, 0, 'import-handoff accepts --file: ' + rh.stderr);

  // The programmatic parse also unifies the two flags into one value.
  const { opImportPunchlist } = ops;
  assert.strictEqual(typeof opImportPunchlist, 'function', 'op exported');
});

// ── #3: --session normalized to 4-digit (folder AND meta.number agree) ──────────────────
test('#3: `open --session 1` writes session-0001/ AND stores meta.number "0001"', () => {
  const dir = tmpDir('pad-');
  const r = run(['open', '--sessions-dir', dir, '--session', '1', '--session-id', 'x']);
  assert.strictEqual(r.status, 0, r.stderr);
  const jsonPath = path.join(dir, 'session-0001', 'session-0001.json');
  assert.ok(fs.existsSync(jsonPath), 'folder + file are 4-digit padded: ' + jsonPath);
  const rec = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(rec.meta.number, '0001', 'meta.number is the padded 4-digit form');
  assert.ok(/session 0001 opened/.test(r.stderr), 'the transition line reports the padded number');
});

// ── #5: close names WHERE carried items surface (and omits it when none carry) ──────────
test('#5: close names the carry destination only when there ARE open items', () => {
  const opened = model.openSession({ number: '0001', sessionId: 's' });
  const withItem = model.addPunchlist(opened, { text: 'carry me' });
  const withHandoff = model.importHandoff(withItem, { where: 'here', next: 'there' });
  const closedOpen = model.closeSession(withHandoff);
  assert.ok(
    /1 open punchlist item\(s\) carried \(surface in the next session's boot-read\)$/.test(
      ops.describeResult('close', {}, closedOpen)),
    'destination named when an item carries');

  // now close that item first → 0 open → no destination clause
  const done0 = model.closePunchlistItem(withHandoff, withItem.punchlist[0].id);
  const closedNone = model.closeSession(done0);
  const line = ops.describeResult('close', {}, closedNone);
  assert.ok(/0 open punchlist item\(s\) carried$/.test(line), 'no destination clause when nothing carries: ' + line);
});

done('smoke-fixes.test.js');
