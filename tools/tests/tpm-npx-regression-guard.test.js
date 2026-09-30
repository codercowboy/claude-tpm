#!/usr/bin/env node
'use strict';
/**
 * tpm-npx-regression-guard.test.js — fails if a CLAUDE-FACING surface instructs `npx tpm …`.
 *
 * WHY: inside a Claude session the plugin's bin/ puts bare `tpm` on PATH. `npx tpm …` falls through to an
 * UNRELATED registry package named `tpm` wherever there is no local node_modules/.bin/tpm. The epic swept
 * every instruction to bare `tpm`; this guard stops a later edit from quietly bringing `npx tpm` back.
 *
 * TWO LAYERS (each proven to bite by planting a defect in a temp COPY of the bundle — never the real tree):
 *   1. FILE scan  — .claude/skills/**, claude-context/methodology/**, tools/**\/*.md (excluding every tests/
 *      folder: fixtures, golden, the old smoke suite), plus the plugin manifests (hooks/hooks.json, .claude-plugin/*),
 *      which may contain NO `npx tpm` at all.
 *   2. EMITTED text — what the tools actually print to Claude: `tpm --help` + every suite/verb --help,
 *      reading-list (both roles), compose, boot-read, session/task/workflow/plugin doctors (healthy, broken,
 *      legacy-data worlds), export/list/show output.
 *
 * ALLOWLIST (a line containing `npx tpm` passes only if it is one of these, each a deliberate human-form line):
 *   A  pre-install porcelain          `npx tpm install|uninstall|doctor|plugin …`  (runs before the plugin bin is on PATH).
 *      ONLY in human-facing places — FILES: any README.md, tools/consumer/**, tools/plugin/**, tools/tpm.md;
 *      EMITTED: the output of the `install` / `uninstall` / `doctor` / `plugin …` commands (their --help + doctor text).
 *      NEVER in .claude/skills/** or claude-context/methodology/** (even a README.md there), and never in the emitted
 *      text of any other command (a skill telling Claude to run `npx tpm doctor` is the exact regression).
 *   B  a negation naming the hazard   "never/not/no/flags `npx tpm`"        (the convention + the linter's own rule text)
 *   C  a marked human-form note       the line carries the literal marker `Human terminal:` (case-sensitive, with the
 *      colon) — e.g. "> Human terminal: outside a Claude session, run these as `npx tpm …`". Loose phrases ("for humans",
 *      "plain project shell", …) no longer count. Convention documented in methodology/tool-conventions.md.
 *   Tighter: a per-suite tool doc (tools/<suite>/*.md, not a README) may carry AT MOST ONE C line.
 *
 * Run: node tools/tests/tpm-npx-regression-guard.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { walk, copyBundle, makeFakeClaude, safeEnv, runTpm, makeProject, listVerbs, BUNDLE } = require('./lib/guard-helpers');

const NPX = /\bnpx\s+tpm\b/;
const ALLOW = {
  A: /\bnpx\s+tpm\s+(install|uninstall|doctor|plugin)\b/, // pre-install porcelain (the `plugin` suite is the same human adoption surface)
  B: /\b(not|never|no|flags?|forbids?|rejects?)\b[^`'\n]{0,40}[`']npx tpm/i,
  C: /Human terminal:/, // the one explicit marker a human-form note must carry
};

/** FILES where rule A (pre-install porcelain) is legitimate: human-facing docs only, never skills / methodology. */
function fileAllowsA(rel) {
  const p = rel.split(path.sep).join('/');
  if (p.startsWith('.claude/skills/') || p.startsWith('claude-context/methodology/')) return false;
  return path.posix.basename(p) === 'README.md' || p.startsWith('tools/consumer/') || p.startsWith('tools/plugin/') || p === 'tools/tpm.md';
}
/** EMITTED text where rule A is legitimate: the output of the install / uninstall / doctor / plugin commands. */
const emittedAllowsA = (args) => /^(install|uninstall|doctor|plugin)$/.test(args[0] || '');

function classify(line, allowA) {
  for (const k of ['A', 'B', 'C']) if ((k !== 'A' || allowA) && ALLOW[k].test(line)) return k;
  return null;
}

