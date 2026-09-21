'use strict';
/**
 * migrate-openedat-refuse.test.js (P05, Q-E gap) — pins the REFUSE branch the P03 verifier could
 * only check by hand: a marked 3-file session that carries NO real timestamp ANYWHERE (no sidecar,
 * an empty log ledger, an empty punchlist) cannot fill the schema-required, non-nullable
 * `meta.openedAt`. Q-C forbids synthesizing one, so the migrator must REFUSE with a
 * `cannot fill meta.openedAt` MigrateError — and write nothing.
 *
 * This branch has no automated test today. Its whole value is negative: a silent regression that
 * "helpfully" SYNTHESIZED an openedAt there (e.g. `|| now`, `|| '…T00:00:00…'`) would let the
 * migration SUCCEED — and this suite must turn RED when it does (the expected throw never happens).
 *
 * All inputs are written to a scratch --in dir (os.tmpdir mkdtemp); output goes to a scratch --out
 * dir. NEVER the live sessions tree. The complement path (a session that DOES carry a real stamp
 * migrates fine) is asserted too, so the refusal is proven specific to the no-timestamp case.
 * Run: node tests/migrate-openedat-refuse.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const os = require('os');
const { spawnSync } = require('child_process');
const { assert, test, done, throwsMatching, fs, path } = require('./helpers/harness');
const { writeOldSession } = require('./helpers/legacy-builder');

const migrator = require('../tpm-session-migrate');

const TOOL = path.join(__dirname, '..', 'tpm-session-migrate.js');
const PINNED_NOW = '2026-09-19T22:00:00-07:00';

function scratchBase(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-refuse-' + (tag || '') + '-')); }

// An OLD session with a valid handoff (needs no timestamp) but a totally EMPTY log + punchlist and
// NO sidecar → there is no real ISO-TZ stamp anywhere for openedAt to be selected from.
function writeNoTimestampSession(base, num) {
  return writeOldSession(base, num, {
    handoff: { where: 'a timestamp-less pre-format session', next: 'must be converted by hand' },
    decisions: [],
    logs: [],
    open: [],
    done: [],
  });
}

test('Q-E: a session with NO real timestamp anywhere is REFUSED (cannot fill meta.openedAt)', () => {
  const inDir = writeNoTimestampSession(scratchBase('in'), '0050');
  const outDir = scratchBase('out');
  throwsMatching(
    () => migrator.runMigration({ inDir, outDir, now: PINNED_NOW }),
    /cannot fill meta\.openedAt/,
    'no-timestamp session',
  );
  // it is a clean refusal (a MigrateError), not a crash.
  let err;
  try { migrator.runMigration({ inDir, outDir, now: PINNED_NOW }); } catch (e) { err = e; }
  assert.ok(err instanceof migrator.MigrateError, 'refusal is a MigrateError');
  // and NOTHING was written.
  assert.strictEqual(fs.readdirSync(outDir).length, 0, 'a refused migration writes no output');
});

test('Q-E: parseOldSession itself refuses the no-timestamp session (the refuse is pre-write)', () => {
  const inDir = writeNoTimestampSession(scratchBase('parse'), '0051');
  throwsMatching(
    () => migrator.parseOldSession({ inDir, now: PINNED_NOW }),
    /cannot fill meta\.openedAt/,
    'parseOldSession refuses before any write happens',
  );
});

test('Q-E: the CLI exits non-zero and names the refusal', () => {
  const inDir = writeNoTimestampSession(scratchBase('cli-in'), '0052');
  const outDir = scratchBase('cli-out');
  const r = spawnSync(process.execPath, [TOOL, '--in', inDir, '--out-dir', outDir, '--now', PINNED_NOW], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, 'CLI exits 1 on the openedAt refusal');
  assert.ok(/cannot fill meta\.openedAt/.test(r.stderr), 'stderr names the unfillable field');
  assert.strictEqual(fs.readdirSync(outDir).length, 0, 'CLI refusal writes nothing');
});

test('COMPLEMENT: the SAME session with one real log timestamp migrates fine (openedAt selected, not synthesized)', () => {
  const base = scratchBase('ok');
  const inDir = writeOldSession(base, '0053', {
    handoff: { where: 'now it has a real stamp', next: 'migrate it' },
    logs: [{ status: 'ADDED', text: 'a real stamped log line', ts: '2026-09-10T09:15:00-07:00' }],
  });
  const outDir = scratchBase('ok-out');
  const res = migrator.runMigration({ inDir, outDir, now: PINNED_NOW });
  assert.ok(res.written, 'a session with a real timestamp migrates');
  assert.strictEqual(res.record.meta.openedAt, '2026-09-10T09:15:00-07:00', 'openedAt is the SELECTED earliest real stamp');
  assert.ok(!/T00:00:00/.test(res.record.meta.openedAt), 'openedAt is not a synthesized midnight value');
});

done('migrate-openedat-refuse.test.js');
