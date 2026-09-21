'use strict';
/**
 * task-hard-remove.test.js — the CONFIG-GATED `remove --hard` purge (#1123 Stage C gap-fix; #1086).
 *
 * `remove --hard` permanently deletes a task's canonical JSON body (+ derived .md) and reindexes —
 * UNRECOVERABLE — but ONLY when `tasks.allowHardDelete` is true; DEFAULT OFF/safe → refuses loud,
 * naming the config key. Soft-stash `remove` (no --hard) is unchanged. This suite pins the gate on
 * both faces (op function + CLI) and proves the reindex preserves the nextId high-water.
 *
 * Zero-dep inline harness (exit NON-ZERO on any failure, ship-tool bar). Hermetic: a fresh scratch
 * tasks dir + written config files per case — never the live store.
 *
 * Run: node tests/task-hard-remove.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('../tpm-task.js');
const model = require('../lib/task-model');
const config = require('../tpm-task-config.js');

const TOOL = path.join(__dirname, '..', 'tpm-task.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   - ' + name); }
  catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}
function done(suite) { console.log(`\n${suite}: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); }
function throwsMatching(fn, re, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; assert.ok(re.test(e.message), (msg || 'error') + ` should match ${re}, got: ${e.message}`); }
  assert.ok(threw, (msg || 'call') + ' should have thrown');
}
function tmpDir(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p || 'tpm-hard-')); }
function writeConfig(allow) {
  const p = path.join(tmpDir('cfg-'), 'config.json');
  fs.writeFileSync(p, JSON.stringify({ tasks: { allowHardDelete: allow } }));
  return p;
}
function bodyExists(dir, id) { return fs.existsSync(model.bodyPathFor(dir, String(id))); }
function runCli(args) {
  const r = require('child_process').spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function seed() { const dir = tmpDir(); t.opAdd({ tasksDir: dir, headline: 'purge me' }); return dir; }

const CFG_OFF = writeConfig(false);
const CFG_ON = writeConfig(true);

// ── config default is OFF/safe (#1086) ──────────────────────────────────────────

test('config default resolves allowHardDelete:false (OFF/safe per #1086)', () => {
  assert.strictEqual(config.getDefaults().allowHardDelete, false);
  const dir = tmpDir('cfg-none-');
  const { resolved } = config.resolveTasksConfig(undefined, { startDir: dir });
  assert.strictEqual(resolved.allowHardDelete, false, 'an absent key defaults OFF');
});

// ── the gate (op function) ──────────────────────────────────────────────────────

test('opHardRemove REFUSES when allowHardDelete is not true, leaving the body untouched', () => {
  const dir = seed();
  throwsMatching(() => t.opHardRemove({ tasksDir: dir, id: 1000, config: CFG_OFF }), /allowHardDelete is not true/);
  assert.ok(bodyExists(dir, 1000), 'body must survive a refused hard-delete');
});

test('opHardRemove PURGES the body + .md and drops the row when allowHardDelete:true', () => {
  const dir = seed();
  const mdPath = model.bodyPathFor(dir, '1000').replace(/\.json$/, '.md');
  assert.ok(bodyExists(dir, 1000) && fs.existsSync(mdPath), 'precondition: body + md exist');
  const res = t.opHardRemove({ tasksDir: dir, id: 1000, config: CFG_ON });
  assert.strictEqual(res.id, '1000');
  assert.ok(!bodyExists(dir, 1000), 'canonical body purged');
  assert.ok(!fs.existsSync(mdPath), 'derived .md purged');
  const idx = model.readIndex(dir);
  assert.ok(!(idx.tasks || []).some((r) => String(r.id) === '1000'), 'the index row is gone');
});

test('opHardRemove throws for an unknown id (nothing to purge)', () => {
  const dir = seed();
  throwsMatching(() => t.opHardRemove({ tasksDir: dir, id: 4242, config: CFG_ON }), /no task #4242 found/);
});

test('reindex after a hard-delete PRESERVES the nextId high-water (a purged id is never reissued)', () => {
  const dir = seed();
  t.opHardRemove({ tasksDir: dir, id: 1000, config: CFG_ON });
  const idx = model.readIndex(dir);
  assert.strictEqual(String(idx.nextId), '1001', 'nextId must not regress to 1000 after purging it');
});

// ── soft-stash remove unchanged ──────────────────────────────────────────────────

test('soft `remove` (no --hard) still only flips state → removed, body preserved', () => {
  const dir = seed();
  const rec = t.opTransition('remove', { tasksDir: dir, id: 1000 });
  assert.strictEqual(rec.state, 'removed');
  assert.ok(bodyExists(dir, 1000), 'soft remove keeps the body (recoverable)');
});

// ── the gate (CLI, real exit codes) ──────────────────────────────────────────────

test('CLI `remove --hard` with default/OFF config exits 1, names the key, body survives', () => {
  const dir = seed();
  const r = runCli(['remove', '1000', '--hard', '--tasks-dir', dir, '--config', CFG_OFF]);
  assert.strictEqual(r.code, 1);
  assert.ok(/allowHardDelete/.test(r.stderr), 'the refusal must name the config key');
  assert.ok(bodyExists(dir, 1000));
});

test('CLI `remove --hard` with allowHardDelete:true exits 0 and purges the body', () => {
  const dir = seed();
  const r = runCli(['remove', '1000', '--hard', '--tasks-dir', dir, '--config', CFG_ON]);
  assert.strictEqual(r.code, 0);
  assert.ok(/HARD-DELETED #1000/.test(r.stderr));
  assert.ok(!bodyExists(dir, 1000));
});

test('CLI soft `remove` (no --hard) exits 0 and keeps the body', () => {
  const dir = seed();
  const r = runCli(['remove', '1000', '--tasks-dir', dir]);
  assert.strictEqual(r.code, 0);
  assert.ok(bodyExists(dir, 1000));
});

done('task-hard-remove.test');