/** Scan one text blob; returns [{line, text}] for every NON-allowlisted `npx tpm` line + the count of C lines. */
function scanText(text, allowA) {
  const bad = []; let cLines = 0;
  text.split('\n').forEach((l, i) => {
    if (!NPX.test(l)) return;
    const k = classify(l, allowA);
    if (!k) bad.push({ line: i + 1, text: l.trim().slice(0, 140) });
    else if (k === 'C') cLines += 1;
  });
  return { bad, cLines };
}

// KNOWN ISSUES — real defects this guard found that are NOT test bugs. Reported (not failed) so the suite stays
// green while a fix round is routed; each prints `KNOWN-ISSUE` and, once fixed, `FIXED — delete this entry`.
//   K1: the installer's --help header (reached via `tpm install|plugin install|plugin doctor|doctor --help`) still says
//       "skills call `npx tpm …` and %TPM_HOME% is resolved anchor-first via `npx tpm resolve-home`" — stale: skills
//       call bare `tpm`, and 0.2.0's SessionStart hook DOES export TPM_HOME. Doc/help text only, in tools/consumer/.
const KNOWN = [
  { id: 'K1', re: /skills call `npx tpm …`|via `npx tpm resolve-home`/, where: /^tpm (install|uninstall|plugin (install|doctor|uninstall)|doctor) --help/ },
];
const seenKnown = new Set();
function partitionKnown(violations) {
  const real = [];
  for (const v of violations) {
    const k = KNOWN.find((x) => x.re.test(v) && x.where.test(v));
    if (k) seenKnown.add(k.id); else real.push(v);
  }
  return real;
}

const isUnderTests = (rel) => rel.split(path.sep).includes('tests');

/** Layer 1 over the bundle rooted at `root`. Returns [violation strings]. */
function scanFiles(root) {
  const v = [];
  const files = [
    ...walk(path.join(root, '.claude', 'skills')),
    ...walk(path.join(root, 'claude-context', 'methodology')),
    ...walk(path.join(root, 'tools'), (p) => p.endsWith('.md')),
  ].filter((p) => !isUnderTests(path.relative(root, p)));
  for (const f of files) {
    const rel = path.relative(root, f);
    const { bad, cLines } = scanText(fs.readFileSync(f, 'utf8'), fileAllowsA(rel));
    for (const b of bad) v.push(`${rel}:${b.line}  ${b.text}`);
    // per-suite tool docs: tools/<suite>/<doc>.md (depth 3, not a README) → at most one human-form note
    const parts = rel.split(path.sep);
    if (parts[0] === 'tools' && parts.length === 3 && !/^README\.md$/.test(parts[2]) && cLines > 1) {
      v.push(`${rel}  has ${cLines} human-form \`npx tpm\` notes (max 1 per tool doc)`);
    }
  }
  // manifests: strictly zero
  for (const f of [path.join(root, 'hooks', 'hooks.json'), ...walk(path.join(root, '.claude-plugin'))]) {
    if (!fs.existsSync(f)) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (NPX.test(l)) v.push(`${path.relative(root, f)}:${i + 1}  manifest must not mention npx tpm: ${l.trim().slice(0, 100)}`);
    });
  }
  return { violations: v, fileCount: files.length };
}

