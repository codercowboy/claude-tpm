#!/usr/bin/env node
/**
 * tpm-consumer-lint-skill-refs.js — keep the tpm-* skills RELOCATABLE. A consumer runs the skills from a project
 * where claude-tpm lives under `node_modules/@codercowboy/claude-tpm/`, so every reference the skill
 * makes to the SHARED BUNDLE (its methodology docs + its tool suite) must carry the `${TPM_HOME}/`
 * placeholder — which the expand hook (reads) or the shell (`$TPM_HOME` in Bash) resolves. A bare
 * `node tools/…` or `claude-context/methodology/…` would dead-end at the consumer root.
 *
 * This lint flags the two BUNDLE-REF shapes that must be tokenized:
 *   1. tool INVOCATIONS / references:  `node tools/…`  and  `` `tools/… ``
 *   2. methodology doc READS:          `claude-context/methodology/…`  and  `` `methodology/… `` (shorthand)
 *
 * It deliberately does NOT flag:
 *   • already-tokenized refs (`${TPM_HOME}/…`),
 *   • the `out/…`-prefixed staged-tool paths (a build-phase concern),
 *   • WORKSPACE refs that live in the CONSUMER's own tree, not the bundle — `dev/<task>/`,
 *     `claude-context/sessions/`, `claude-context/tasks/`,
 *   • illustrative `in:/out: tools/…` example paths in round-plan templates (not invocations/reads).
 *
 * Usage:  node tools/consumer/tpm-consumer-lint-skill-refs.js [<dir-or-file> …]   (default: .claude/skills)
 * Exit:   0 = clean, 1 = violations found (prints file:line + the offending text + the fix).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// A violation = a bundle ref MISSING the ${TPM_HOME}/ prefix. Each rule: {re, why}. The negative
// lookbehind on the methodology rules lets an already-tokenized `${TPM_HOME}/claude-context/…` pass.
const RULES = [
  { re: /\bnode\s+tools\//, why: 'bare tool invocation — use `node ${TPM_HOME}/tools/…`' },
  { re: /`tools\//, why: 'bare bundle tool ref — use `${TPM_HOME}/tools/…`' },
  { re: /(?<!\$\{TPM_HOME\}\/)claude-context\/methodology\//, why: 'bare methodology read — use `${TPM_HOME}/claude-context/methodology/…`' },
  { re: /`methodology\//, why: 'bare methodology shorthand — use `${TPM_HOME}/claude-context/methodology/…`' },
];

function collectMdFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return target.endsWith('.md') ? [target] : [];
  const out = [];
  for (const entry of fs.readdirSync(target)) {
    out.push(...collectMdFiles(path.join(target, entry)));
  }
  return out;
}

function lintFile(file) {
  const violations = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) violations.push({ file, line: i + 1, text: line.trim(), why: rule.why });
    }
  });
  return violations;
}

function main(argv) {
  const targets = argv.length ? argv : [path.join('.claude', 'skills')];
  const files = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) { process.stderr.write(`lint-skill-refs: no such path: ${t}\n`); process.exit(2); }
    files.push(...collectMdFiles(t));
  }
  let all = [];
  for (const f of files) all = all.concat(lintFile(f));
  if (all.length === 0) {
    process.stdout.write(`✓ skill refs clean — ${files.length} file(s), every bundle ref carries \${TPM_HOME}/\n`);
    process.exit(0);
  }
  process.stdout.write(`✗ ${all.length} bare bundle ref(s) — must be \${TPM_HOME}/-prefixed:\n`);
  for (const v of all) process.stdout.write(`  ${v.file}:${v.line}  ${v.why}\n      ${v.text}\n`);
  process.exit(1);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { lintFile, RULES };
