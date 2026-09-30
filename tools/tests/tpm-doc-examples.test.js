#!/usr/bin/env node
'use strict';
/**
 * tpm-doc-examples.test.js — every `tpm <suite> <verb> [--flag …]` example in the tool docs, the skills and the
 * methodology must name a REAL verb and REAL flags, judged by the tool's own `--help`.
 *
 * Promoted from the R6c verifier's flagcheck.js (08-r6c-tool-docs/tmp/verifier-r1/flagcheck.js) and widened:
 *   - scans tools/**\/*.md (not tests/ folders), .claude/skills/**, claude-context/methodology/**
 *   - line-start examples (`tpm task list …`, `$ tpm …`, with `\` continuations) AND inline `code spans`
 *   - suites session / task / workflow / hooks / plugin
 *   - a line commented `# → unknown verb` is an intentional NEGATIVE example: it must be unknown (inverse check)
 *   - a verb is real iff `tpm <suite> <verb> --help` exits 0 (an unknown verb exits 2 with "unknown verb");
 *     a flag is real iff its text appears in that verb's help output.
 *
 * Proven to bite (planted bogus flag AND bogus verb in a temp COPY of the bundle → both reported, control clean).
 *
 * Run: node tools/tests/tpm-doc-examples.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { walk, copyBundle, makeFakeClaude, safeEnv, runTpm, BUNDLE } = require('./lib/guard-helpers');

const SUITES = 'session|task|workflow|hooks|plugin';
const LINE_RE = new RegExp(`^\\s*(?:\\$ )?tpm (${SUITES}) ([a-z][a-z-]*)(.*)$`);
const SPAN_RE = new RegExp('`tpm (' + SUITES + ') ([a-z][a-z-]*)([^`]*)`', 'g');

function docFiles(root) {
  const under = (rel) => rel.split(path.sep).includes('tests');
  return [
    ...walk(path.join(root, '.claude', 'skills'), (p) => p.endsWith('.md')),
    ...walk(path.join(root, 'claude-context', 'methodology'), (p) => p.endsWith('.md')),
    ...walk(path.join(root, 'tools'), (p) => p.endsWith('.md')),
  ].filter((p) => !under(path.relative(root, p)));
}

/** Pull every example out of one file: [{line, suite, verb, flags[]}]. */
function extract(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const flagsOf = (rest) => [...new Set(rest.match(/--[a-z][a-z-]*/g) || [])].filter((f) => f !== '--help');
    const m = LINE_RE.exec(lines[i]);
    if (m) {
      let rest = m[3]; let j = i;
      while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) { j += 1; rest += ' ' + lines[j]; }
      out.push({ line: i + 1, suite: m[1], verb: m[2], flags: flagsOf(rest), negative: /unknown verb/i.test(lines[i]) });
    }
    for (const sm of lines[i].matchAll(SPAN_RE)) out.push({ line: i + 1, suite: sm[1], verb: sm[2], flags: flagsOf(sm[3]) });
  }
  return out;
}

/** Check every example under `root`; returns { checked, bad:[string], verbsSeen:Set }. */
function checkRoot(root, env) {
  const cache = new Map();
  const helpFor = (suite, verb) => {
    const k = `${suite} ${verb}`;
    if (!cache.has(k)) {
      const r = runTpm(root, [suite, verb, '--help'], { env });
      cache.set(k, { ok: r.status === 0 && !/unknown verb/i.test(r.all.slice(0, 300)), text: r.all });
    }
    return cache.get(k);
  };
  let checked = 0; const bad = []; const verbsSeen = new Set();
  for (const f of docFiles(root)) {
    for (const ex of extract(fs.readFileSync(f, 'utf8'))) {
      checked += 1; verbsSeen.add(`${ex.suite} ${ex.verb}`);
      const h = helpFor(ex.suite, ex.verb);
      const where = `${path.relative(root, f)}:${ex.line}  tpm ${ex.suite} ${ex.verb}`;
      if (ex.negative) { // a doc line that DECLARES "→ unknown verb" must really be an unknown verb
        if (h.ok) bad.push(`${where}  → documented as an unknown verb but it exists`);
        continue;
      }
      if (!h.ok) { bad.push(`${where}  → no such verb`); continue; }
      const miss = ex.flags.filter((x) => !h.text.includes(x));
      if (miss.length) bad.push(`${where}  → flag(s) not in --help: ${miss.join(' ')}`);
    }
  }
  return { checked, bad, verbsSeen };
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-doc-examples.test.js\n');

const fake = makeFakeClaude('doc-examples');
const env = safeEnv(fake);

check('extractor: line-start, `$ ` prefixed, backslash-continued and inline-span examples are all found; placeholders skipped', () => {
  const ex = extract([
    'tpm task list --state open',
    '  $ tpm session note --log \\',
    '      --status DONE --text x',
    'use `tpm workflow compose --role builder` then `tpm doc x` (not a suite) and tpm <suite> <verb>',
  ].join('\n'));
  assert.deepStrictEqual(ex.map((e) => `${e.suite} ${e.verb}:${e.flags.join(',')}`),
    ['task list:--state', 'session note:--log,--status,--text', 'workflow compose:--role']);
});

check('REAL DOCS: every `tpm <suite> <verb> --flag` example (tool docs + skills + methodology) names a real verb + real flags', () => {
  const r = checkRoot(BUNDLE, env);
  assert.ok(r.checked > 150, `scan too narrow: only ${r.checked} examples`);
  assert.ok(r.verbsSeen.size > 25, `too few distinct verbs exercised (${r.verbsSeen.size})`);
  assert.deepStrictEqual(r.bad, [], 'bad doc examples:\n  ' + r.bad.join('\n  '));
});

check('BITE: a planted bogus FLAG and a planted bogus VERB in a temp copy are both reported (control copy is clean)', () => {
  const copy = copyBundle('doc-examples-copy');
  const control = checkRoot(copy, env);
  assert.deepStrictEqual(control.bad, [], 'control: untouched copy is clean');
  const skill = path.join(copy, '.claude/skills/tpm-task/SKILL.md');
  fs.appendFileSync(skill, '\n```\ntpm task list --no-such-flag-xyz\ntpm session frobnicate --state open\n```\n');
  const doc = path.join(copy, 'tools/workflow/tpm-workflow-audit.md');
  fs.appendFileSync(doc, '\nRun `tpm workflow audit --bogus-audit-flag` to see.\n');
  const r = checkRoot(copy, env);
  const joined = r.bad.join('\n');
  assert.ok(/SKILL\.md:\d+\s+tpm task list\s+→ flag\(s\) not in --help: --no-such-flag-xyz/.test(joined), joined);
  assert.ok(/SKILL\.md:\d+\s+tpm session frobnicate\s+→ no such verb/.test(joined), joined);
  assert.ok(/tpm-workflow-audit\.md:\d+\s+tpm workflow audit\s+→ flag\(s\) not in --help: --bogus-audit-flag/.test(joined), joined);
  assert.strictEqual(r.bad.length, 3, 'exactly the three planted defects:\n' + joined);
});

process.stdout.write(`\nPASS — ${count} checks\n`);