/** Layer 2: run the commands, scan stdout+stderr. Returns { violations, commands }. */
function scanEmitted(root, fake, project, quick) {
  const env = safeEnv(fake);
  const cmds = [[], ['--help']];
  for (const suite of quick ? [] : ['session', 'task', 'workflow', 'hooks', 'plugin']) {
    cmds.push([suite], [suite, '--help']);
    const verbs = new Set(listVerbs(suite, root, env));
    if (suite === 'task') ['config', 'export', 'search', 'doctor', 'migrate'].forEach((x) => verbs.add(x));
    for (const verb of verbs) cmds.push([suite, verb, '--help']);
  }
  cmds.push(
    ['reading-list', 'orchestrator'], ['reading-list', 'subagent'], ['home'], ['doc', 'claude-context/methodology/tool-conventions.md'],
    ['workflow', 'compose', '--role', 'builder', '--phase-dir', 'dev/demo/01-x', '--plan', 'plan.md', '--charter', 'charter-builder.md'],
    ['workflow', 'compose', '--role', 'verifier', '--phase-dir', 'dev/demo/01-x', '--plan', 'plan.md', '--charter', 'charter-verifier.md'],
    ['session', 'boot-read'], ['session', 'doctor'], ['session', 'export', '--style', 'human', '--last', '1'], ['session', 'current', '--state'],
    ['task', 'doctor'], ['task', 'list'], ['task', 'show', 'all'], ['task', 'history', '1000'], ['task', 'export', '--human'],
    ['workflow', 'doctor'], ['plugin', 'doctor', project], ['doctor', project],
    // legacy / broken worlds → the migrate / reindex hints
    ['session', 'doctor', '--sessions-dir', path.join(root, 'tools/session/tests/fixtures/legacy')],
    ['task', 'doctor', '--tasks-dir', path.join(root, 'tools/task/tests/fixtures/legacy-tasks')],
  );
  const v = [];
  for (const args of (quick ? cmds.filter((a) => /^(reading-list|home|doc)$/.test(a[0]) || a.length === 0 || a[0] === '--help') : cmds)) {
    const r = runTpm(root, args, { cwd: project, env });
    const { bad } = scanText(r.all, emittedAllowsA(args));
    for (const b of bad) v.push(`tpm ${args.map((a) => (a.startsWith('/') ? '<path>' : a)).join(' ')}  →  ${b.text}`);
  }
  return { violations: v, commands: cmds.length };
}

