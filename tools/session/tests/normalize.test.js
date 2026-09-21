'use strict';
/**
 * normalize.test.js — array-canonical normalisation (DoD row 4).
 *
 * A bare string normalises to a length-1 array; multi-value is always an array; a
 * length-1 array stays length-1; undefined/null -> []. Also proves the returned array is
 * a COPY (mutating it does not mutate the input).
 *
 * Run: node tests/normalize.test.js
 */
const { assert, test, done } = require('./helpers/harness');
const { normalizeArray } = require('../../lib/normalize');

test('bare string -> length-1 array', () => {
  assert.deepStrictEqual(normalizeArray('only-one'), ['only-one']);
});

test('array passes through as-is', () => {
  assert.deepStrictEqual(normalizeArray(['a', 'b']), ['a', 'b']);
});

test('length-1 array stays a length-1 array', () => {
  assert.deepStrictEqual(normalizeArray(['solo']), ['solo']);
});

test('undefined -> [] and null -> []', () => {
  assert.deepStrictEqual(normalizeArray(undefined), []);
  assert.deepStrictEqual(normalizeArray(null), []);
});

test('returns a copy, not the same array reference', () => {
  const input = ['x'];
  const out = normalizeArray(input);
  out.push('y');
  assert.deepStrictEqual(input, ['x'], 'input must be untouched');
});

done('normalize.test');
