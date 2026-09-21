'use strict';
/**
 * validate.js — base envelope validator, delegating payload validation to the kind
 * (kind-agnostic).
 *
 * Asserts the shared envelope (semver schemaVersion + a known/present kind), then hands
 * the payload to the kind-supplied validator. The base lib itself knows nothing about
 * any specific kind's payload shape (session-schema.validatePayload supplies that).
 *
 * Fails LOUD + structured (throws Error naming the violation). Zero third-party deps.
 */

/**
 * validateEnvelope(record, { payloadValidator, knownKinds }) -> record
 *  - Asserts record is an object with a semver schemaVersion string.
 *  - Asserts kind is a non-empty string; if `knownKinds` is supplied, kind must be in it.
 *  - If `payloadValidator` is supplied, calls payloadValidator(record[kind], record).
 *    (The full record is passed as a second arg so a kind validator can reach sibling
 *     top-level blocks if its on-disk shape keeps them as siblings — see HANDOFF nesting
 *     note. Base stays agnostic to which shape the kind chose.)
 *  - Returns the record on success; throws on any violation.
 */
function validateEnvelope(record, opts) {
  const options = opts || {};
  const { payloadValidator, knownKinds } = options;

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('validateEnvelope: record must be an object');
  }
  const { schemaVersion, kind } = record;
  if (typeof schemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(schemaVersion)) {
    throw new Error(`validateEnvelope: invalid schemaVersion '${schemaVersion}' (expected a semver string)`);
  }
  if (typeof kind !== 'string' || kind === '') {
    throw new Error(`validateEnvelope: invalid kind '${kind}' (expected a non-empty string)`);
  }
  if (knownKinds && !Object.prototype.hasOwnProperty.call(knownKinds, kind)) {
    throw new Error(`validateEnvelope: unknown kind '${kind}' (known: ${Object.keys(knownKinds).join(', ') || 'none'})`);
  }
  if (payloadValidator !== undefined) {
    if (typeof payloadValidator !== 'function') {
      throw new Error('validateEnvelope: payloadValidator must be a function when supplied');
    }
    payloadValidator(record[kind], record);
  }
  return record;
}

module.exports = { validateEnvelope };
