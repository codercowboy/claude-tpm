'use strict';
/**
 * version.js — semver compare + migration registry + migrate() (kind-agnostic).
 *
 * LOCKED versioning contract (json-format-spec "The envelope"):
 *  - Readers MUST tolerate + migrate an OLDER-but-known schemaVersion on load (never
 *    hard-fail on an old version).
 *  - An UNKNOWN (newer-than-code) schemaVersion is a LOUD, safe refusal — this, paired
 *    with preserve-unknown (envelope.js), stops old code silently destroying new data.
 *  - "1.0.0" is the first published version.
 *
 * Zero third-party deps; Node built-ins only.
 */

const CURRENT = '1.0.0';

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) throw new Error(`version: not a valid semver string: '${v}'`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** compare(a, b) -> -1 | 0 | 1  (semver ordering). */
function compare(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * migrations: { "<fromVersion>": (record) -> record }
 * Keyed by the version a migrator upgrades FROM; each returns the record at the NEXT
 * version, chained upward until CURRENT. Empty today (1.0.0 is first published); the
 * mechanism is exercised by the version-tolerance test with a supplied registry.
 */
const migrations = {};

/**
 * migrate(record, reg = migrations) -> record
 *  - schemaVersion === CURRENT           -> return as-is.
 *  - OLDER but known (has a migrator)     -> apply chained migrators up to CURRENT.
 *  - OLDER with no migrator path          -> THROW (no path).
 *  - NEWER than CURRENT (unknown)         -> THROW a loud refusal naming the version.
 *
 * `reg` is injectable so callers/tests can supply their own migrator table without
 * mutating the module singleton; defaults to the shared registry.
 */
function migrate(record, reg = migrations) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('migrate: record must be an object');
  }
  const v = record.schemaVersion;
  if (v === undefined || v === null) {
    throw new Error('migrate: record is missing schemaVersion');
  }
  const cmp = compare(v, CURRENT);
  if (cmp === 0) return record;
  if (cmp > 0) {
    throw new Error(
      `migrate: refusing record with newer schemaVersion '${v}' — this code understands up ` +
      `to '${CURRENT}'; upgrade the tooling before reading this file.`
    );
  }
  // Older but (hopefully) known — walk the migrator chain upward.
  let cur = record;
  let guard = 0;
  while (compare(cur.schemaVersion, CURRENT) < 0) {
    const step = reg[cur.schemaVersion];
    if (typeof step !== 'function') {
      throw new Error(`migrate: no migration path from schemaVersion '${cur.schemaVersion}' to '${CURRENT}'`);
    }
    const next = step(cur);
    if (next === null || typeof next !== 'object' || compare(next.schemaVersion, cur.schemaVersion) <= 0) {
      throw new Error(`migrate: migrator for '${cur.schemaVersion}' did not advance the schemaVersion`);
    }
    cur = next;
    if (++guard > 100) throw new Error('migrate: migration chain did not converge');
  }
  return cur;
}

module.exports = { CURRENT, compare, migrate, migrations };
