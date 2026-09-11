#!/usr/bin/env node
/**
 * check-json.js — read a headless-`claude -p` answer on STDIN, extract the JSON object the probe asked
 * it to return, and assert field expectations. Zero-dep. This is what makes the consumer smoke tests
 * DETERMINISTIC: instead of grepping prose, we prompt the consumer-claude for a strict JSON schema and
 * check its fields.
 *
 * Usage (piped):  <claude -p …> | node check-json.js <checks…>
 *   --truthy   <path>            field is truthy
 *   --eq       <path>=<value>    String(field) === value
 *   --includes <path>=<value>    field is an array containing an element that (case-insensitively)
 *                                includes value
 * <path> is dot-notation (e.g. `result.count`). Prints ✓/✗ per check; exit 0 iff all pass, 1 otherwise
 * (or if no JSON object could be extracted from the output).
 */
'use strict';
const fs = require('fs');

// Extract the first BALANCED {...} object from noisy model output (strips ``` fences first).
function extractJson(raw) {
  const s = String(raw).replace(/```[a-z]*/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_e) { /* keep scanning for a later brace */ }
      }
    }
  }
  return null;
}

const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function parseChecks(argv) {
  const checks = [];
  for (let i = 0; i < argv.length; i += 1) {
    const kind = argv[i].replace(/^--/, '');
    const spec = argv[i + 1] || ''; i += 1;
    const eq = spec.indexOf('=');
    checks.push({ kind, path: eq >= 0 ? spec.slice(0, eq) : spec, val: eq >= 0 ? spec.slice(eq + 1) : undefined });
  }
  return checks;
}

function main() {
  const checks = parseChecks(process.argv.slice(2));
  const raw = fs.readFileSync(0, 'utf8');
  const obj = extractJson(raw);
  if (!obj) {
    process.stderr.write('   ✗ no JSON object found in the model output. First 800 chars:\n');
    process.stderr.write(raw.slice(0, 800).split('\n').map((l) => '     ' + l).join('\n') + '\n');
    process.exit(1);
  }
  let fails = 0;
  for (const c of checks) {
    const actual = get(obj, c.path);
    let ok;
    if (c.kind === 'truthy') ok = !!actual;
    else if (c.kind === 'eq') ok = String(actual) === c.val;
    else if (c.kind === 'includes') ok = Array.isArray(actual) && actual.map(String).some((x) => x.toLowerCase().includes(String(c.val).toLowerCase()));
    else ok = false;
    const want = c.kind === 'truthy' ? '(truthy)' : `${c.kind === 'includes' ? '⊇' : '='} ${c.val}`;
    process.stdout.write(`   ${ok ? '✓' : '✗'} ${c.path} ${want} → ${JSON.stringify(actual)}\n`);
    if (!ok) fails += 1;
  }
  process.exit(fails ? 1 : 0);
}

main();
