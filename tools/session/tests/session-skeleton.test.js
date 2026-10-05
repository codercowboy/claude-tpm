'use strict';
/**
 * session-skeleton.test.js — the skeletonized .claude/skills/tpm-session/SKILL.md (#1155): tiny, description
 * byte-pinned, bare `tpm`, fallback-primary, NO broad allowed-tools pre-auth; and content parity: the composed
 * open/save/close keep every load-bearing phrase of the retired SKILL.md / modes-open.md / modes-close.md.
 *
 * Run: node tests/session-skeleton.test.js
 */
const { assert, test, done, fs, path } = require('./helpers/harness');
const BUNDLE = path.join(__dirname, '..', '..', '..');
const SKILL = path.join(BUNDLE, '.claude', 'skills', 'tpm-session', 'SKILL.md');
const text = fs.readFileSync(SKILL, 'utf8');
const c = require('../tpm-session-compose');
const overlay = require('../../lib/tpm-config-overlay');

const DESCRIPTION = 'Use at the start of a session to boot (open), to checkpoint / write session notes mid-session (save), to wrap up (close), or to check current session status (info). Bare "tpm-session" is state-aware — not yet opened this session -> open; already open -> save. Supersedes the retired session-open / session-close skills. Invoke ONLY when the user explicitly runs it (this is the orchestrator\'s boot) — never auto-invoke it, because a subagent must never adopt the orchestrator role by tripping this on its own.';

test('SKILL.md is a skeleton (<= 25 lines) and the retired mode bodies are gone', () => {
  assert.ok(text.split('\n').length <= 25, `${text.split('\n').length} lines`);
  assert.ok(!fs.existsSync(path.join(path.dirname(SKILL), 'modes-open.md')));
  assert.ok(!fs.existsSync(path.join(path.dirname(SKILL), 'modes-close.md')));
});
test('frontmatter description is byte-identical to the pre-change one; name unchanged', () => {
  const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter shape');
  assert.strictEqual(m[1], 'tpm-session');
  assert.strictEqual(m[2], DESCRIPTION);
});
test('NO broad allowed-tools pre-auth in the skeleton', () => {
  assert.ok(!/allowed-tools/i.test(text));
});
test('bare `tpm` only; PRIMARY path is the run-it-yourself compose command; best-effort !-pre-inject is the SAME command', () => {
  assert.ok(!/npx tpm/.test(text));
  const primary = text.indexOf('Primary path');
  const bang = text.indexOf('!`tpm session compose');
  assert.ok(primary > 0 && bang > primary, 'primary path precedes the best-effort pre-inject');
  assert.ok(/best-effort/i.test(text) && /tpm session compose --mode/.test(text));
  assert.ok(/\$ARGUMENTS/.test(text));
});
test('every tpm session verb named in the skeleton is a real router verb', () => {
  const { VERBS } = require('../tpm-session-router');
  for (const m of text.matchAll(/tpm session ([a-z-]+)/g)) assert.ok(VERBS[m[1]], m[1]);
});

const CFG = () => overlay.loadDefaults();
const comp = (m) => c.compose(m, { config: CFG(), projectRoot: path.join(BUNDLE, 'tmp-no-such'), pickup: 'P', sessionsDir: '/nonexistent', env: {} }).text;
const PARITY = {
  open: ['tpm session current --open', 'tpm reading-list orchestrator', 'tpm resolve-home', 'tpm doc', 'boot-read', 'tpm session config --json',
    '--modules', 'ORCHESTRATOR', 'tpm-reap', 'tpm-workflow', 'tpm-task', 'Print the footer', 'subagent must never'],
  save: ['tpm session current --state', 'punchlist', '--action close', '--action add', '--decision --what', '--log --status', 'import-handoff',
    '--json-file', '--txt-file', 'exit 1', 'tpm session save', 'REPLACES the handoff', 'never spawn a new session number', 'Footer'],
  close: ['/tpm-reap', 'NEVER auto-kills', 'import-handoff', 'tpm session close', 'REFUSES', 'current --seal', '/export', 'Terse sign-off',
    'NOT the skill menu', 'subagent must never run this skill', 'Footer'],
  info: ['tpm session current --state', 'session-NNNN.json', 'CLAUDE_CODE_SESSION_ID', 'Total session count'],
};
for (const [mode, needles] of Object.entries(PARITY)) {
  test(`parity: composed ${mode} keeps every load-bearing phrase of the old body`, () => {
    const t = comp(mode);
    for (const n of needles) assert.ok(t.includes(n), `${mode}: missing "${n}"`);
  });
}
test('token win: each composed mode is far smaller than the old SKILL.md + modes bodies (158+92+61 lines)', () => {
  const sizes = Object.fromEntries(['open', 'save', 'close', 'info'].map((m) => [m, comp(m).length]));
  assert.ok(sizes.open < 9000 && sizes.save < 9000 && sizes.close < 9000 && sizes.info < 1500, JSON.stringify(sizes));
});

done('session-skeleton.test');
