'use strict';
/**
 * exit-code.test.js (F7) — the CLI exit-code CONTRACT for tpm-task.js.
 *
 * The ops suite exercises the op* functions but never asserts the process exit code the CLI returns.
 * F7 (06 verifier) asked P08 to pin that contract. tpm-task.js's `main(argv)` RETURNS the exit code
 * (it only `process.exit`s under `require.main`), so we assert `main` directly for the matrix, AND
 * spawn one real `node tpm-task.js …` subprocess to prove the returned code becomes the process exit.
 *
 * CONTRACT (as shipped — this suite PINS the current behaviour; it does not change it):
 *   exit 0 — success (a completed verb, or --help).
 *   exit 2 — MISUSE (usage error): unknown global flag, unknown flag on a verb, a flag missing its
 *            value, an unknown verb (badSub), the phase-07 `export`/`search` pointer, AND an invalid
 *            `--state` VALUE (T-Q7: a bad flag VALUE is now uniform "usage error → 2", not runtime-1).
 *   exit 1 — a RUNTIME error the dispatch throws (missing --tasks-dir, task-not-found, illegal
 *            transition, close-guard refusal).
 *
 * Every store op runs against a SCRATCH dir. main() writes usage/notices to stdout/stderr; we
 * silence those around each call so the suite's own output stays readable. Node built-ins only.
 */
const { assert, test, done, scratch, fs, model } = require('./helpers/task-e2e-helpers');
const path = require('path');
const { spawnSync } = require('child_process');

const t = require('../tpm-task.js');
const doctor = require('../tpm-task-doctor.js');
const migrator = require('../tpm-task-migrate.js');
const conv = require('../lib/task-converter.js');

// The committed CLEAN legacy fixture (migrates without refusal) — reused for the migrate success path.
const CLEAN_LEGACY = path.join(__dirname, 'fixtures', 'legacy-tasks', 'clean');

/** A minimal well-formed NEW-format store (one saved task) for the doctor success path. */
function healthyTaskStore() {
  const dir = scratch('tpm-exit-doc-');
  const rec = model.openTask({ headline: 'a task', tasksDir: dir });
  model.saveTask(rec, { tasksDir: dir, render: conv.render, indexRender: conv.renderIndexView });
  return dir;
}

// Run main(argv) with stdout/stderr silenced; return its exit code. (main does NOT process.exit
// unless run as the main module — safe to call in-process. It never spawns for these argv, since
// export/search delegation only fires when argv[0] itself is export/search, which we test via a
// path that reaches dispatch instead.)
function code(argv) {
  const outW = process.stdout.write;
  const errW = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return t.main(argv);
  } finally {
    process.stdout.write = outW;
    process.stderr.write = errW;
  }
}

// ── exit 0 — success ───────────────────────────────────────────────────────────

test('exit 0: a completed verb (add) returns 0', () => {
  const dir = scratch('tpm-exit-');
  assert.strictEqual(code(['add', '--tasks-dir', dir, '--headline', 'hello']), 0, 'add success => 0');
});

test('exit 0: --help returns 0', () => {
  assert.strictEqual(code(['--help']), 0, '--help => 0');
  assert.strictEqual(code(['add', '--help']), 0, 'verb --help => 0');
});

// ── exit 2 — parse-layer MISUSE ──────────────────────────────────────────────────

test('exit 2: an unknown GLOBAL flag is misuse', () => {
  assert.strictEqual(code(['--bogus']), 2, 'unknown global flag => 2');
});

test('exit 2: an unknown verb (badSub) is misuse', () => {
  assert.strictEqual(code(['frobnicate']), 2, 'unknown verb => 2');
});

test('exit 2: an unknown flag on a verb is misuse', () => {
  const dir = scratch('tpm-exit-');
  assert.strictEqual(code(['add', '--tasks-dir', dir, '--nonsense']), 2, 'unknown verb flag => 2');
});

test('exit 2: a flag missing its value is misuse', () => {
  assert.strictEqual(code(['add', '--headline']), 2, 'dangling value flag => 2');
});

test('exit 2: the phase-07 export/search pointer exits 2 (reached when the verb is not argv[0])', () => {
  // argv[0] is a global flag, so the raw-argv export delegation in main() does NOT intercept;
  // parseArgs then sets sub=export and dispatch hits the phase-07 pointer branch → 2.
  const dir = scratch('tpm-exit-');
  assert.strictEqual(code(['--tasks-dir', dir, 'export']), 2, 'export pointer => 2');
  assert.strictEqual(code(['--tasks-dir', dir, 'search']), 2, 'search pointer => 2');
});

// ── exit 1 — RUNTIME errors ──────────────────────────────────────────────────────

test('exit 1: a store op with no --tasks-dir is a runtime error', () => {
  assert.strictEqual(code(['add', '--headline', 'x']), 1, 'missing --tasks-dir => 1 (runtime)');
});

test('exit 1: a transition on a missing task is a runtime error', () => {
  const dir = scratch('tpm-exit-');
  assert.strictEqual(code(['start', '--tasks-dir', dir, '999']), 1, 'task-not-found => 1');
});

test('exit 1: an illegal transition (start on finished) is a runtime error', () => {
  const dir = scratch('tpm-exit-');
  code(['add', '--tasks-dir', dir, '--headline', 'x']);          // -> id 1000
  code(['finish', '--tasks-dir', dir, '1000']);                  // -> finished
  assert.strictEqual(code(['start', '--tasks-dir', dir, '1000']), 1, 'illegal transition => 1');
});