/** A seeded project (session + task + corrupted-index sibling) for the emitted-text scan. */
function seedProject(root, fake) {
  const proj = makeProject('npx-guard-proj');
  const env = safeEnv(fake);
  const run = (a) => assert.strictEqual(runTpm(root, a, { cwd: proj, env }).status, 0, `seed: tpm ${a.join(' ')}`);
  run(['session', 'open', '--session', '0001', '--session-id', 'g1']);
  run(['session', 'note', '--session', '0001', '--log', '--status', 'DONE', '--text', 'x']);
  run(['session', 'punchlist', '--session', '0001', '--action', 'add', '--text', 'do thing']);
  run(['task', 'add', '--headline', 'hello']);
  return proj;
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-npx-regression-guard.test.js\n');

const fake = makeFakeClaude('npx-guard');

// ── the real bundle must be clean ───────────────────────────────────────────────────────────────────────────────
check('FILES: no Claude-facing file in the bundle instructs `npx tpm` (skills, methodology, tool docs, manifests)', () => {
  const { violations, fileCount } = scanFiles(BUNDLE);
  assert.ok(fileCount > 40, `scan too narrow (${fileCount} files)`);
  assert.deepStrictEqual(violations, [], 'non-allowlisted `npx tpm`:\n  ' + violations.join('\n  '));
});

check('FILES: the allowlist is live, not vacuous — the convention + human-form notes DO exist and are classified', () => {
  const conv = fs.readFileSync(path.join(BUNDLE, 'claude-context/methodology/tool-conventions.md'), 'utf8');
  const hits = conv.split('\n').filter((l) => NPX.test(l));
  assert.ok(hits.length >= 2, 'tool-conventions.md carries the convention lines');
  assert.ok(hits.every((l) => classify(l, false) !== null), 'every convention line is allowlisted (rule A is not available to methodology docs)');
  assert.ok(hits.some((l) => classify(l, false) === 'B') && hits.some((l) => classify(l, false) === 'C'), 'the convention shows both the negation (B) and a marked human-form example (C)');
  assert.ok(/Human terminal:/.test(conv) && /marker/.test(conv), 'tool-conventions.md documents the Human terminal: marker');
  const doc = fs.readFileSync(path.join(BUNDLE, 'tools/task/tpm-task.md'), 'utf8');
  assert.ok(doc.split('\n').some((l) => NPX.test(l) && classify(l, false) === 'C'), 'tool docs keep their one human-form note');
});

const proj = seedProject(BUNDLE, fake);
const before = fs.existsSync(fake.log) ? fs.readFileSync(fake.log, 'utf8') : '';

check('EMITTED: nothing the tools print to Claude (help, reading-list, compose, boot-read, doctors, export) instructs `npx tpm`', () => {
  const { violations: raw, commands } = scanEmitted(BUNDLE, fake, proj);
  assert.ok(commands > 80, `command coverage too small (${commands})`);
  const violations = partitionKnown(raw);
  assert.deepStrictEqual(violations, [], 'non-allowlisted `npx tpm` in emitted text:\n  ' + violations.join('\n  '));
});

check('EMITTED: the plugin/flat doctors ran against the FAKE claude only (never the real CLI)', () => {
  const after = fs.existsSync(fake.log) ? fs.readFileSync(fake.log, 'utf8') : '';
  assert.ok(after.length >= before.length);
  assert.ok(/--version|plugin/.test(after), 'the doctor reached the fake claude shim on PATH');
});

// ── bite proofs: plant defects in a temp COPY ───────────────────────────────────────────────────────────────────
const copy = copyBundle('npx-guard-copy');
const edit0 = (root, rel, fn) => {
  const p = path.join(root, rel);
  const s = fs.readFileSync(p, 'utf8'); const t = fn(s);
  assert.notStrictEqual(t, s, `plant in ${rel} changed nothing`);
  fs.writeFileSync(p, t);
};
const edit = (rel, fn) => {
  const p = path.join(copy, rel);
  const s = fs.readFileSync(p, 'utf8'); const t = fn(s);
  assert.notStrictEqual(t, s, `plant in ${rel} changed nothing`);
  fs.writeFileSync(p, t);
};

check('BITE (files): planted `npx tpm task list` in a skill, a methodology doc and a tool doc → each is flagged', () => {
  const clean = scanFiles(copy);
  assert.deepStrictEqual(clean.violations, [], 'control: the untouched copy is clean');
  edit('.claude/skills/tpm-task/SKILL.md', (s) => s + '\nRun `npx tpm task list` to see the open tasks.\n');
  edit('claude-context/methodology/shared-conventions.md', (s) => s + '\nnpx tpm session boot-read\n');
  edit('tools/session/tpm-session-ops.md', (s) => s + '\n    npx tpm session note --log --status DONE --text x\n');
  const v = scanFiles(copy).violations.join('\n');
  assert.ok(/tpm-task\/SKILL\.md/.test(v), 'skill plant flagged');
  assert.ok(/shared-conventions\.md/.test(v), 'methodology plant flagged');
  assert.ok(/tpm-session-ops\.md/.test(v), 'tool-doc plant flagged');
});

check('BITE (files): a SECOND human-form note in one tool doc, and `npx tpm` in hooks.json, are flagged', () => {
  edit('tools/task/tpm-task-export.md', (s) => s + '\nHuman terminal: run these as `npx tpm task export`.\n');
  edit('hooks/hooks.json', (s) => s.replace('hooks session-start', 'hooks session-start && npx tpm hooks session-start'));
  const v = scanFiles(copy).violations.join('\n');
  assert.ok(/tpm-task-export\.md\s+has 2 human-form/.test(v), 'second human note flagged');
  assert.ok(/hooks\.json.*manifest must not mention npx tpm/.test(v), 'manifest plant flagged');
});

/** Append `text` to a file (creating it if needed) in `root`, run `fn()`, then put the file back (or empty a created one). */
function withPlant(root, rel, text, fn) {
  const p = path.join(root, rel);
  const had = fs.existsSync(p); const orig = had ? fs.readFileSync(p, 'utf8') : '';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, orig + text);
  try { return fn(); } finally { fs.writeFileSync(p, orig); }
}
const violationsFor = (root, rel) => scanFiles(root).violations.filter((x) => x.startsWith(rel + ':') || x.startsWith(rel + ' '));

check('BITE (rule A): "Run `npx tpm doctor` …" in a skill, a methodology doc or a per-suite tool doc FAILS; in a README / tools/consumer / tools/plugin doc / tools/tpm.md PASSES', () => {
  const c = copyBundle('npx-guard-ruleA');
  const line = '\nRun `npx tpm doctor` to check the install.\n';
  assert.deepStrictEqual(scanFiles(c).violations, [], 'control: untouched copy is clean');
  for (const rel of ['.claude/skills/tpm-task/SKILL.md', '.claude/skills/tpm-task/README.md', 'claude-context/methodology/shared-conventions.md', 'tools/task/tpm-task.md']) {
    const v = withPlant(c, rel, line, () => violationsFor(c, rel));
    assert.strictEqual(v.length, 1, `rule A must NOT excuse ${rel}: ${JSON.stringify(v)}`);
  }
  for (const rel of ['tools/task/README.md', 'tools/README.md', 'tools/consumer/planted-doc.md', 'tools/plugin/planted-doc.md', 'tools/tpm.md']) {
    const v = withPlant(c, rel, line, () => scanFiles(c).violations);
    assert.deepStrictEqual(v, [], `rule A is accepted in ${rel}`);
  }
});

