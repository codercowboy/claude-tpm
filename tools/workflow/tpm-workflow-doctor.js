#!/usr/bin/env node
/**
 * tpm-workflow-doctor.js — a fail-loud PREFLIGHT for the workflow install seams. Every check here corresponds to a
 * way a real `/tpm-workflow` fan-out silently broke in a consumer (claude-decant, 2026-09-01): charters
 * resolving to placeholders, the gate hook not wired, compose emitting bare bundle paths, signoff not
 * writable. Each of those was a 5-second red line that instead cost a whole round. This is the
 * operational form of the "fail loud, name the missing thing" hygiene in
 * claude-context/dev/gating-and-failure-patterns.md.
 *
 * Runs in claude-admin OR in a consumer install (it self-locates the bundle from this file's position,
 * and reads the PROJECT's .claude/settings.json for the wired hooks).
 *
 * USAGE:  node tools/workflow/tpm-workflow-doctor.js [--project-root <dir>] [--json]
 * EXIT:   0 = all checks pass, 1 = at least one FAIL (prints the fix for each).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const BUNDLE = path.resolve(__dirname, '..', '..'); // <bundle>/tools/workflow → <bundle>

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(startDir || process.cwd());
}

function readSettings(projectRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.json'), 'utf8')); }
  catch (_e) { return null; }
}
function hookWired(settings, matcherSub, cmdSub) {
  const pre = (settings && settings.hooks && settings.hooks.PreToolUse) || [];
  return pre.some((e) => String(e.matcher || '').includes(matcherSub)
    && (e.hooks || []).some((h) => String(h.command || '').includes(cmdSub)));
}

// ── the checks (each returns { ok, detail, fix }) ────────────────────────────

function checkCharters(projectRoot) {
  let resolved;
  try { resolved = require('./tpm-workflow-config-resolver.js').resolveConfig(undefined, { startDir: projectRoot }).resolved; }
  catch (e) { return { ok: false, detail: `config-resolver threw: ${e.message}`, fix: 'fix the config / config.json JSON.' }; }
  const configured = resolved.subagentConfigs.filter((sc) => sc.charterFile);
  const missing = configured.filter((sc) => !fs.existsSync(sc.charterFile));
  if (missing.length) {
    return {
      ok: false,
      detail: `${missing.length}/${configured.length} default charter(s) DO NOT resolve (e.g. ${missing[0].name} → ${missing[0].charterFile})`,
      fix: 'default charters live under the BUNDLE — config-resolver.charterHome() self-locates it; a bare/relative charterFile resolves at the project root instead. Run `tpm-workflow-config-resolver.js --validate`.',
    };
  }
  return { ok: true, detail: `all ${configured.length} default charters resolve on disk` };
}

function checkGateHook(settings) {
  return hookWired(settings, 'Agent', 'gate-spawn.js')
    ? { ok: true, detail: 'spawn-gate PreToolUse hook is wired (Agent)' }
    : { ok: false, detail: 'no spawn-gate hook wired for the Agent tool', fix: 'add a PreToolUse `Agent|Task` hook → tools/workflow/hooks/tpm-workflow-gate-spawn.js in .claude/settings.json (the scaffolder does this). Without it, Gate B is a no-op.' };
}

function checkExpandHook(settings) {
  return hookWired(settings, 'Read', 'expand-tpm-home.js')
    ? { ok: true, detail: 'expand-tpm-home PreToolUse hook is wired (Read/Glob/Grep)' }
    : { ok: false, detail: 'no ${TPM_HOME} expand hook wired for Read', fix: 'add a PreToolUse `Read|Glob|Grep|NotebookRead` hook → tools/consumer/hooks/expand-tpm-home.js. Without it, ${TPM_HOME}/… reads dead-end at the project root.' };
}

function checkSignoffWritable(projectRoot) {
  try {
    const d = path.join(projectRoot, 'tmp', 'tpm-signoff');
    fs.mkdirSync(d, { recursive: true });
    const probe = path.join(d, '.doctor-probe');
    fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe);
    return { ok: true, detail: 'signoff store (tmp/tpm-signoff) is writable' };
  } catch (e) {
    return { ok: false, detail: `cannot write tmp/tpm-signoff: ${e.message}`, fix: 'ensure tmp/ is writable — signoff tokens gate spawns.' };
  }
}

function checkCompose() {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'doctor-compose-'));
  try {
    fs.writeFileSync(path.join(tmp, 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(tmp, 'charter.md'), '# charter\n');
    const out = cp.execFileSync('node', [
      path.join(BUNDLE, 'tools', 'workflow', 'tpm-workflow-compose-spawn-prompt.js'),
      '--role', 'builder', '--phase-dir', 'dev/doctor/01-probe',
      '--plan', path.join(tmp, 'plan.md'), '--charter', path.join(tmp, 'charter.md'),
    ], { encoding: 'utf8' });
    const hasMarker = /<!--\s*tpm-workflow-spawn\s+phase="[^"]+"\s+role="[^"]+"\s*-->/.test(out);
    const hasToken = out.includes('${TPM_HOME}/claude-context/methodology');
    if (!hasMarker) return { ok: false, detail: 'compose output has NO well-formed quoted spawn-gate marker', fix: 'compose must emit `<!-- tpm-workflow-spawn phase="…" role="…" -->` (the gate keys off it).' };
    if (!hasToken) return { ok: false, detail: 'compose emits BARE methodology paths (not ${TPM_HOME}/…)', fix: 'tokenize the base-chain paths so a consumer worker can resolve them via the expand hook.' };
    return { ok: true, detail: 'compose emits the quoted gate marker + ${TPM_HOME}/ methodology paths' };
  } catch (e) {
    return { ok: false, detail: `compose failed to run: ${String(e.message).split('\n')[0]}`, fix: 'compose needs --role --phase-dir --plan --charter; run it with all required flags.' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runAll(projectRoot) {
  const settings = readSettings(projectRoot);
  return [
    ['charters resolve', checkCharters(projectRoot)],
    ['spawn-gate hook wired', checkGateHook(settings)],
    ['${TPM_HOME} expand hook wired', checkExpandHook(settings)],
    ['signoff store writable', checkSignoffWritable(projectRoot)],
    ['compose emits marker + tokens', checkCompose()],
  ];
}

function main(argv) {
  let projectRoot = null; let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-root') projectRoot = argv[++i];
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write('usage: tpm-workflow-doctor.js [--project-root <dir>] [--json]\n'); process.exit(0);
    }
  }
  projectRoot = findProjectRoot(projectRoot);
  const results = runAll(projectRoot);
  const failed = results.filter(([, r]) => !r.ok);
  if (json) {
    process.stdout.write(JSON.stringify({ projectRoot, bundle: BUNDLE, ok: failed.length === 0, checks: results.map(([name, r]) => ({ name, ...r })) }, null, 2) + '\n');
  } else {
    process.stdout.write(`tpm-workflow doctor — project: ${projectRoot}\n                      bundle:  ${BUNDLE}\n\n`);
    for (const [name, r] of results) {
      process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${name}\n      ${r.detail}\n`);
      if (!r.ok && r.fix) process.stdout.write(`      → fix: ${r.fix}\n`);
    }
    process.stdout.write(`\n${failed.length === 0 ? '✓ all preflight checks pass' : `✗ ${failed.length} check(s) FAILED — fix before spawning a round`}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { runAll, checkCharters, checkGateHook, checkExpandHook, checkSignoffWritable, checkCompose, findProjectRoot, BUNDLE };