test('exit 1: the #1111 close-guard refusal is a runtime error', () => {
  const dir = scratch('tpm-exit-');
  code(['add', '--tasks-dir', dir, '--headline', 'x']);
  code(['add-subtask', '--tasks-dir', dir, '1000', '--text', 'open one']);
  assert.strictEqual(code(['finish', '--tasks-dir', dir, '1000']), 1, 'close-guard refusal => 1');
});

test('T-Q7: an invalid --state VALUE is a usage error → exits 2 (uniform), NOT 1 (runtime)', () => {
  const dir = scratch('tpm-exit-');
  // statesFor() tags a bad --state value with e.usageExit, so main()'s dispatch-catch maps it to 2 —
  // the F7 inconsistency (a VALUE error used to exit 1) is now resolved: a bad flag VALUE is misuse.
  assert.strictEqual(code(['list', '--tasks-dir', dir, '--state', 'bogus']), 2, 'invalid --state value => 2');
});

// ── F7: the DOCTOR CLI (tpm-task-doctor.js) exit-code contract via main(argv) ─────
// (2 = usage/parse · 1 = diagnosed problems · 0 = clean / --help). Same three-way contract,
// pinned by driving the doctor's own main(argv) — not just runDoctor.

function silenced(fn) {
  const outW = process.stdout.write;
  const errW = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stdout.write = outW; process.stderr.write = errW; }
}

test('doctor exit 2: parse/usage errors (missing --tasks-dir, unknown flag, dangling value, unreadable dir)', () => {
  assert.strictEqual(silenced(() => doctor.main([])), 2, 'missing --tasks-dir => 2');
  assert.strictEqual(silenced(() => doctor.main(['--bogus'])), 2, 'unknown flag => 2');
  assert.strictEqual(silenced(() => doctor.main(['--tasks-dir'])), 2, 'flag needs a value => 2');
  const missing = path.join(scratch('tpm-exit-doc-'), 'does-not-exist');
  assert.strictEqual(silenced(() => doctor.main(['--tasks-dir', missing])), 2, 'unreadable dir => 2');
});

test('doctor exit 0: a clean store and --help', () => {
  const clean = healthyTaskStore();
  assert.strictEqual(silenced(() => doctor.main(['--tasks-dir', clean])), 0, 'clean store => 0');
  assert.strictEqual(silenced(() => doctor.main(['--help'])), 0, '--help => 0');
});

test('doctor exit 1: a diagnosed problem (an invalid body) is nonzero', () => {
  const dir = healthyTaskStore();
  const bp = model.bodyPathFor(dir, '1000');
  const rec = JSON.parse(fs.readFileSync(bp, 'utf8'));
  rec.headline = '';                                   // breaks validatePayload
  fs.writeFileSync(bp, JSON.stringify(rec, null, 2) + '\n');
  assert.strictEqual(silenced(() => doctor.main(['--tasks-dir', dir])), 1, 'invalid body => 1');
});

// ── F7: the MIGRATE CLI (tpm-task-migrate.js) exit-code contract via main(argv) ───
// (2 = parse-layer misuse · 1 = a diagnosed refusal / runtime error · 0 = success / --help).

test('migrate exit 2: parse-layer misuse (unknown argument, dangling flag value)', () => {
  assert.strictEqual(silenced(() => migrator.main(['--bogus'])), 2, 'unknown argument => 2');
  assert.strictEqual(silenced(() => migrator.main(['--in'])), 2, 'flag needs a value => 2');
});

test('migrate exit 1: a runtime refusal (missing --in, or a non-store dir) is nonzero', () => {
  const out = scratch('tpm-exit-mig-');
  assert.strictEqual(silenced(() => migrator.main(['--out-dir', out])), 1, 'missing --in => 1 (runtime refuse)');
  const emptyIn = scratch('tpm-exit-mig-in-');       // a dir with no bodies/ → detectStore refuses
  const out2 = scratch('tpm-exit-mig-');
  assert.strictEqual(silenced(() => migrator.main(['--in', emptyIn, '--out-dir', out2, '--offset', '-07:00'])), 1,
    'non-store dir => 1 (detectStore refusal)');
});

test('migrate exit 0: a clean whole-store migration and --help', () => {
  const out = scratch('tpm-exit-mig-ok-');
  assert.strictEqual(silenced(() => migrator.main(['--in', CLEAN_LEGACY, '--out-dir', out, '--offset', '-07:00'])), 0,
    'clean store migrates => 0');
  assert.strictEqual(silenced(() => migrator.main(['--help'])), 0, '--help => 0');
});

// ── subprocess proof: the returned code IS the process exit code ──────────────────

test('subprocess proof: `node tpm-task.js …` exits with the contract code (0 / 1 / 2)', () => {
  const tool = path.join(__dirname, '..', 'tpm-task.js');
  const dir = scratch('tpm-exit-sub-');
  const run = (args) => spawnSync('node', [tool, ...args], { encoding: 'utf8' }).status;

  assert.strictEqual(run(['add', '--tasks-dir', dir, '--headline', 'sub ok']), 0, 'real process: add => exit 0');
  assert.strictEqual(run(['frobnicate']), 2, 'real process: unknown verb => exit 2');
  assert.strictEqual(run(['start', '--tasks-dir', dir, '424242']), 1, 'real process: task-not-found => exit 1');
});

done('exit-code.test.js');
