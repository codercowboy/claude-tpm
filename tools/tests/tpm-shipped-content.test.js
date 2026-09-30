#!/usr/bin/env node
'use strict';
/**
 * tpm-shipped-content.test.js — gap-fillers from the final-stage coverage audit: epic claims that had no test pinning them.
 *
 *   G1  the REAL shipped skills pass the skill linter (relocatable refs, bare `tpm`, no `npx tpm`) — the linter had unit tests on
 *       fixtures but nothing ran it over the actual skills (R5 baseline 81 violations → R6 swept to 0; this keeps it at 0)
 *   G2  the two `findRoot` copies (tools/lib/paths.js and tools/session/tpm-session-paths.js) stay byte-identical (R3 claimed
 *       "diff-checked"; a one-sided edit would silently fork the root-resolution rule between the session and task/workflow suites)
 *   G3  the bare-`tpm` / project-root rules are WRITTEN DOWN where subagents read them (tool-conventions.md) with the load-bearing facts
 *   G4  the shell scripts the epic edited still parse (`bash -n`): consumer smoke.sh, legacy smoke, child-session scripts, bin/tpm;
 *       smoke.sh carries the current deterministic probe, and the legacy smoke suite stays labelled LEGACY
 *   G5  methodology / skill reading lists only name docs that exist (every `tpm doc <path>` target resolves)
 *
 * Bite: a planted `npx tpm` in a temp copy of the skills turns G1 red; a one-character fork of findRoot turns G2 red.
 *
 * Run: node tools/tests/tpm-shipped-content.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('./lib/scratch');
const { walk, BUNDLE } = require('./lib/guard-helpers');

const read = (rel) => fs.readFileSync(path.join(BUNDLE, rel), 'utf8');
const lint = (skillsDir) => spawnSync('node', [path.join(BUNDLE, 'tools/consumer/tpm-consumer-lint-skill-refs.js'), skillsDir], { encoding: 'utf8', env: { PATH: process.env.PATH } });

/** The source text of `function <name>(…) { … }` by brace matching (string/regex literals in these bodies carry no stray braces). */
function fnSource(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', i)); // first `{` after the parameter list (the destructured default arg has its own braces → skip past `)`)
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-shipped-content.test.js\n');

// ── G1 ──
check('G1: the real shipped skills pass the skill linter (exit 0, no violations)', () => {
  const r = lint(path.join(BUNDLE, '.claude/skills'));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(walk(path.join(BUNDLE, '.claude/skills'), (p) => p.endsWith('.md')).length >= 10, 'linted a real skills tree');
});

check('G1 BITE: a planted `npx tpm …` / bare `tools/…js` in a copy of the skills makes the linter exit 1', () => {
  const copy = path.join(mkScratch('skills-copy'), 'skills');
  fs.cpSync(path.join(BUNDLE, '.claude/skills'), copy, { recursive: true });
  assert.strictEqual(lint(copy).status, 0, 'control: the untouched copy is clean');
  fs.appendFileSync(path.join(copy, 'tpm-task/SKILL.md'), '\nRun `npx tpm task list` first.\n');
  const a = lint(copy); assert.strictEqual(a.status, 1, a.stdout);
  assert.ok(/npx tpm/.test(a.stdout + a.stderr));
  fs.cpSync(path.join(BUNDLE, '.claude/skills'), copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'tpm-session/SKILL.md'), '\nnode tools/session/tpm-session-ops.js note\n');
  assert.strictEqual(lint(copy).status, 1, 'a bare node tool path is flagged too');
});

// ── G2 ──
check('G2: findRoot + warnOnce are byte-identical in tools/lib/paths.js and tools/session/tpm-session-paths.js', () => {
  const a = read('tools/lib/paths.js'); const b = read('tools/session/tpm-session-paths.js');
  for (const fn of ['findRoot', 'warnOnce']) assert.strictEqual(fnSource(a, fn), fnSource(b, fn), `${fn} forked between the two copies`);
  assert.ok(fnSource(a, 'findRoot').includes('TPM_PROJECT_ROOT'), 'the env rule is in the compared body');
});

