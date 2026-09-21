#!/usr/bin/env node
'use strict';
/**
 * tpm-session-doctor.js — the READ-ONLY session-store validator / drift detector (#1119 + the
 * folded #1114 A/D "detect old-format + suggest migrate").
 *
 * It (a) schema+version-validates every canonical `session-<NNNN>.json` — discovered in the CANONICAL
 * NESTED per-session-folder layout (`session-<NNNN>/session-<NNNN>.json`, the live store's real shape
 * per the LOCKED spec, Q-F) — and
 * reports corruption / invalidity / unknown-newer-version loud + structured; (b) detects human-file
 * DRIFT by recomputing the content hash of the current JSON and comparing it to the
 * `(generated from: <12hex>)` token stamped in the derived `.md` banner (Q-D); and (c) detects OLD-FORMAT 3-file sessions with
 * no JSON counterpart and PRINTS a ready-to-run `tpm-session-migrate.js` suggestion.
 *
 * ── STRICTLY READ-ONLY ── the doctor NEVER writes, mutates, migrates, converts, or re-renders
 * ANYTHING. There is no `--fix`, no write path of any kind. It recomputes + compares only. A
 * fixing doctor would violate both the read-only remit and the never-auto-migrate rule (conversion
 * is `tpm-session-migrate.js`, run explicitly by a human).
 *
 * ── COMPOSES the blessed lib — re-implements no validation/hash/detection ──
 *   - lib/envelope.js       · readEnvelope(path)          — fail-loud read (+ _raw on-disk bytes).
 *   - lib/version.js        · migrate(record)             — refuse-unknown-NEWER guard.
 *   - lib/validate.js       · validateEnvelope(record,…)  — envelope + kind gate.
 *   - lib/session-schema.js · validatePayload             — the LOCKED payload validator.
 *   - lib/hash.js           · hashRecord(record)          — the SHARED content hash (drift anchor).
 *   - tpm-session-migrate   · detectShape(dir)            — the ONE old-format detector (collision C-A).
 *
 * ── DRIFT SEMANTICS (Q-D.4) ── the doctor hashes the RAW on-disk record (readEnvelope._raw), NOT
 *  the post-`migrate` in-memory record, because the banner was stamped from the on-disk bytes at
 *  save. Moot today (no migrations registered → raw === migrated); it matters only once real
 *  migrations exist, at which point hashing raw keeps the compare meaningful against a banner made
 *  from older bytes.
 *
 * ── NODE-INVOKABLE, NO BIN (Q5) ── run via bare `node session-tooling/tpm-session-doctor.js …`;
 *  programmatic callers `require()` it for `runDoctor(...)`.
 *
 * Zero third-party deps; Node built-ins only.
 *
 * USAGE
 *   node tpm-session-doctor.js --sessions-dir <dir> [--json] [--strict]
 *
 * FLAGS
 *   --sessions-dir <dir>  REQUIRED. The sessions store. Canonical JSON is discovered in the nested
 *                         per-session-folder layout (session-<NNNN>/session-<NNNN>.json, the live
 *                         store's canonical shape); old-format 3-file subdirectories are detected
 *                         too. READ-ONLY.
 *   --json                Emit the structured report as JSON instead of human text.
 *   --strict              Promote advisories (drift / unstamped / old-format / number-form) to a
 *                         non-zero exit (2). By default only a validation FAIL exits non-zero (1).
 *   --help                Show this usage.
 *
 * EXIT CODES
 *   0  no validation FAILs (advisories allowed).
 *   1  at least one validation FAIL (unreadable / unknown-newer / schema-invalid).
 *   2  --strict + at least one advisory (and no hard FAIL).
 */
const fs = require('fs');
const path = require('path');

const { KNOWN_KINDS, readEnvelope } = require('../lib/envelope');
const { migrate } = require('../lib/version');
const { validateEnvelope } = require('../lib/validate');
const { validatePayload } = require('./lib/session-schema');
const { hashRecord } = require('../lib/hash');
const { detectShape, MigrateError } = require('./tpm-session-migrate');

