'use strict';
/**
 * export-scaffold.js — kind-agnostic export scaffolding (filter / combine / one-vs-many
 * / JSON-vs-human dispatch).
 *
 * LOCKED shared piece (json-format-spec decision 4 / export-spec locked #4): filtering,
 * multi-record combine, one-file-vs-per-file, and JSON-vs-human dispatch live here; only
 * the JSON->human converter is kind-specific and is INJECTED. The session tool injects
 * session-converter.render; #1112 injects the task converter.
 *
 * Zero third-party deps; Node built-ins only.
 */
const { deepClone } = require('./_util');

/**
 * selectRecords(records, { filter }) -> records[]
 *  - filter nullish            -> all records (a copy).
 *  - filter is a predicate fn  -> records.filter(fn).
 *  - filter is an array        -> a #1092 search result-set; keep records that are IN it
 *                                 (identity/equality via Set) — compose, don't re-match.
 */
function selectRecords(records, opts) {
  const options = opts || {};
  const { filter } = options;
  if (!Array.isArray(records)) throw new Error('selectRecords: records must be an array');
  if (filter === undefined || filter === null) return records.slice();
  if (typeof filter === 'function') return records.filter(filter);
  if (Array.isArray(filter)) {
    const set = new Set(filter);
    return records.filter((r) => set.has(r));
  }
  throw new Error('selectRecords: filter must be a predicate function, an array result-set, or nullish');
}

/**
 * combine(records, { mode }) -> groups[]
 *  - "one-file" -> [ [ ...all records ] ]   (a single output unit)
 *  - "per-file" -> [ [r0], [r1], ... ]      (one output unit per record)
 * Each group is a list of records the dispatcher renders into one output file.
 */
function combine(records, opts) {
  const options = opts || {};
  const { mode } = options;
  if (!Array.isArray(records)) throw new Error('combine: records must be an array');
  if (mode === 'one-file') return [records.slice()];
  if (mode === 'per-file') return records.map((r) => [r]);
  throw new Error(`combine: unknown mode '${mode}' (expected 'one-file' | 'per-file')`);
}

/**
 * dispatch(group, { style, converter, nameFor, combinedName }) -> [{ suggestedName, body }]
 *
 * Renders ONE group (a list of records) into output file descriptors:
 *  - style "json":  a single file whose body is the group serialised. A length-1 group
 *                   emits the bare envelope; a multi-record group emits a bare ARRAY of
 *                   envelopes (export-spec Q4). Trailing newline.
 *  - style "human": requires `converter`; each record is rendered and, for a multi-record
 *                   group, concatenated with a blank-line separator (full per-session
 *                   render repeated — export-spec Q4). One file per group.
 * `nameFor(record, idx)` (optional) supplies the base name; `combinedName` names a
 * multi-record file (default "combined"). Returns a list so a group always yields >=1 file.
 */
function dispatch(group, opts) {
  const options = opts || {};
  const { style, converter } = options;
  if (!Array.isArray(group)) throw new Error('dispatch: group must be an array of records');
  const nameFor = typeof options.nameFor === 'function' ? options.nameFor : (r, i) => `record-${i}`;
  const combinedName = options.combinedName || 'combined';

  if (style === 'json') {
    if (group.length === 1) {
      return [{ suggestedName: `${nameFor(group[0], 0)}.json`, body: JSON.stringify(group[0], null, 2) + '\n' }];
    }
    const arr = group.map((r) => deepClone(r)); // bare array of envelopes (Q4), no wrapper
    return [{ suggestedName: `${combinedName}.json`, body: JSON.stringify(arr, null, 2) + '\n' }];
  }

  if (style === 'human') {
    if (typeof converter !== 'function') {
      throw new Error('dispatch: style "human" requires a converter function');
    }
    const bodies = group.map((r) => converter(r));
    if (group.length === 1) {
      return [{ suggestedName: `${nameFor(group[0], 0)}.md`, body: bodies[0] }];
    }
    return [{ suggestedName: `${combinedName}.md`, body: bodies.join('\n\n') }];
  }

  throw new Error(`dispatch: unknown style '${style}' (expected 'json' | 'human')`);
}

module.exports = { selectRecords, combine, dispatch };
