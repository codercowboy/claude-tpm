'use strict';
/**
 * tools/tests/lib/guard-helpers.js — shared plumbing for the cross-cutting GUARD tests
 * (npx regression guard, doc-example checker, env-leak guard, package contents, hook contract).
 *
 * TEST infrastructure only (never shipped: package.json `files` excludes **\/tests/**). Zero deps.
 *
 * Safety model every guard test relies on:
 *   - child processes get a FROM-SCRATCH env (no inherited TPM_PROJECT_ROOT / TPM_HOME / CLAUDE_PROJECT_DIR),
 *     HOME + CLAUDE_CONFIG_DIR pointed at a scratch dir, and a FAKE `claude` first on PATH — so even an
 *     installer/doctor run can never reach the real CLI, the real plugin registry, or ~/.claude.
 *   - bundle copies (for plant-a-defect "bite" proofs) live under the OS-temp scratch root, never the bundle.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { bundleRoot, mkScratch } = require('./scratch');

const BUNDLE = bundleRoot(__dirname);

/** All files under `dir` (recursive, sorted) whose absolute path passes `accept(absPath)`. Skips junk dirs. */
function walk(dir, accept, skipDirNames) {
  const skip = new Set(skipDirNames || ['node_modules', '.git', 'tmp']);
  const out = [];
  (function rec(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_e) { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) rec(p); } else if (e.isFile() && (!accept || accept(p))) out.push(p);
    }
  })(dir);
  return out;
}

/** Copy the bundle (minus tmp/ node_modules/ .git/ .DS_Store) into a fresh scratch dir; returns the copy's root. */
function copyBundle(label) {
  const dest = path.join(mkScratch(label || 'bundle-copy'), 'claude-tpm');
  const skip = new Set(['tmp', 'node_modules', '.git', '.DS_Store']);
  fs.cpSync(BUNDLE, dest, {
    recursive: true,
    filter: (src) => !skip.has(path.basename(src)),
  });
  return dest;
}

/** A scratch dir holding a fake `claude` (logs argv, prints nothing, exit 0). Returns { bin, log, home }. */
function makeFakeClaude(label) {
  const dir = mkScratch(label || 'fake-claude');
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const log = path.join(dir, 'claude-calls.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { bin, log, home };
}

/** From-scratch child env: fake claude first on PATH, temp HOME/CLAUDE_CONFIG_DIR, `extra` merged (undefined = omit). */
function safeEnv(fake, extra) {
  const env = {
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fake.home,
    CLAUDE_CONFIG_DIR: path.join(fake.home, '.claude'),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NO_COLOR: '1',
  };
  for (const [k, v] of Object.entries(extra || {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

/** Run `node <root>/tools/tpm.js …args` (never a bare `npx tpm`). Returns { status, out, err, all }. */
function runTpm(root, args, opts) {
  const o = opts || {};
  const r = spawnSync('node', [path.join(root, 'tools', 'tpm.js'), ...args], {
    cwd: o.cwd || root, env: o.env, input: o.input || '', encoding: 'utf8', timeout: o.timeout || 60000,
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}

/** A minimal marked consumer project (just the `.claude/claude-tpm/` marker dir). */
function makeProject(label) {
  const dir = path.join(mkScratch(label || 'proj'), 'proj');
  fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true });
  return dir;
}

/**
 * The verbs a suite really has: candidate words from the suite's bare listing (`  verb …` lines), kept only when
 * `tpm <suite> <verb> --help` exits 0 (so example lines like `  tpm session open …` drop out).
 */
function listVerbs(suite, root, env) {
  const r = runTpm(root, [suite], { env });
  const cand = new Set();
  for (const line of r.all.split('\n')) {
    const m = /^ {2}([a-z][a-z-]*)(?:\s|$)/.exec(line);
    if (m) cand.add(m[1]);
  }
  return [...cand].filter((v) => runTpm(root, [suite, v, '--help'], { env }).status === 0);
}

module.exports = { BUNDLE, walk, copyBundle, makeFakeClaude, safeEnv, runTpm, makeProject, listVerbs };
