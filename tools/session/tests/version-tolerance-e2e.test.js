'use strict';
/**
 * version-tolerance-e2e.test.js (P07, verifier concern C1) — the schemaVersion tolerance guarantee,
 * exercised END-TO-END through the OPS load path (not just version.migrate in isolation).
 *
 * The canonical load path is read → migrate → validate; the refuse-unknown-NEWER guard lives in
 * version.migrate, so if migrate is skipped the guard never fires. This suite proves, through a real
 * op (opSave = load current → persist):
 *   1. An OLDER but KNOWN schemaVersion migrates on load: a registered migrator upgrades the record
 *      (here it also supplies a field the 1.0.0 validator requires), so the op succeeds and REWRITES
 *      the file at CURRENT. If migrate were skipped, validate would reject the old record — the test
 *      is load-bearing for the migrate-BEFORE-validate ordering.
 *   2. A NEWER unknown schemaVersion is REFUSED LOUD, naming the version (old code never reads, and
 *      therefore never later destroys, data a newer writer produced).
 *   3. (bonus) An older version with NO migrator path throws — no silent pass-through.
 *
 * migrate() reads its migrator table from the shared version.migrations singleton (loadSession calls
 * migrate(raw) with no explicit registry), so the test registers a migrator there. Each case runs in
 * a THROWAWAY dir (os.tmpdir mkdtemp) — NEVER the live sessions dir.
 *
 * Run: node tests/version-tolerance-e2e.test.js
 * Node built-ins only.
 */
const { assert, test, done, throwsMatching } = require('./helpers/harness');
const { NOW, scratch, jsonPath, fs, path } = require('./helpers/e2e-helpers');

const ops = require('../tpm-session-ops');
const model = require('../lib/session-model');
const version = require('../../lib/version');

// Register a KNOWN-older migrator into the shared singleton (the registry loadSession consults).
// It upgrades 0.9.0 → CURRENT AND injects meta.tpmVersion — a field the 1.0.0 validator requires —
// so a load that skipped migrate would fail validation (making the migrate step observable).
// [#1122.B] Capture any prior value so the finally below can RESTORE the shared singleton — leaving
// this migrator registered would bleed into other suites if run-all ever ran suites in-process.
const HAD_090 = Object.prototype.hasOwnProperty.call(version.migrations, '0.9.0');
const PREV_090 = version.migrations['0.9.0'];
version.migrations['0.9.0'] = function migrate_0_9_0(rec) {
  const out = JSON.parse(JSON.stringify(rec));
  out.schemaVersion = version.CURRENT;
  if (!out.meta || out.meta.tpmVersion === undefined || out.meta.tpmVersion === '') {
    out.meta = Object.assign({}, out.meta, { tpmVersion: '0.0.0' });
  }
  return out;
};

// A valid CURRENT session record, then relabelled to an OLD version with the migrator's field removed.
function baseRecord() {
  let rec = model.openSession({ number: '0021', sessionId: 'sid-old', tpmVersion: '1.0.0' });
  rec = model.importHandoff(rec, { where: 'legacy where', next: 'legacy next' });
  rec = model.appendLog(rec, { status: 'NOTE', text: 'legacy note' });
  rec = model.addPunchlist(rec, { text: 'legacy task', slug: 'leg001' });
  return rec;
}

// Write a record to disk at `schemaVersion`, optionally deleting meta.tpmVersion (to prove migrate ran).
function writeAtVersion(dir, number, schemaVersion, { dropTpmVersion } = {}) {
  const rec = baseRecord();
  rec.schemaVersion = schemaVersion;
  if (dropTpmVersion) delete rec.meta.tpmVersion;
  const jp = jsonPath(dir, number);
  fs.mkdirSync(path.dirname(jp), { recursive: true }); // create the per-session folder (NESTED, Q-F)
  fs.writeFileSync(jp, JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

try {
test('older KNOWN schemaVersion migrates on load through the ops path (opSave rewrites at CURRENT)', () => {
  const dir = scratch('tpm-ver-');
  writeAtVersion(dir, '0021', '0.9.0', { dropTpmVersion: true }); // invalid at 1.0.0 until the migrator fixes it
  const rec = ops.opSave({ sessionsDir: dir, number: '0021', now: NOW });
  assert.strictEqual(rec.schemaVersion, version.CURRENT, 'record migrated up to CURRENT on load');
  assert.strictEqual(rec.meta.tpmVersion, '0.0.0', 'the migrator supplied the field the 1.0.0 validator requires');
  // the file on disk is now CURRENT and re-loads cleanly (migrate returns it as-is next time)
  const reloaded = model.loadSession(jsonPath(dir, '0021'));
  assert.strictEqual(reloaded.schemaVersion, version.CURRENT, 'persisted file is at CURRENT');
  assert.strictEqual(reloaded.handoff.where, 'legacy where', 'payload preserved across the migration');
});

test('NEWER unknown schemaVersion is REFUSED LOUD through the ops path, naming the version', () => {
  const dir = scratch('tpm-ver-');
  writeAtVersion(dir, '0021', '2.0.0'); // newer than this code understands
  throwsMatching(
    () => ops.opSave({ sessionsDir: dir, number: '0021', now: NOW }),
    /newer schemaVersion '2\.0\.0'/,
    'refuses a newer-than-code version end-to-end',
  );
  // and the file was NOT rewritten (the guard fired before any persist)
  const raw = JSON.parse(fs.readFileSync(jsonPath(dir, '0021'), 'utf8'));
  assert.strictEqual(raw.schemaVersion, '2.0.0', 'the newer file is left untouched (never read → never overwritten)');
});

test('older version with NO migrator path throws (no silent pass-through)', () => {
  const dir = scratch('tpm-ver-');
  writeAtVersion(dir, '0021', '0.5.0'); // older but unregistered
  throwsMatching(
    () => ops.opSave({ sessionsDir: dir, number: '0021', now: NOW }),
    /no migration path from schemaVersion '0\.5\.0'/,
    'an unmigratable older version fails loud rather than passing through',
  );
});
} finally {
  // [#1122.B] restore the shared migrations singleton so this suite leaves no residue
  if (HAD_090) version.migrations['0.9.0'] = PREV_090;
  else delete version.migrations['0.9.0'];
}

done('version-tolerance-e2e.test.js');
