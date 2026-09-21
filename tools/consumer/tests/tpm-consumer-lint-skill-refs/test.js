#!/usr/bin/env node
/**
 * test.js — deterministic unit test for tpm-consumer-lint-skill-refs.js (the skill-relocatability lint).
 * Zero deps, no `claude`: writes throwaway skill .md fixtures to a temp dir and child-processes the lint,
 * asserting its exit code (0 clean / 1 violations) and the offending-text it prints. Also drives the
 * exported lintFile() directly for the rule-level assertions.
 *
 * Locks in the lint's contract (see the tool's header), post-#1102 respell:
 *   1. relocatable forms pass: `npx tpm <suite> <verb>`, `npx tpm doc <relpath>`, `%TPM_HOME%/…` citations;
 *   2. non-relocatable bundle refs are flagged: bare `node tools/…`, `` `tools/… ``, bare
 *      `claude-context/methodology/…`, `` `methodology/… ``;
 *   3. GUARD — the legacy shell-expanding `${TPM_HOME}` spelling is flagged ANYWHERE in content, so it
 *      can't creep back in (matchers still RESOLVE both spellings, but content prefers `%TPM_HOME%`);
 *   4. both tokenized spellings are treated as relocatable for the methodology rule (a `${TPM_HOME}/…`
 *      ref is caught by the guard, not double-flagged as a "bare" read).
 *
 * Usage:  node tools/consumer/tests/tpm-consumer-lint-skill-refs/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const LINT = path.resolve(__dirname, '..', '..', 'tpm-consumer-lint-skill-refs.js');
const { lintFile } = require(LINT);

// Write a single SKILL.md fixture into a fresh temp dir; return the file path.
function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skill-refs-'));
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body);
  return { dir, file };
}
// Run the lint CLI against a path; return { out, code }.
function runLint(target) {
  const r = cp.spawnSync('node', [LINT, target], { encoding: 'utf8' });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
}

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

// 1. A fully relocatable skill is clean (exit 0): bin invocation + `tpm doc` read + %TPM_HOME% citation.
check('relocatable skill → clean (exit 0)', () => {
  const { dir, file } = fixture([
    '# tpm-example',
    'Run `npx tpm task list` for the ledger.',
    'Read the reading-list with `npx tpm doc claude-context/methodology/subagent/reading-list.md`.',
    'The tools live under `%TPM_HOME%/tools/workflow/` and the chain at `%TPM_HOME%/claude-context/methodology/overview.md`.',
  ].join('\n') + '\n');
  const { out, code } = runLint(file);
  assert.strictEqual(code, 0, `expected clean exit 0, got ${code}\n${out}`);
  assert(/clean/.test(out), `expected a "clean" message, got:\n${out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2. THE DoD DEMO — a planted legacy `${TPM_HOME}` in skill content is flagged (exit 1, rule 5 guard).
check('planted ${TPM_HOME} in content → flagged (exit 1)', () => {
  const { dir, file } = fixture('# skill\nCite the tools at `${TPM_HOME}/tools/workflow/`.\n');
  const { out, code } = runLint(file);
  assert.strictEqual(code, 1, `expected violation exit 1, got ${code}\n${out}`);
  assert(/\$\{TPM_HOME\}/.test(out), 'expected the offending ${TPM_HOME} echoed');
  assert(/%TPM_HOME%/.test(out), 'expected the fix to name %TPM_HOME%');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 3. bare `node tools/…` invocation is flagged (rule 1).
check('bare `node tools/…` → flagged', () => {
  const v = lintFile(fixtureFileWith('Run node tools/task/tpm-task.js list.\n'));
  assert(v.some(x => /npx tpm/.test(x.why)), 'expected the bin-invocation fix');
});

// 4. bare methodology read is flagged (rule 2); its fix names `tpm doc`.
check('bare `claude-context/methodology/…` read → flagged (fix names tpm doc)', () => {
  const v = lintFile(fixtureFileWith('Read claude-context/methodology/overview.md first.\n'));
  assert(v.length >= 1, 'expected a violation');
  assert(v.some(x => /tpm doc/.test(x.why)), 'expected the fix to name `npx tpm doc`');
});

// 5. `npx tpm doc <relpath>` read is NOT flagged (the `doc ` lookbehind exempts it).
check('`npx tpm doc claude-context/methodology/…` read → NOT flagged', () => {
  const v = lintFile(fixtureFileWith('Read via `npx tpm doc claude-context/methodology/overview.md`.\n'));
  assert.strictEqual(v.length, 0, `expected 0 violations, got ${JSON.stringify(v)}`);
});

// 6. `%TPM_HOME%/claude-context/methodology/…` citation is NOT flagged (preferred tokenized spelling).
check('`%TPM_HOME%/claude-context/methodology/…` citation → NOT flagged', () => {
  const v = lintFile(fixtureFileWith('The chain lives at `%TPM_HOME%/claude-context/methodology/overview.md`.\n'));
  assert.strictEqual(v.length, 0, `expected 0 violations, got ${JSON.stringify(v)}`);
});

// 7. legacy `${TPM_HOME}/claude-context/methodology/…` is caught by the GUARD (rule 5), not double-flagged
//    as a bare read — matchers still resolve the prefix, but the old spelling must be respelled.
check('legacy `${TPM_HOME}/claude-context/methodology/…` → flagged by guard only', () => {
  const v = lintFile(fixtureFileWith('The chain lives at `${TPM_HOME}/claude-context/methodology/overview.md`.\n'));
  assert.strictEqual(v.length, 1, `expected exactly 1 (guard) violation, got ${JSON.stringify(v)}`);
  assert(/legacy shell-EXPANDING/.test(v[0].why), 'expected the guard rule to be the one that fired');
});

// helper: write a one-off fixture file and return its path (used by the lintFile()-level checks).
function fixtureFileWith(body) {
  const { file } = fixture(body);
  return file;
}

process.stdout.write(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks green\n`);
process.exit(fail ? 1 : 0);
