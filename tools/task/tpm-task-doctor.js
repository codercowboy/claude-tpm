#!/usr/bin/env node
'use strict';
/**
 * tpm-task-doctor.js — the READ-ONLY task-store validator / drift detector (#1119 for tasks; the
 * task-side mirror of the session doctor, `tools/session/tpm-session-doctor.js`).
 *
 * It DIAGNOSES a task store and NEVER mutates it. There is no `--fix`, no write path of any kind —
 * it reads, recomputes, and REPORTS. Four checks:
 *
 *   1. SCHEMA VALIDATION — every canonical body `bodies/<bucket>/task-<id>.json` (discovered in the
 *      NESTED bucket layout via task-model.listBodyPaths) is read → migrated → validated through the
 *      base `validateEnvelope` with the LOCKED task payload validator. An invalid record is reported
 *      loud + structured (id + failing stage + reason); NEVER fixed.
 *
 *   2. HASH-DRIFT — the derived body `.md` carries a `<!-- generated from: <12hex> -->` banner that
 *      is `hash.hashRecord(record)` stamped at render time. The doctor recomputes hashRecord over the
 *      CURRENT on-disk JSON and compares. A mismatch means the on-disk JSON no longer hashes to the
 *      banner stamped at render time — i.e. the canonical JSON was edited (or replaced) WITHOUT
 *      re-rendering its body, leaving the banner stale → REPORTED as DRIFT. Never re-renders.
 *
 *   3. LABEL-INDEX CONSISTENCY — `tasks-index.json.labels` is the label→ids reverse index kept in
 *      lockstep with the rows by the model. The doctor recomputes `deriveLabelIndex(index.tasks)` and
 *      compares it to the stored `index.labels`. A mismatch → SUGGEST `tpm task reindex` (never
 *      rebuilds the index).
 *
 *   4. OLD-FORMAT DETECT — imports the migrator's `detectStore` (the ONE old-format detector; NOT
 *      re-implemented). When a CLEAN old markdown-only store is detected, the doctor SUGGESTS
 *      `tpm task migrate` (never migrates).
 *
 * ── STRICTLY READ-ONLY ── recompute + compare only. Conversion is `tpm-task-migrate.js` and a
 * rebuild is `tpm task reindex`, both run explicitly by a human.
 *
 * ── COMPOSES the blessed lib — re-implements no validation/hash/detection/derivation ──
 *   - lib/base.js (io.readCanonicalSync / version.migrate / validate.validateEnvelope /
 *                  envelope.KNOWN_KINDS / hash.hashRecord) — reached ONLY through the phase-02
 *                  indirection (reference-in-place, OQ5).
 *   - lib/task-schema.js  · validatePayload            — the LOCKED task payload validator.
 *   - lib/task-model.js   · listBodyPaths / deriveLabelIndex / indexPathFor — nested scan + label map.
 *   - tpm-task-migrate.js · detectStore / MigrateError — the ONE old-format detector.
 *
 * ── NODE-INVOKABLE ── run via `npx tpm task doctor …` (routed), or bare `node tools/task/tpm-task-doctor.js …`;
 *   programmatic callers `require()` it for `runDoctor(...)`. Zero third-party deps; Node built-ins only.
 *
 * USAGE
 *   npx tpm task doctor --tasks-dir <dir> [--json]
 *
 * FLAGS
 *   --tasks-dir <dir>  REQUIRED. The task store root (holds bodies/<bucket>/ + tasks-index.json).
 *                      READ-ONLY.
 *   --json             Emit the structured report as JSON instead of human text.
 *   --help             Show this usage.
 *
 * EXIT CODES
 *   0  clean store — no problems (advisories like UNSTAMPED allowed).
 *   1  problems found — an invalid record, hash-drift, a label-index mismatch, a missing/corrupt
 *      index beside bodies, OR a detected old-format store. Still report-only; nothing is written.
 *   2  usage error — bad flags, missing --tasks-dir, or an unreadable store dir.
 */
const fs = require('fs');
const path = require('path');

const base = require('./lib/base');
const { KNOWN_KINDS } = base.envelope;
const { migrate } = base.version;
const { validateEnvelope } = base.validate;
const { readCanonicalSync } = base.io;
const { hashRecord } = base.hash;

const { validatePayload } = require('./lib/task-schema');
const model = require('./lib/task-model');
const { detectStore, MigrateError } = require('./tpm-task-migrate');

