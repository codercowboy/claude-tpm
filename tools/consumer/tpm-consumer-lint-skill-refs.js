#!/usr/bin/env node
/**
 * tpm-consumer-lint-skill-refs.js — keep the tpm-* skills RELOCATABLE. A consumer runs the skills from a project
 * where claude-tpm lives under `node_modules/@codercowboy/claude-tpm/`, so a skill must never reach the
 * SHARED BUNDLE by a bare path that dead-ends at the consumer root. Two relocatable forms are correct:
 *   - tool INVOCATIONS route through the bin — `npx tpm <suite> <verb>` (self-locating; env.TPM_HOME retired).
 *   - methodology doc READS use `npx tpm doc <relpath>` (self-resolving, bypass-safe), OR carry the
 *     `%TPM_HOME%/` placeholder in a prose CITATION — the PostToolUse content hook / `tpm doc` resolve it.
 * (The old Bash `$TPM_HOME` shell-resolution path is gone: nothing shell-expands $TPM_HOME anymore.)
 * A bare `node tools/…` or `claude-context/methodology/…` would dead-end at the consumer root.
 *
 * SPELLING (#1102 respell): the shell-inert `%TPM_HOME%` is the PREFERRED placeholder. `${TPM_HOME}` is the
 * legacy shell-EXPANDING spelling (`${…}` is bash parameter-expansion; on a command line it silently expands
 * to empty and corrupts the path). Resolution accepts BOTH during the transition (the content hook and `tpm
 * doc` each carry both spellings), so a tokenized ref in EITHER spelling is treated as relocatable — but a
 * `${TPM_HOME}` in skill content is FLAGGED (rule 5) so the old spelling can't creep back in.
 *
 * This lint flags the bundle-ref shapes that are NOT relocatable:
 *   1. bare tool INVOCATIONS / references:  `node tools/…`  and  `` `tools/… ``  (→ `npx tpm <suite> <verb>`)
 *   2. bare bundle-SCRIPT invocations:      `` `tpm-<name>.js` `` (bare, no path) (→ `npx tpm <suite> <verb>`)
 *   3. bare methodology doc READS:          `claude-context/methodology/…`  and  `` `methodology/… `` (→ `npx tpm doc …` / `%TPM_HOME%/…`)
 *   4. the legacy shell-expanding placeholder `${TPM_HOME}` anywhere in content (→ respell to `%TPM_HOME%`)
 *
 * It deliberately does NOT flag:
 *   • already-tokenized refs in the PREFERRED spelling (`%TPM_HOME%/…`) — nor `npx tpm doc …` reads,
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

// A violation = a bundle ref MISSING a relocatable prefix, OR the legacy shell-expanding spelling. Each
// rule: {re, why}. The negative lookbehinds on the methodology rule let an already-tokenized ref in EITHER
// spelling (`%TPM_HOME%/…` preferred, `${TPM_HOME}/…` legacy) or a `npx tpm doc …` read pass rule 2 —
// while rule 5 still flags the legacy `${TPM_HOME}` spelling so it prefers/enforces `%TPM_HOME%`.
const RELOCATABILITY_RULES = [
  { re: /\bnode\s+tools\//, why: 'bare tool invocation — route through the bin: `npx tpm <suite> <verb>`' },
  { re: /`tools\//, why: 'bare bundle tool ref — invoke via `npx tpm <suite> <verb>` (or cite the file as `%TPM_HOME%/tools/…`)' },
  // #1126: a BARE bundle-script name in backticks (`tpm-task.js`, `tpm-workflow-cost-ledger.js`) reads as a
  // run-this even though it names no path — the reader can't run it without knowing where the bundle lives.
  // Route every such INVOCATION through the bin. A full-PATH citation `%TPM_HOME%/tools/…/x.js` (backtick
  // followed by the token, not by `tpm-`) is a location reference, not an invocation, so it is NOT flagged.
  { re: /`tpm-[\w-]+\.js/, why: 'bare bundle-script invocation — route through the bin: `npx tpm <suite> <verb>` (a full-path citation `%TPM_HOME%/tools/…/x.js` is fine)' },
  { re: /(?<!%TPM_HOME%\/)(?<!\$\{TPM_HOME\}\/)(?<!doc )claude-context\/methodology\//, why: 'bare methodology read — use `npx tpm doc claude-context/methodology/…` (or cite as `%TPM_HOME%/claude-context/methodology/…`)' },
  { re: /`methodology\//, why: 'bare methodology shorthand — use `npx tpm doc claude-context/methodology/…` (or cite as `%TPM_HOME%/claude-context/methodology/…`)' },
  { re: /\$\{TPM_HOME\}/, why: 'legacy shell-EXPANDING placeholder `${TPM_HOME}` — respell to the shell-inert `%TPM_HOME%` (both resolve, but `${…}` expands to empty on a command line)' },
];

// #24.9 — the ROUTER-IS-THE-API doctrine: skills + methodology are written as if the `.js`
// implementation files do NOT exist. The `npx tpm <suite> <verb>` router is the stable public API;
// `.js` scripts are implementation details a doc must never name, so we can move/rename/re-route them
// with zero doc churn. This rule FAILS on ANY bare `.js` file token. It guards `.json`/`.jsx` false
// positives via the negative lookahead (a following lowercase letter ⇒ not a bare `.js`).
const JS_TOKEN_RULE = {
  re: /\.js(?![a-z])/,
  why: 'bare `.js` file token — write as if the .js files do not exist: route an OPERATION through `npx tpm <suite> <verb>`, and REWORD any artifact/structural mention so it names the tool/module without the `.js` extension',
};

// The full rule set: relocatability (skills) + the universal no-`.js` doctrine. `--js-only` runs just
// the last one (used over the methodology tree, where the relocatability rules do not apply).
const RULES = [...RELOCATABILITY_RULES, JS_TOKEN_RULE];

function collectMdFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return target.endsWith('.md') ? [target] : [];
  const out = [];
  for (const entry of fs.readdirSync(target)) {
    out.push(...collectMdFiles(path.join(target, entry)));
  }
  return out;
}

function lintFile(file, rules = RULES) {
  const violations = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.re.test(line)) violations.push({ file, line: i + 1, text: line.trim(), why: rule.why });
    }
  });
  return violations;
}

function main(argv) {
  // `--js-only` restricts to the universal no-`.js` rule (for the methodology tree, where the
  // relocatability rules do not apply). Any other args are targets.
  const jsOnly = argv.includes('--js-only');
  const rules = jsOnly ? [JS_TOKEN_RULE] : RULES;
  const targets = argv.filter((a) => a !== '--js-only');
  if (targets.length === 0) targets.push(path.join('.claude', 'skills'));
  const files = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) { process.stderr.write(`lint-skill-refs: no such path: ${t}\n`); process.exit(2); }
    files.push(...collectMdFiles(t));
  }
  let all = [];
  for (const f of files) all = all.concat(lintFile(f, rules));
  if (all.length === 0) {
    process.stdout.write(`✓ skill refs clean — ${files.length} file(s): tools via \`npx tpm …\`, methodology via \`npx tpm doc …\`/%TPM_HOME%/, no legacy \${TPM_HOME}\n`);
    process.exit(0);
  }
  process.stdout.write(`✗ ${all.length} non-relocatable bundle ref(s) — route tools through \`npx tpm …\`, methodology through \`npx tpm doc …\`/%TPM_HOME%/, and respell any \${TPM_HOME} → %TPM_HOME%:\n`);
  for (const v of all) process.stdout.write(`  ${v.file}:${v.line}  ${v.why}\n      ${v.text}\n`);
  process.exit(1);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { lintFile, RULES, RELOCATABILITY_RULES, JS_TOKEN_RULE };