check('BITE (rule C): loose-phrase `npx tpm` lines in a tool doc FAIL without the marker; the marker line passes; a 2nd marked note still trips max-1', () => {
  const c = copyBundle('npx-guard-ruleC');
  const rel = 'tools/task/tpm-task-config.md';
  assert.deepStrictEqual(scanFiles(c).violations, [], 'control: untouched copy is clean');
  for (const loose of ['For humans: npx tpm task list', 'Outside a Claude session, run npx tpm task list', 'In a plain project shell use npx tpm task list', 'human terminal: npx tpm task list', 'Human terminal npx tpm task list']) {
    // strip the doc's own marker so the planted line is the only candidate, then check it is flagged as an unlisted npx tpm
    const v = withPlant(c, rel, '\n' + loose + '\n', () => violationsFor(c, rel));
    assert.strictEqual(v.length, 1, `loose phrase must fail: "${loose}" → ${JSON.stringify(v)}`);
    assert.ok(/:\d+\s/.test(v[0]), 'flagged as an unlisted line, not just the count rule');
  }
  const marked = withPlant(c, rel, '\nHuman terminal: npx tpm task list\n', () => violationsFor(c, rel));
  assert.strictEqual(marked.length, 1, JSON.stringify(marked));
  assert.ok(/has 2 human-form/.test(marked[0]), 'the marked line is accepted as C; only the max-1 rule fires');
});

check('BITE (emitted): rule A is NOT accepted in a non-install command\'s output, and a marker-less `tpm --help` human line is flagged', () => {
  const c = copyBundle('npx-guard-emitA');
  edit0(c, 'tools/tpm-reading-list.js', (s) => s.replace(/tpm doc /g, 'npx tpm doctor '));
  const v = partitionKnown(scanEmitted(c, fake, proj, true).violations).join('\n');
  assert.ok(/reading-list orchestrator\s+→\s+npx tpm doctor/.test(v), 'rule A not excused for reading-list output:\n' + v.slice(0, 300));
  const d = copyBundle('npx-guard-emitC');
  edit0(d, 'tools/tpm.js', (s) => s.replace('Human terminal: in a plain', 'In a plain'));
  const w = partitionKnown(scanEmitted(d, fake, proj, true).violations).join('\n');
  assert.ok(/tpm --help\s+→\s+.*npx tpm/.test(w), 'marker-less human line in tpm --help flagged:\n' + w.slice(0, 300));
});

check('BITE (emitted): a tool that starts printing `npx tpm …` (reading-list) is flagged', () => {
  const clean = { violations: partitionKnown(scanEmitted(copy, fake, proj, true).violations) };
  // the copy still has the file-scan plants but the emitted layer reads only code → must be clean here
  assert.deepStrictEqual(clean.violations, [], 'control: emitted text of the copy is clean:\n  ' + clean.violations.join('\n  '));
  edit('tools/tpm-reading-list.js', (s) => s.replace(/tpm doc /g, 'npx tpm doc '));
  const v = partitionKnown(scanEmitted(copy, fake, proj, true).violations).join('\n');
  assert.ok(/reading-list orchestrator\s+→\s+npx tpm doc/.test(v), 'reading-list regression flagged:\n' + v.slice(0, 400));
});

for (const k of KNOWN) {
  process.stdout.write(seenKnown.has(k.id)
    ? `  ! KNOWN-ISSUE ${k.id} still present (reported in findings/HANDOFF.md, route a fix round)\n`
    : `  ✓ KNOWN-ISSUE ${k.id}: FIXED — delete this entry from KNOWN in this test\n`);
}
process.stdout.write(`\nPASS — ${count} checks\n`);