check('G2 BITE: a one-character fork of one copy is detected by the same comparison', () => {
  const a = read('tools/lib/paths.js');
  const body = fnSource(a, 'findRoot');
  const forked = a.replace(body, body.replace('TPM_PROJECT_ROOT', 'TPM_PROJECT_R00T'));
  assert.notStrictEqual(forked, a);
  assert.notStrictEqual(fnSource(forked, 'findRoot'), fnSource(read('tools/session/tpm-session-paths.js'), 'findRoot'));
});

// ── G3 ──
check('G3: tool-conventions.md writes down the bare-`tpm` rule and the project-root precedence (env > walk-up; explicit startDir wins; TPM_HOME is not read)', () => {
  const t = read('claude-context/methodology/tool-conventions.md');
  assert.ok(/Who calls what/.test(t) && /bare `tpm`/.test(t), 'bare tpm rule');
  assert.ok(/Never instruct Claude to run `npx tpm/.test(t), 'the hazard is named');
  const sec = t.slice(t.indexOf('## How tools find the consumer project'));
  assert.ok(sec.length > 200, 'section exists');
  for (const needle of ['TPM_PROJECT_ROOT', 'startDir', 'walk', 'TPM_HOME']) assert.ok(sec.includes(needle), `section mentions ${needle}`);
});

// ── G4 ──
check('G4: every shell script the epic touched parses (`bash -n`)', () => {
  const scripts = ['tools/consumer/smoke.sh', 'tools/tests/smoke/run-smoke.sh', 'tools/child-session/tpm-child-launch.sh',
    'tools/child-session/tpm-child-reap.sh', 'tools/child-session/tpm-child-watch.sh', 'bin/tpm'];
  for (const rel of scripts) {
    assert.ok(fs.existsSync(path.join(BUNDLE, rel)), `${rel} exists`);
    const r = spawnSync('bash', ['-n', path.join(BUNDLE, rel)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${rel}: ${r.stderr}`);
  }
});

check('G4: consumer smoke.sh carries the deterministic `tpm-doc-resolves` probe (not the retired token probe); the old smoke suite stays labelled LEGACY', () => {
  const sh = read('tools/consumer/smoke.sh');
  assert.ok(/probe_cli "tpm-doc-resolves"/.test(sh));
  assert.ok(!/probe "token-methodology-read"|probe_cli "token-methodology-read"/.test(sh));
  assert.ok(/npx-tpm-resolves/.test(sh), 'the deliberate npx probe is still there');
  assert.ok(/LEGACY/.test(read('tools/tests/smoke/README.md').slice(0, 400)), 'legacy banner at the top of the old smoke README');
  assert.ok(/LEGACY|legacy|older/.test(read('tools/tests/smoke/run-smoke.sh').slice(0, 1500)), 'legacy note in run-smoke.sh header');
});

// ── G5 ──
check('G5: every `tpm doc <path>` / `%TPM_HOME%/<path>` named in the skills / methodology / tool docs resolves to a real bundle file (reading lists never dangle)', () => {
  const files = [...walk(path.join(BUNDLE, '.claude/skills'), (p) => p.endsWith('.md')), ...walk(path.join(BUNDLE, 'claude-context/methodology'), (p) => p.endsWith('.md')),
    ...walk(path.join(BUNDLE, 'tools'), (p) => p.endsWith('.md') && !p.split(path.sep).includes('tests'))];
  let n = 0; const bad = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:\btpm doc |%TPM_HOME%\/)((?:claude-context|docs|tools|\.claude)\/[A-Za-z0-9_./-]+\.[a-z]+)/g)) {
      n += 1; if (!fs.existsSync(path.join(BUNDLE, m[1]))) bad.push(`${path.relative(BUNDLE, f)}: tpm doc ${m[1]}`);
    }
  }
  assert.ok(n >= 5, `only ${n} doc references checked`);
  assert.deepStrictEqual(bad, []);
});

process.stdout.write(`\nPASS — ${count} checks\n`);