const SESSION_JSON_RE = /^session-(\d+)\.json$/;                 // canonical file inside a per-session folder
// The `(generated from: <12hex>)` token on banner line 2 (wording per Q-D.2, Jason 2026-09-20;
// was ` · gen-from <12hex>`). The literal `(generated from: ` prefix + a 12-hex run cannot collide
// with the abbreviated id (which contains `…` and dashes). The closing `)` is a hard boundary, so
// no negative-lookahead is needed to hold the 12-char edge — unlike the old token whose trailing
// italic `_` (a word char) defeated a `\b`.
const GEN_FROM_RE = /\(generated from:\s+([0-9a-f]{12})\)/;
const CANON_NUMBER_RE = /^\d{4,}$/;                              // canonical stored form (zero-padded width-4+)

// ── per-session checks (canonical JSON) ──────────────────────────────────────

/**
 * checkSession(dir, name) -> result row
 *   { file, number, validate:{status,stage?,problem?}, drift:{status,bannerHash?,currentHash?},
 *     numberForm:{status,detail?} }
 * Read → migrate → validate with granular try/catch so the FAILING STAGE is labeled rather than
 * crashing the run. Drift + number-form run off the RAW on-disk bytes whenever the file was readable.
 */
function checkSession(dir, name) {
  const jsonPath = path.join(dir, name);
  const m = SESSION_JSON_RE.exec(name);
  const fileNumber = m ? m[1] : null;
  const result = {
    file: name,
    number: null,
    validate: { status: 'OK' },
    drift: { status: 'NONE' },
    numberForm: { status: 'OK' },
  };

  // read (fail-loud) → capture raw on-disk bytes
  let raw = null;
  try {
    raw = readEnvelope(jsonPath)._raw;
  } catch (e) {
    result.validate = { status: 'FAIL', stage: 'read', problem: e.message };
    return result; // nothing else is trustworthy without a parse
  }
  result.number = raw && raw.meta ? raw.meta.number : null;

  // migrate (refuse-unknown-newer fires here)
  let migrated = null;
  try {
    migrated = migrate(raw);
  } catch (e) {
    result.validate = { status: 'FAIL', stage: 'migrate', problem: e.message };
  }

  // validate (schema + kind + payload)
  if (migrated) {
    try {
      validateEnvelope(migrated, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });
    } catch (e) {
      result.validate = { status: 'FAIL', stage: 'validate', problem: e.message };
    }
  }

  // drift + number-form: use raw (readable), independent of the validate verdict
  result.drift = checkDrift(dir, fileNumber, raw);
  result.numberForm = checkNumberForm(raw, fileNumber);
  return result;
}

/**
 * checkDrift(dir, fileNumber, raw) -> { status, bannerHash?, currentHash? }
 * READ-ONLY: recompute hashRecord(raw) and compare to the `.md` banner's `(generated from: …)`
 * token. Never re-renders, never rewrites.
 */
function checkDrift(dir, fileNumber, raw) {
  if (fileNumber == null || raw == null) return { status: 'NONE' };
  const mdPath = path.join(dir, `session-${fileNumber}.md`);
  if (!fs.existsSync(mdPath)) return { status: 'NONE' }; // no derived file → nothing to drift-check
  const md = fs.readFileSync(mdPath, 'utf8');
  const currentHash = hashRecord(raw);
  const bm = GEN_FROM_RE.exec(md);
  if (!bm) return { status: 'UNSTAMPED', currentHash }; // .md predates the hash
  const bannerHash = bm[1];
  if (bannerHash === currentHash) return { status: 'OK', bannerHash, currentHash };
  return { status: 'DRIFT', bannerHash, currentHash };
}

/**
 * checkNumberForm(raw, fileNumber) -> { status, detail? }  (rest-of-#1119 advisory)
 * P02 normalizes + `validatePayload` asserts non-empty (covered by the validate stage); this ADDS a
 * cheap advisory that meta.number is the canonical zero-padded form AND agrees with the filename.
 */
function checkNumberForm(raw, fileNumber) {
  const num = raw && raw.meta ? raw.meta.number : undefined;
  if (typeof num !== 'string' || !CANON_NUMBER_RE.test(num)) {
    return { status: 'WARN', detail: `meta.number ${JSON.stringify(num)} is not the canonical zero-padded form (/^\\d{4,}$/)` };
  }
  if (fileNumber != null && num !== fileNumber) {
    return { status: 'WARN', detail: `meta.number "${num}" disagrees with the filename number "${fileNumber}"` };
  }
  return { status: 'OK' };
}

