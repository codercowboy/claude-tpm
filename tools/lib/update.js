'use strict';
/**
 * update.js — generic table-driven apply-update + trim-non-editable (kind-agnostic).
 *
 * A pure, table-driven filter: the kind hands in its editable-field table (§2 of the
 * build-plan / json-format-spec "Field reference"), and this module applies ONLY the
 * editable fields and projects a record down to its editable set. It knows nothing
 * about any specific kind, so #1112's task kind reuses it unchanged.
 *
 * Scope of the GENERIC layer (documented division of labour):
 *  - It performs REPLACE-semantics sets on scalar/array dotted paths (e.g. "handoff.where",
 *    "handoff.in_flight"). string[]-typed fields pass through normalizeArray.
 *  - Mechanical fields (not in the table) and array-ELEMENT editables (table keys
 *    containing "[]", e.g. "log[].what") are NOT set here — they are IGNORED, not errors.
 *    Array-element append/add (seq allocation, slug minting) is a kind-specific op done
 *    by the kind's model (session-model.appendLog / addPunchlist), never a blind patch.
 *
 * Zero third-party deps; Node built-ins only.
 */
const { normalizeArray } = require('./normalize');
const { deepClone, getPath, setPath } = require('./_util');

/**
 * applyUpdate(record, patch, { editableTable, kind }) -> record  (a NEW record)
 *
 * For each dotted path in `patch`: set it ONLY if the editableTable marks it editable
 * with replace-mode. Mechanical/unknown keys are IGNORED (not an error). Array-element
 * table keys ("...[]...") are skipped (handled by the kind's ops). string[]-typed fields
 * are normalised. Untouched parts (incl. unknown keys) are preserved via a deep clone.
 */
function applyUpdate(record, patch, opts) {
  const options = opts || {};
  const { editableTable } = options;
  if (!editableTable || typeof editableTable !== 'object') {
    throw new Error('applyUpdate: opts.editableTable is required');
  }
  const out = deepClone(record);
  if (!patch || typeof patch !== 'object') return out;

  for (const key of Object.keys(patch)) {
    const spec = editableTable[key];
    if (!spec) continue;                     // mechanical or unknown -> ignored, not an error
    if (key.indexOf('[]') !== -1) continue;  // array-element editables -> kind's ops, not here
    if (spec.edit && spec.edit !== 'replace') continue; // generic layer only does replace-mode sets
    let value = patch[key];
    if (spec.type === 'string[]') value = normalizeArray(value);
    setPath(out, key, value);
  }
  return out;
}

/**
 * trimNonEditable(record, { editableTable, kind }) -> object
 *
 * Project the record down to ONLY its editable set -> the thin/editable export shape.
 * Only scalar/array dotted-path editables are projected; array-element editables
 * ("...[]...") are omitted (their projection is kind-specific). A path absent from the
 * record is skipped. Returns a NEW object; the input is not mutated.
 *
 * (Per Q3 the SESSION kind ships NO thin export; this stays in the base lib for #1112.)
 */
function trimNonEditable(record, opts) {
  const options = opts || {};
  const { editableTable } = options;
  if (!editableTable || typeof editableTable !== 'object') {
    throw new Error('trimNonEditable: opts.editableTable is required');
  }
  const out = {};
  for (const key of Object.keys(editableTable)) {
    if (key.indexOf('[]') !== -1) continue;
    const value = getPath(record, key);
    if (value !== undefined) setPath(out, key, deepClone(value));
  }
  return out;
}

module.exports = { applyUpdate, trimNonEditable };
