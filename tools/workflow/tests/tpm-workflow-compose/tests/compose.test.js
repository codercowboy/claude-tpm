#!/usr/bin/env node
/**
 * compose.test.js - self-contained tests for compose-spawn-prompt.js.
 *
 * Covers the DoD row for compose:
 *   --role builder --phase-dir <p> --plan plan.md --charter charter-builder.md
 *   -> emits a spawn prompt with the working folder, read-order (charter THEN
 *      plan), constraints, return-shape, and a {{TASK_CONTEXT}} fill sentinel.
 * Plus: --help exits 0, missing required flag fails (exit 2), and the emitted
 * {{TASK_CONTEXT}} is a REAL fill sentinel (the linter flags it).
 *
 * HOW TO RUN:  node tests/compose.test.js      (exit 0 = all pass)
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE = path.join(ROOT, 'tools', 'compose-spawn-prompt.js');
const LINT = path.join(ROOT, 'tools', 'lint-subagent-prompt.js');
const SCRATCH = path.join(ROOT, 'tmp', 'builder-r1', 'compose-fixtures');
fs.mkdirSync(SCRATCH, { recursive: true });

let passed = 0, failed = 0;
function check(desc, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${desc}`); }
  else { failed++; console.log(`  FAIL ${desc}${extra ? '\n       ' + extra : ''}`); }
}

function run(cmd, args, opts) {
  try {
    const stdout = execFileSync('node', [cmd, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: (opts && opts.input) || '',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
  }
}

console.log('compose-spawn-prompt.js tests\n');

const PHASE = 'dev/demo-epic/02b-lint-compose';

// ---------------------------------------------------------------------------
// DoD row — the canonical invocation emits the full boilerplate.
// ---------------------------------------------------------------------------
let r = run(COMPOSE, ['--role', 'builder', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-builder.md']);
check('canonical compose exits 0', r.code === 0, `code=${r.code}\n${r.stderr}`);
const out = r.stdout;

check('names the role (BUILDER)', /BUILDER subagent/.test(out), out);
check('emits the working folder', out.includes(PHASE), out);
check('read-order lists charter THEN plan (charter appears before plan)',
  out.indexOf('charter-builder.md') !== -1 &&
  out.indexOf('charter-builder.md') < out.indexOf('plan.md'), out);
check('read-order is explicit ("Read, in order")', /Read, in order/.test(out), out);
check('emits a constraints block (write ONLY / zero deps / scratch / blocked names)',
  /write ONLY inside/.test(out) && /zero external deps/.test(out) &&
  /scratch/.test(out) && /report\/summary\/analysis\/findings/.test(out), out);
check('emits a return-shape', /Return-shape/.test(out) && /one-paragraph summary/.test(out), out);
check('emits the {{TASK_CONTEXT}} fill sentinel', out.includes('{{TASK_CONTEXT}}'), out);
check('scratch folder derives from identity slug (tmp/builder/)', /tmp\/builder\//.test(out), out);

// ---------------------------------------------------------------------------
// The emitted {{TASK_CONTEXT}} is a REAL fill sentinel: the linter flags it.
// ---------------------------------------------------------------------------
const composedPath = path.join(SCRATCH, 'composed-prompt.md');
fs.writeFileSync(composedPath, out);
r = run(LINT, ['--file', composedPath, '--sentinels-only']);
check('linter FLAGS the unfilled {{TASK_CONTEXT}} in the composed output (exit 1)',
  r.code === 1 && /fill-sentinel/.test(r.stdout) && /TASK_CONTEXT/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

// Once filled, the composed prompt passes the sentinel scan. The composed
// prompt names charter-builder.md, so give the charter-file-present check a dir
// that actually contains it.
fs.writeFileSync(path.join(SCRATCH, 'charter-builder.md'), '# Charter\nDo it well.\n');
const filled = out.replace('{{TASK_CONTEXT}}', 'Build the widget per the DoD table.');
const filledPath = path.join(SCRATCH, 'composed-filled.md');
fs.writeFileSync(filledPath, filled);
r = run(LINT, ['--file', filledPath, '--sentinels-only', '--charter-dir', SCRATCH]);
check('filled composed prompt passes the sentinel scan (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// Verifier role + round/variant: verdict return-shape + tmp/verifier-r1-v1/.
// ---------------------------------------------------------------------------
r = run(COMPOSE, ['--role', 'verifier', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-verifier.md', '--round', '1', '--variant', '1']);
check('verifier compose exits 0', r.code === 0, r.stderr);
check('  ... verifier return-shape mentions a verdict file', /verdict\.md/.test(r.stdout), r.stdout);
check('  ... scratch slug is verifier-r1-v1', /tmp\/verifier-r1-v1\//.test(r.stdout), r.stdout);

// ---------------------------------------------------------------------------
// --project-root emits the env-source ritual (step zero).
// ---------------------------------------------------------------------------
r = run(COMPOSE, ['--role', 'builder', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-builder.md', '--project-root', '/abs/repo']);
check('with --project-root, emits the env-source ritual', /source '.*tmp\/subagent\.env'/.test(r.stdout) && /cd '\/abs\/repo'/.test(r.stdout), r.stdout);

// ---------------------------------------------------------------------------
// No-defaults rule — a missing required flag fails loudly (exit 2).
// ---------------------------------------------------------------------------
r = run(COMPOSE, ['--role', 'builder', '--phase-dir', PHASE, '--plan', 'plan.md']); // no --charter
check('missing --charter fails (exit 2)', r.code === 2 && /Missing required flag --charter/.test(r.stderr), `code=${r.code}\n${r.stderr}`);
r = run(COMPOSE, ['--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'c.md']); // no --role
check('missing --role fails (exit 2)', r.code === 2, `code=${r.code}\n${r.stderr}`);

// ---------------------------------------------------------------------------
// --help exits 0.
// ---------------------------------------------------------------------------
r = run(COMPOSE, ['--help']);
check('--help exits 0 and prints usage', r.code === 0 && /USAGE/.test(r.stdout), `code=${r.code}`);

// ===========================================================================
// ROLE-CONDITIONAL posture (DoD #7) — each role's read-order + return-shape
// must MATCH its charter posture. compose() is role-blind no more.
// ===========================================================================
// Helper: compose one role and return its stdout.
function composeRole(role, extra) {
  const rr = run(COMPOSE, ['--role', role, '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', `charter-${role}.md`, ...(extra || [])]);
  return rr.stdout;
}

// -- deliver-the-artifact family (builder / test-writer / documentarian) ------
const builderOut = composeRole('builder');
check('builder: return-shape = built artifact + passing checks', /built artifact \+ its passing checks/.test(builderOut), builderOut);
check("builder: read-order says don't stop until every row is true", /don't stop until every row is true/.test(builderOut), builderOut);

const twOut = composeRole('test-writer');
check('test-writer: read-order is TESTS-tailored (suite goes red)', /TESTS/.test(twOut) && /go red when the artifact breaks/.test(twOut), twOut);
check('test-writer: return-shape names the test suite + mutation-check', /test suite/.test(twOut) && /mutation[- ]check/i.test(twOut), twOut);
check('test-writer: does NOT emit the plain builder "built artifact" return', !/built artifact \+ its passing checks/.test(twOut), twOut);

const docOut = composeRole('documentarian');
check('documentarian: read-order is DOCS-tailored (every claim run-verified)', /DOCS/.test(docOut) && /run and watched come true|verified against the running artifact/.test(docOut), docOut);
check('documentarian: return-shape names the documentation, claims verified', /documentation on disk/.test(docOut) && /every claim verified/.test(docOut), docOut);
check('documentarian: does NOT emit the plain builder "built artifact" return', !/built artifact \+ its passing checks/.test(docOut), docOut);

// -- verifier: verdict-not-repair + HARD RULE ---------------------------------
const verOut = composeRole('verifier', ['--round', '1', '--variant', '1']);
check('verifier: read-order says report a VERDICT, not a repair', /report a VERDICT, not a repair/.test(verOut), verOut);
check('verifier: emits an explicit HARD RULE independence line', /HARD RULE/.test(verOut) && /you do not repair/.test(verOut), verOut);
check('verifier: return-shape is the verdict file (not artifact)', /verdict to `findings\/verifier-r1-v1-verdict\.md`/.test(verOut) && !/built artifact \+ its passing checks/.test(verOut), verOut);
// TEST-HARDENING (28) — the verifier return-shape carries an explicit
// "Do NOT modify the tool or tests" independence clause. fable-3 #5 found this
// clause could be deleted with the suite staying green; pin it. Mutation-proved
// in tests/mutation-check28.js.
check('verifier: return-shape carries the "Do NOT modify the tool or tests" independence clause',
  /Do NOT modify the tool or tests\./.test(verOut), verOut);
check('verifier: a non-verifier role (builder) does NOT carry the tool/tests independence clause (control)',
  !/Do NOT modify the tool or tests/.test(builderOut), builderOut);

// -- planning / researcher: do NOT build; deliver a plan / knowledge ----------
const planOut = composeRole('planning');
check('planning: read-order says do NOT build', /do NOT build/.test(planOut), planOut);
check('planning: return-shape is a plan proposal + risk map, NOT a built artifact',
  /plan proposal \+ risk map/.test(planOut) && /NOT a built artifact/.test(planOut) && !/built artifact \+ its passing checks/.test(planOut), planOut);

const resOut = composeRole('researcher');
check('researcher: read-order says do NOT build', /do NOT build/.test(resOut), resOut);
check('researcher: return-shape is findings/knowledge, NOT a built artifact',
  /findings/.test(resOut) && /knowledge, NOT a built artifact/.test(resOut) && !/built artifact \+ its passing checks/.test(resOut), resOut);

// -- unknown (consumer) role: neutral, never the builder default --------------
const wizOut = composeRole('wizard');
check('unknown role: charter is authoritative (neutral cue)', /the charter is authoritative/.test(wizOut), wizOut);
check('unknown role: does NOT inherit the builder "built artifact" return', !/built artifact \+ its passing checks/.test(wizOut), wizOut);

// -- Cross-role distinctness: the four families all differ --------------------
check('return-shapes differ across builder / verifier / planning',
  builderOut !== verOut && builderOut !== planOut && verOut !== planOut, 'roles produced identical prompts');

// ===========================================================================
// --verdict + mechanical bug-fixer handoff (DoD #4)
// ===========================================================================
const VERDICT = 'findings/verifier-r1-v1-verdict.md';
r = run(COMPOSE, ['--role', 'bug-fixer', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-bug-fixer.md', '--verdict', VERDICT]);
check('bug-fixer with --verdict exits 0', r.code === 0, `code=${r.code}\n${r.stderr}`);
const bfOut = r.stdout;
check('bug-fixer: read-order NAMES the verdict file (item 1)', bfOut.includes(VERDICT) && /The verifier's verdict/.test(bfOut), bfOut);
check("bug-fixer: verdict is read BEFORE the charter (item 1)", bfOut.indexOf(VERDICT) < bfOut.indexOf('Your charter'), bfOut);
check('bug-fixer: return-shape is fixer-shaped (fixes + nothing beyond the findings)',
  /Touch nothing beyond the verdict's findings/.test(bfOut) && /each finding and how you closed it/.test(bfOut), bfOut);
check('bug-fixer: does NOT emit the plain builder "built artifact" return', !/built artifact \+ its passing checks/.test(bfOut), bfOut);
// --verdict is MANDATORY for a bug-fixer (the handoff is only mechanical if named).
r = run(COMPOSE, ['--role', 'bug-fixer', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-bug-fixer.md']); // no --verdict
check('bug-fixer WITHOUT --verdict fails loudly (exit 2)', r.code === 2 && /Missing required flag --verdict/.test(r.stderr), `code=${r.code}\n${r.stderr}`);
// --verdict is ignored for non-bug-fixer roles (no verdict line leaks in).
r = run(COMPOSE, ['--role', 'builder', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-builder.md', '--verdict', VERDICT]);
check('non-bug-fixer role ignores --verdict (no verdict read-line)', r.code === 0 && !/The verifier's verdict/.test(r.stdout), r.stdout);

// ===========================================================================
// The composed VERIFIER prompt now PASSES the lint's verifier-hard-rule
// (baseline before this round: it FAILed — no HARD RULE line was emitted).
// ===========================================================================
const verForLint = composeRole('verifier', ['--round', '1', '--variant', '1', '--project-root', '/abs/repo'])
  .replace('{{TASK_CONTEXT}}', 'Verify the widget.');
const verLintPath = path.join(SCRATCH, 'composed-verifier.md');
fs.writeFileSync(verLintPath, verForLint);
fs.writeFileSync(path.join(SCRATCH, 'charter-verifier.md'), '# Charter\nVerify well.\n');
r = run(LINT, ['--file', verLintPath, '--verifier', '--charter-dir', SCRATCH]);
check('composed verifier prompt PASSES the full lint incl. verifier-hard-rule (exit 0)',
  r.code === 0 && /PASS/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

// ===========================================================================
// MUTATION-CHECK — prove the role-distinctness guards can actually go RED.
// Mutate compose() back to role-blindness (profileFor always returns builder,
// the exact bug this round fixed) and confirm the planning/verifier guards trip.
// ===========================================================================
const composeSrc = fs.readFileSync(COMPOSE, 'utf8');
const MUT_TARGET = "return ROLE_PROFILES[String(role).toLowerCase()] || NEUTRAL_PROFILE;";
check('mutation anchor present in compose source (else the mutant is a no-op)', composeSrc.includes(MUT_TARGET), 'profileFor() body changed — update the mutation target');
const mutantSrc = composeSrc.replace(MUT_TARGET, "return ROLE_PROFILES['builder'];");
const mutantPath = path.join(SCRATCH, 'compose-mutant.js');
fs.writeFileSync(mutantPath, mutantSrc);
const mutPlan = run(mutantPath, ['--role', 'planning', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-planning.md']).stdout;
const mutVer = run(mutantPath, ['--role', 'verifier', '--phase-dir', PHASE, '--plan', 'plan.md', '--charter', 'charter-verifier.md']).stdout;
// Under the role-blind mutant, planning/verifier leak the builder return-shape;
// the real tool (asserted above) does not — so the guards are genuinely load-bearing.
check('MUTANT reintroduces the bug: planning leaks the builder "built artifact" return',
  /built artifact \+ its passing checks/.test(mutPlan), mutPlan);
check('MUTANT reintroduces the bug: verifier loses its verdict return-shape',
  /built artifact \+ its passing checks/.test(mutVer) && !/verdict to `findings/.test(mutVer), mutVer);
check('...and the real tool does NOT (guard would fire red on the mutant)',
  !/built artifact \+ its passing checks/.test(planOut) && !/built artifact \+ its passing checks/.test(verOut), 'real tool leaked builder shape');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