// The derived-body banner token stamped by task-converter.renderBanner:
//   `<!-- generated from: <12hex> -->`  (12 lowercase hex = hash.hashRecord over the whole record).
const GEN_FROM_RE = /<!-- generated from:\s+([0-9a-f]{12})\s+-->/;

// ── per-body checks (canonical JSON) ─────────────────────────────────────────

/**
 * checkBody(jsonPath, relFile) -> row
 *   { file, id, validate:{status,stage?,problem?}, drift:{status,bannerHash?,currentHash?} }
 * Read → migrate → validate with granular try/catch so the FAILING STAGE is labeled rather than
 * crashing the run. Drift runs off the RAW on-disk record whenever the file parsed.
 */
function checkBody(jsonPath, relFile) {
  const result = {
    file: relFile,
    id: null,
    validate: { status: 'OK' },
    drift: { status: 'NONE' },
  };

  // read (fail-loud parse)
  let raw = null;
  try {
    raw = readCanonicalSync(jsonPath);
  } catch (e) {
    result.validate = { status: 'FAIL', stage: 'read', problem: e.message };
    return result; // nothing else is trustworthy without a parse
  }
  result.id = raw && raw.id != null ? String(raw.id) : null;

  // migrate (refuse-unknown-newer fires here)
  let migrated = null;
  try {
    migrated = migrate(raw);
  } catch (e) {
    result.validate = { status: 'FAIL', stage: 'migrate', problem: e.message };
  }

  // validate (envelope + kind + task payload)
  if (migrated) {
    try {
      validateEnvelope(migrated, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });
    } catch (e) {
      result.validate = { status: 'FAIL', stage: 'validate', problem: e.message };
    }
  }

  // drift: independent of the validate verdict (raw parsed)
  result.drift = checkDrift(jsonPath, raw);
  return result;
}

/**
 * checkDrift(jsonPath, raw) -> { status, bannerHash?, currentHash? }
 * READ-ONLY: recompute hashRecord(raw) and compare to the derived `.md` sibling's
 * `<!-- generated from: <12hex> -->` banner. Never re-renders, never rewrites.
 */
function checkDrift(jsonPath, raw) {
  if (raw == null) return { status: 'NONE' };
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  if (!fs.existsSync(mdPath)) return { status: 'NONE' }; // no derived file → nothing to drift-check
  const md = fs.readFileSync(mdPath, 'utf8');
  const currentHash = hashRecord(raw);
  const bm = GEN_FROM_RE.exec(md);
  if (!bm) return { status: 'UNSTAMPED', currentHash }; // .md carries no banner (hand-made / legacy)
  const bannerHash = bm[1];
  if (bannerHash === currentHash) return { status: 'OK', bannerHash, currentHash };
  return { status: 'DRIFT', bannerHash, currentHash };
}

// ── label-index consistency ──────────────────────────────────────────────────

/**
 * checkLabelIndex(tasksDir, bodyCount) -> { status, suggestion?, problem?, expected?, stored? }
 *   OK       — stored labels === deriveLabelIndex(index.tasks).
 *   MISMATCH — the two differ → SUGGEST reindex (never rebuild).
 *   CORRUPT  — tasks-index.json is unparseable / wrong shape → SUGGEST reindex.
 *   MISSING  — bodies exist but there is no tasks-index.json → SUGGEST reindex.
 *   NONE     — empty store (no index, no bodies): nothing to check.
 * READ-ONLY: recompute + compare only.
 */
function checkLabelIndex(tasksDir, bodyCount) {
  const indexPath = model.indexPathFor(tasksDir);
  const reindexHint = 'npx tpm task reindex --tasks-dir "' + tasksDir + '"';

  if (!fs.existsSync(indexPath)) {
    if (bodyCount > 0) {
      return { status: 'MISSING', suggestion: reindexHint };
    }
    return { status: 'NONE' }; // empty store
  }

  let index;
  try {
    index = readCanonicalSync(indexPath);
  } catch (e) {
    return { status: 'CORRUPT', problem: e.message, suggestion: reindexHint };
  }
  if (!index || typeof index !== 'object' || !Array.isArray(index.tasks)) {
    return { status: 'CORRUPT', problem: 'tasks-index.json has no `tasks` array', suggestion: reindexHint };
  }

  const expected = model.deriveLabelIndex(index.tasks);
  const stored = index.labels && typeof index.labels === 'object' ? index.labels : {};
  if (JSON.stringify(expected) === JSON.stringify(stored)) {
    return { status: 'OK' };
  }
  return { status: 'MISMATCH', suggestion: reindexHint, expected, stored };
}