// ── old-format detection (subdirectories) ────────────────────────────────────

function dirHasCanonicalJson(dirPath) {
  try {
    return fs.readdirSync(dirPath).some((n) => SESSION_JSON_RE.test(n));
  } catch (_e) {
    return false;
  }
}

function dirHasLegacyMarkup(dirPath) {
  try {
    return fs.readdirSync(dirPath).some((n) => {
      const low = n.toLowerCase();
      return low.endsWith('.md') || low.endsWith('.txt');
    });
  } catch (_e) {
    return false;
  }
}

/**
 * checkOldFormat(dirPath, subName) -> oldFormat row | null
 *  - clean marked-3-file + NO session-<NNNN>.json  → migratable, with a ready-to-run suggestion.
 *  - clean marked-3-file + HAS the json            → null (already migrated; nothing to report).
 *  - detectShape refuses BUT the dir looks like a legacy session (markup, no canonical json) →
 *    not-auto-migratable advisory (names detectShape's reason). NEVER converts.
 *  - anything else (a new-format dir, an unrelated dir) → null (skip silently).
 */
function checkOldFormat(dirPath, subName) {
  let shape;
  try {
    shape = detectShape(dirPath);
  } catch (e) {
    if (!(e instanceof MigrateError)) throw e; // an unexpected error is a real bug, not a refusal
    if (dirHasCanonicalJson(dirPath)) return null; // has canonical data already
    if (!dirHasLegacyMarkup(dirPath)) return null; // not a session dir at all
    return { dir: subName, migratable: false, reason: e.message };
  }
  const jsonPath = path.join(dirPath, `session-${shape.number}.json`);
  if (fs.existsSync(jsonPath)) return null; // clean trio but already migrated
  return {
    dir: subName,
    number: shape.number,
    migratable: true,
    // The doctor is read-only: it names the migrator + a placeholder out-dir; the human runs it.
    suggestion: `node tpm-session-migrate.js --in "${dirPath}" --out-dir "<choose-an-output-dir>"`,
  };
}

// ── the doctor run ────────────────────────────────────────────────────────────

/**
 * runDoctor(opts) -> report
 *   opts.sessionsDir — REQUIRED. Directory to inspect (READ-ONLY).
 *   opts.strict      — promote advisories to a non-zero exit.
 * Returns { sessionsDir, results, oldFormat, summary, exitCode }. Writes nothing.
 */
function runDoctor(opts) {
  const options = opts || {};
  const sessionsDir = options.sessionsDir;
  if (!sessionsDir) throw new Error('runDoctor: opts.sessionsDir is required (no default)');
  const strict = !!options.strict;

  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`runDoctor: cannot read --sessions-dir '${sessionsDir}': ${e.message}`);
  }

  // Discovery: NESTED per-session folders are THE canonical layout (json-format-spec §"On-disk naming
  // + location", Q-F) — each session lives in its OWN dir as `session-<NNNN>/session-<NNNN>.json`
  // alongside its derived `session-<NNNN>.md`. The former additive FLAT top-level scan was REMOVED at
  // Q-F (the writer + migrator now emit nested too, so a flat scan can only double-count).
  const results = [];

  // Immediate subdirectories. A subdir that holds a canonical `session-<NNNN>.json` is a session:
  //    validate + drift-check it IN PLACE (the `.md` sibling is right there). Only a subdir WITHOUT
  //    canonical JSON falls through to old-format detect + suggest (never convert).
  const oldFormat = [];
  const subdirs = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const sub of subdirs) {
    const subPath = path.join(sessionsDir, sub);
    let subEntries;
    try {
      subEntries = fs.readdirSync(subPath);
    } catch (_e) {
      subEntries = [];
    }
    const nestedJson = subEntries.filter((n) => SESSION_JSON_RE.test(n)).sort();
    if (nestedJson.length) {
      for (const name of nestedJson) {
        const row = checkSession(subPath, name);
        row.file = path.join(sub, name); // disambiguate nested rows in the report (e.g. session-0021/session-0021.json)
        results.push(row);
      }
      continue; // a dir with canonical JSON is a migrated session, not an old-format candidate
    }
    const row = checkOldFormat(subPath, sub);
    if (row) oldFormat.push(row);
  }

  const valid = results.filter((r) => r.validate.status === 'OK').length;
  const invalid = results.filter((r) => r.validate.status === 'FAIL').length;
  const drift = results.filter((r) => r.drift.status === 'DRIFT').length;
  const unstamped = results.filter((r) => r.drift.status === 'UNSTAMPED').length;
  const numberWarn = results.filter((r) => r.numberForm.status === 'WARN').length;
  const migratable = oldFormat.filter((o) => o.migratable).length;

  const advisories = drift + unstamped + numberWarn + oldFormat.length;
  let exitCode = 0;
  if (invalid > 0) exitCode = 1;
  else if (strict && advisories > 0) exitCode = 2;

  return {
    sessionsDir,
    results,
    oldFormat,
    summary: {
      sessions: results.length,
      valid,
      invalid,
      drift,
      unstamped,
      numberWarn,
      oldFormat: oldFormat.length,
      migratable,
    },
    exitCode,
  };
}

