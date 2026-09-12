#!/usr/bin/env node
/**
 * audit.js — walk `dev/` and audit each leaf task folder + grouping folder
 * against the canonical `dev/<task>/` layout documented in
 * `claude-context/methodology/project-workspace.md`.
 *
 * Ported from ggaitk `audit-research-topics.js` (2026-08-27), adapted to
 * claude-admin conventions: scans `dev/` (not `research/topics/`), knows the
 * FLATTENED findings layout (numbered `NN-*.md` live directly in `findings/`,
 * not in `findings/docs/`), and flags scratch dirs INSIDE `findings/`
 * (`findings/tmp/`, `findings/scratch/`, `findings/research/`) as drift —
 * project-workspace.md forbids them; scratch belongs in the task's own `tmp/`.
 *
 * Emits a markdown punch list so a hygiene pass can spot drift without opening
 * every folder by hand. Read-only against the task tree; only writes the one
 * report file you point it at.
 *
 * Usage:
 *   node tools/workflow/audit.js --out <path-to-output.md> [--tasks-root <dir>]
 *
 * Flags:
 *   --out <path>        Output markdown file. REQUIRED (no default).
 *   --tasks-root <dir>  Task tree to scan (default: work). Use a scratch tree
 *                       for testing so the real dev/ tree isn't required.
 *   --help, -h          Print usage and exit 0.
 *
 * Exit codes:
 *   0  audit ran, output written
 *   1  usage error (missing --out, unknown arg, IO failure)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
let OUT_PATH = null;
let TASKS_ROOT_ARG = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') OUT_PATH = argv[++i];
  else if (argv[i] === '--tasks-root') TASKS_ROOT_ARG = argv[++i];
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('usage: audit.js --out <path-to-output.md> [--tasks-root <dir>]');
    process.exit(0);
  } else { console.error(`unknown arg: ${argv[i]}`); process.exit(1); }
}
if (!OUT_PATH) {
  console.error('Error: --out <path-to-output.md> is required (no default).');
  process.exit(1);
}

const ROOT = TASKS_ROOT_ARG || 'dev';

// Internal dirs a leaf owns — don't recurse into these looking for sub-tasks.
const INTERNAL_DIRS = ['findings', 'tools', 'assets', 'tmp'];
// Allowed entries directly at a task root.
const ROOT_SPEC = ['plan.md', 'README.md', 'assets', 'tools', 'findings', 'tmp'];
// Recognized standard dirs inside findings/ (durable). `docs` is the legacy
// pre-2026-07-07 numbered-docs subfolder, still valid where present.
const FINDINGS_STD_DIRS = ['deliverables', 'verification', 'captures', 'docs'];
// Scratch-shaped dirs that must NOT live under findings/ (belong in task tmp/).
const FINDINGS_SCRATCH_DIRS = ['tmp', 'scratch', 'research'];

function listFlat(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .map(e => ({ name: e.name, isDir: e.isDirectory() }));
}

function isLeaf(dir) {
  return ['findings', 'tools', 'plan.md', 'README.md'].some(p => fs.existsSync(path.join(dir, p)));
}

function findLeaves(dir, leaves = [], groupings = []) {
  if (isLeaf(dir)) {
    leaves.push(dir);
    for (const e of listFlat(dir)) {
      if (e.isDir && !INTERNAL_DIRS.includes(e.name)) {
        findLeaves(path.join(dir, e.name), leaves, groupings);
      }
    }
  } else {
    const children = listFlat(dir).filter(e => e.isDir);
    if (children.length > 0) {
      groupings.push(dir);
      for (const e of children) findLeaves(path.join(dir, e.name), leaves, groupings);
    }
  }
  return { leaves, groupings };
}

function classifyRootEntry(name, isDir) {
  if (ROOT_SPEC.includes(name)) return 'spec';
  if (/^readme.*\.md$/i.test(name)) return 'spec-variant-readme';
  if (/^plan.*\.md$/i.test(name)) return 'spec-variant-plan';
  if (/\.md$/i.test(name)) return 'extra-md-at-root';
  if (/\.js$/i.test(name)) return 'script-loose-at-root';
  if (/\.json$/i.test(name)) return 'json-loose-at-root';
  if (isDir) return 'extra-dir-at-root';
  return 'other-file-at-root';
}

function checkFindings(taskDir) {
  const findings = path.join(taskDir, 'findings');
  if (!fs.existsSync(findings)) return { exists: false };
  const r = {
    exists: true, hasReadme: false, hasQuestions: false, hasHandoff: false,
    stdDirs: [], scratchDirs: [], unexpectedDirs: [],
  };
  for (const e of listFlat(findings)) {
    if (!e.isDir) {
      if (e.name === 'README.md') r.hasReadme = true;
      else if (e.name === 'questions.md') r.hasQuestions = true;
      else if (e.name === 'HANDOFF.md') r.hasHandoff = true;
      // All other files (numbered NN-*.md, TLDR.md, wiki.md, verifier<N>-findings.md,
      // tool-feedback/updates.md, decisions.md, deliverable files) are expected at
      // findings/ root under the flattened convention — not flagged.
    } else if (FINDINGS_STD_DIRS.includes(e.name) || /^verifier\d+-findings$/.test(e.name)) {
      r.stdDirs.push(e.name);
    } else if (FINDINGS_SCRATCH_DIRS.includes(e.name)) {
      r.scratchDirs.push(e.name);       // real drift — scratch under findings/
    } else {
      r.unexpectedDirs.push(e.name);
    }
  }
  return r;
}

const { leaves, groupings } = findLeaves(ROOT);

let out = '';
const log = (s = '') => { out += s + '\n'; };

log('# Task-folder adherence audit');
log();
log('Generated against the canonical `dev/<task>/` layout in `claude-context/methodology/project-workspace.md`.');
log();
log(`Leaf tasks: **${leaves.length}**. Intermediate grouping folders: **${groupings.length}**.`);
log();
log('Legend:');
log('- ✓ = present   ✗ = missing (required)   - = absent (optional / on-demand)');
log('- ⚠ scratch under findings/ = a `tmp/`/`scratch/`/`research/` dir inside `findings/` (drift — scratch belongs in the task `tmp/`)');
log('- "stray at task root" = a file/dir at the task root that is not a spec entry');
log();

log('## Per-leaf adherence');
log();
const summary = { fullySpecd: 0, missingPlan: 0, missingFindings: 0, findingsScratch: 0, anyStray: 0 };
for (const leaf of leaves) {
  log('### `' + leaf + '`');
  const top = listFlat(leaf);
  const have = {
    plan: top.some(e => e.name === 'plan.md'),
    readme: top.some(e => e.name === 'README.md'),
    assets: top.some(e => e.isDir && e.name === 'assets'),
    tools: top.some(e => e.isDir && e.name === 'tools'),
    findings: top.some(e => e.isDir && e.name === 'findings'),
    tmp: top.some(e => e.isDir && e.name === 'tmp'),
  };
  const f = checkFindings(leaf);
  const stray = top.filter(e => !['spec', 'spec-variant-readme', 'spec-variant-plan'].includes(classifyRootEntry(e.name, e.isDir)));

  log('- root: plan=' + (have.plan ? '✓' : '✗') + ' findings=' + (have.findings ? '✓' : '✗') +
      ' | README=' + (have.readme ? '✓' : '-') + ' tools=' + (have.tools ? '✓' : '-') +
      ' assets=' + (have.assets ? '✓' : '-') + ' tmp=' + (have.tmp ? '✓' : '-'));
  if (f.exists) {
    log('- findings/: README=' + (f.hasReadme ? '✓' : '-') + ' questions=' + (f.hasQuestions ? '✓' : '-') +
        ' HANDOFF=' + (f.hasHandoff ? '✓' : '-') +
        (f.stdDirs.length ? ' | subdirs: ' + f.stdDirs.map(s => '`' + s + '/`').join(', ') : ''));
    if (f.scratchDirs.length) log('- ⚠ scratch dirs inside findings/ (move to task `tmp/`): ' + f.scratchDirs.map(s => '`' + s + '/`').join(', '));
    if (f.unexpectedDirs.length) log('- unexpected dirs under findings/: ' + f.unexpectedDirs.map(s => '`' + s + '/`').join(', '));
  }
  if (stray.length) {
    log('- stray at task root:');
    for (const s of stray) log('  - `' + s.name + (s.isDir ? '/' : '') + '` — ' + classifyRootEntry(s.name, s.isDir));
  }
  log();

  if (!have.plan) summary.missingPlan++;
  if (!have.findings) summary.missingFindings++;
  if (f.exists && f.scratchDirs.length) summary.findingsScratch++;
  if (stray.length) summary.anyStray++;
  if (have.plan && have.findings && (!f.exists || f.scratchDirs.length === 0) && stray.length === 0) summary.fullySpecd++;
}

log('## Intermediate grouping folders (contain sub-tasks; no plan/findings of their own)');
log();
for (const g of groupings) {
  const children = listFlat(g).filter(e => e.isDir).map(e => e.name);
  const hasReadme = listFlat(g).some(e => e.name === 'README.md');
  log(`- \`${g}/\` — README=${hasReadme ? '✓' : '- (optional)'} — children: ${children.map(c => '`' + c + '/`').join(', ')}`);
}
log();
log('## Tally');
log();
log(`- Fully-adherent leaves (plan + findings, no findings-scratch, no stray): **${summary.fullySpecd}** / ${leaves.length}`);
log(`- Leaves missing \`plan.md\`: ${summary.missingPlan}`);
log(`- Leaves missing \`findings/\`: ${summary.missingFindings}`);
log(`- Leaves with scratch dirs inside \`findings/\` (drift): ${summary.findingsScratch}`);
log(`- Leaves with stray files/dirs at task root: ${summary.anyStray}`);

try {
  fs.mkdirSync(path.dirname(path.resolve(OUT_PATH)), { recursive: true });
  fs.writeFileSync(OUT_PATH, out);
} catch (e) {
  console.error('IO failure writing --out: ' + e.message);
  process.exit(1);
}
console.log('Written to ' + OUT_PATH + ' (' + out.split('\n').length + ' lines)');
console.log('Summary:', JSON.stringify(summary, null, 2));