// ── old-format detection (whole-store, via the migrator) ──────────────────────

/**
 * checkOldFormat(tasksDir) -> oldFormat row | null
 * Imports the migrator's detectStore (the ONE detector). A SUCCESS means a CLEAN old markdown-only
 * store (bodies/<bucket>/task-<id>.md, no JSON body, no tasks-index.json) → SUGGEST migrate. A
 * MigrateError refusal means it is NOT a clean old store (new-format / partial / empty / not a
 * store) → null, so the caller falls through to the new-format checks. NEVER migrates.
 */
function checkOldFormat(tasksDir) {
  let store;
  try {
    store = detectStore(tasksDir);
  } catch (e) {
    if (!(e instanceof MigrateError)) throw e; // an unexpected error is a real bug, not a refusal
    return null; // refusal → not a clean old store; proceed to new-format checks
  }
  return {
    detected: true,
    bodyCount: store.bodies.length,
    marker: store.marker,
    // Read-only: name the migrator + a placeholder out-dir; the human runs it.
    suggestion: `npx tpm task migrate --in "${tasksDir}" --out-dir "<choose-an-output-dir>"`,
  };
}

// ── the doctor run ────────────────────────────────────────────────────────────

/**
 * runDoctor(opts) -> report
 *   opts.tasksDir — REQUIRED. The task store root (READ-ONLY).
 * Returns { tasksDir, oldFormat, bodies, labelIndex, summary, exitCode }. Writes nothing.
 * Throws (→ exit 2) on a missing/unreadable store dir.
 */
function runDoctor(opts) {
  const options = opts || {};
  const tasksDir = options.tasksDir;
  if (!tasksDir) throw new Error('runDoctor: opts.tasksDir is required (no default)');

  // Fail-loud on an unreadable store dir (usage error → exit 2 at the CLI).
  let stat;
  try {
    stat = fs.statSync(tasksDir);
  } catch (e) {
    throw new Error(`cannot read --tasks-dir '${tasksDir}': ${e.message}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`--tasks-dir '${tasksDir}' is not a directory`);
  }

  // (4) Old-format probe FIRST: a clean old markdown store has NO JSON bodies to validate, so when
  //     it is detected we report + suggest migrate and stop (nothing else applies).
  const oldFormat = checkOldFormat(tasksDir);
  if (oldFormat) {
    return {
      tasksDir,
      oldFormat,
      bodies: [],
      labelIndex: { status: 'SKIPPED' },
      summary: {
        bodies: 0, valid: 0, invalid: 0, drift: 0, unstamped: 0,
        labelIndex: 'SKIPPED', oldFormat: true,
      },
      exitCode: 1, // an old-format store is a problem to surface (needs migration)
    };
  }

  // (1)+(2) New-format bodies: nested bodies/<bucket>/task-<id>.json (model.listBodyPaths).
  const bodyPaths = model.listBodyPaths(tasksDir);
  const bodies = [];
  for (const p of bodyPaths) {
    const rel = path.relative(tasksDir, p).split(path.sep).join('/');
    bodies.push(checkBody(p, rel));
  }

  // (3) Label-index consistency.
  const labelIndex = checkLabelIndex(tasksDir, bodyPaths.length);

  const valid = bodies.filter((b) => b.validate.status === 'OK').length;
  const invalid = bodies.filter((b) => b.validate.status === 'FAIL').length;
  const drift = bodies.filter((b) => b.drift.status === 'DRIFT').length;
  const unstamped = bodies.filter((b) => b.drift.status === 'UNSTAMPED').length;

  // Problems → exit 1. UNSTAMPED is an advisory only (does not fail the run).
  const labelProblem = ['MISMATCH', 'CORRUPT', 'MISSING'].includes(labelIndex.status);
  const problems = invalid + drift + (labelProblem ? 1 : 0);

  return {
    tasksDir,
    oldFormat: null,
    bodies,
    labelIndex,
    summary: {
      bodies: bodies.length,
      valid,
      invalid,
      drift,
      unstamped,
      labelIndex: labelIndex.status,
      oldFormat: false,
    },
    exitCode: problems > 0 ? 1 : 0,
  };
}

// ── report rendering ──────────────────────────────────────────────────────────

function renderHuman(report) {
  const s = report.summary;
  const lines = [];

  if (report.oldFormat) {
    lines.push(`task doctor · ${report.tasksDir}`);
    lines.push(`OLD-FORMAT task store detected (${report.oldFormat.bodyCount} markdown body(ies)` +
      (report.oldFormat.marker != null ? `, Next ID marker ${report.oldFormat.marker}` : '') + ').');
    lines.push('');
    lines.push('  → SUGGEST migrate (the doctor never converts):');
    lines.push('      ' + report.oldFormat.suggestion);
    lines.push('      (or: tpm task migrate)');
    return lines.join('\n');
  }

  lines.push(`task doctor · ${report.tasksDir}`);
  lines.push(
    `${s.bodies} task(s) · ${s.valid} valid · ${s.invalid} invalid · ${s.drift} drift` +
    (s.unstamped ? ` · ${s.unstamped} unstamped` : '') +
    ` · label-index ${s.labelIndex}`,
  );

  for (const b of report.bodies) {
    let line = '  ' + b.file + '  ';
    if (b.validate.status === 'FAIL') {
      line += `FAIL [${b.validate.stage}]: ${b.validate.problem}`;
    } else {
      const tags = ['OK'];
      if (b.drift.status === 'DRIFT') tags.push(`DRIFT (banner ${b.drift.bannerHash} · current ${b.drift.currentHash} — body out of date; re-save via \`tpm task\`)`);
      else if (b.drift.status === 'UNSTAMPED') tags.push('UNSTAMPED (.md has no "generated from" banner)');
      line += tags.join(' · ');
    }
    lines.push(line);
  }

  const li = report.labelIndex;
  if (li.status === 'MISMATCH') {
    lines.push('');
    lines.push('Label index (tasks-index.json.labels) DRIFTED from the rows → SUGGEST reindex:');
    lines.push('  ' + li.suggestion);
  } else if (li.status === 'MISSING') {
    lines.push('');
    lines.push('tasks-index.json is MISSING beside the bodies → SUGGEST reindex:');
    lines.push('  ' + li.suggestion);
  } else if (li.status === 'CORRUPT') {
    lines.push('');
    lines.push(`tasks-index.json is CORRUPT (${li.problem}) → SUGGEST reindex:`);
    lines.push('  ' + li.suggestion);
  }

  if (report.exitCode === 0) {
    lines.push('');
    lines.push('Clean — no problems found. (Read-only: the doctor never writes.)');
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--tasks-dir': opts.tasksDir = next(); break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument '${a}'`);
    }
  }
  return opts;
}