// ── report rendering ──────────────────────────────────────────────────────────

function renderHuman(report) {
  const lines = [];
  for (const r of report.results) {
    let line = '  ' + r.file + '  ';
    if (r.validate.status === 'FAIL') {
      line += `FAIL [${r.validate.stage}]: ${r.validate.problem}`;
    } else {
      const tags = ['OK'];
      if (r.drift.status === 'DRIFT') tags.push(`DRIFT (banner ${r.drift.bannerHash} · current ${r.drift.currentHash})`);
      else if (r.drift.status === 'UNSTAMPED') tags.push('UNSTAMPED (.md has no "generated from" token — re-save to stamp)');
      if (r.numberForm.status === 'WARN') tags.push(`WARN: ${r.numberForm.detail}`);
      line += tags.join(' · ');
    }
    lines.push(line);
  }

  const s = report.summary;
  lines.unshift(
    `session doctor · ${report.sessionsDir}\n` +
    `${s.sessions} session(s) · ${s.valid} valid · ${s.invalid} invalid · ${s.drift} drift · ${s.oldFormat} old-format`,
  );

  if (report.oldFormat.length) {
    lines.push('');
    lines.push(`Old-format sessions (${report.oldFormat.length}; ${s.migratable} auto-migratable):`);
    for (const o of report.oldFormat) {
      if (o.migratable) lines.push(`  ${o.dir}  → ${o.suggestion}`);
      else lines.push(`  ${o.dir}  not auto-migratable — ${o.reason}`);
    }
    if (s.migratable) {
      lines.push('');
      lines.push(`Detection + suggestion ONLY — the doctor never converts. Run the command(s) above by hand (${s.migratable} session(s)).`);
    }
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
      case '--sessions-dir': opts.sessionsDir = next(); break;
      case '--json': opts.json = true; break;
      case '--strict': opts.strict = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument '${a}'`);
    }
  }
  return opts;
}

const USAGE = `tpm-session-doctor — READ-ONLY session-store validator + drift detector (#1119)
  run: node session-tooling/tpm-session-doctor.js --sessions-dir <dir> [--json] [--strict]

  --sessions-dir <dir>  REQUIRED  the sessions store (READ-ONLY). Canonical session-<NNNN>.json is
                                  found nested per-session (session-<NNNN>/session-<NNNN>.json, the
                                  canonical layout); old-format 3-file subdirectories detected too
  --json                emit the structured report as JSON
  --strict              promote advisories (drift / unstamped / old-format / number-form) to exit 2
  --help                show this usage

Exit: 0 = healthy (advisories allowed) · 1 = a validation FAIL · 2 = --strict + an advisory.
STRICTLY READ-ONLY: no --fix, no write path. Old-format sessions are DETECTED + a migrate command
is SUGGESTED; the doctor never converts (that is tpm-session-migrate.js, run explicitly by a human).`;

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write('tpm-session-doctor: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  try {
    const report = runDoctor(opts);
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(renderHuman(report) + '\n');
    return report.exitCode;
  } catch (e) {
    process.stderr.write('tpm-session-doctor: ' + String(e.message) + '\n');
    return 1;
  }
}

module.exports = {
  runDoctor,
  checkSession,
  checkDrift,
  checkNumberForm,
  checkOldFormat,
  renderHuman,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