const USAGE = `tpm-task-doctor — READ-ONLY task-store validator + drift detector (#1119)
  run: npx tpm task doctor [--tasks-dir <dir>] [--json]

  --tasks-dir <dir>  OPTIONAL (F4)  the task store root (READ-ONLY): bodies/<bucket>/task-<id>.json
                               (nested bucket layout) + tasks-index.json. Omitted → resolved from the
                               LOCAL project's .claude/claude-tpm/config.json (tasks.tasksDir); the flag
                               OVERRIDES. With NEITHER, FAILS LOUD (never defaults to a live store).
  --json             emit the structured report as JSON
  --help             show this usage

Checks: schema-validate every body · hash-drift (body banner vs hash.hashRecord) · label-index
consistency (SUGGEST reindex on mismatch) · old-format detect (SUGGEST migrate).

Exit: 0 = clean (advisories allowed) · 1 = problems found (report-only) · 2 = usage error.
STRICTLY READ-ONLY: no --fix, no write path. It never migrates and never reindexes — it only
reports and SUGGESTS the human-run command.`;

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write('tpm-task-doctor: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  // F4: --tasks-dir is OPTIONAL — resolve (flag > local project config > FAIL LOUD). A resolution
  // failure (no flag AND no local config) is a usage error → 2, same class as a missing flag was.
  try {
    opts.tasksDir = require('./tpm-task-config').resolveTasksDir(opts.tasksDir, opts.config).tasksDir;
  } catch (e) {
    process.stderr.write('tpm-task-doctor: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  let report;
  try {
    report = runDoctor(opts);
  } catch (e) {
    // A missing/unreadable store dir or a missing required flag is a usage error → 2.
    process.stderr.write('tpm-task-doctor: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(renderHuman(report) + '\n');
  return report.exitCode;
}

module.exports = {
  runDoctor,
  checkBody,
  checkDrift,
  checkLabelIndex,
  checkOldFormat,
  renderHuman,
  parseArgv,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
