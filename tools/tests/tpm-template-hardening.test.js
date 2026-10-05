#!/usr/bin/env node
'use strict';
/**
 * tests/tpm-template-hardening.test.js — invariant-focused tests for tools/lib/tpm-template.js, written to
 * BITE under mutation (#1155 test-writer round 1). Complements tpm-template.test.js (goldens + contract);
 * does not duplicate it. Each section names the mutation it exists to kill.
 *
 *   negation flip        `!flag` must invert (ON/OFF/nested/double-region)
 *   dropped stack pop    after `endif` the parent's state is restored (siblings, depth 3)
 *   non-literal raw      raw bodies are byte-exact, even when they look like every directive
 *   injected re-scan     slot text (string/array) is opaque: never opens/closes regions, never raw-toggles
 *   throw vs degrade     render NEVER throws; internal fault, bad config, hostile input => prose survives
 *   bad-inject           code, marker removed, lint ERROR severity
 *   unknown directive    byte-exact pass-through + warning (lint WARNING severity)
 *
 * HOW TO RUN
 *   node tools/tests/tpm-template-hardening.test.js   # exit 0 = all assertions green
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { render, scanTemplate, lint, resolveConfig } = require('../lib/tpm-template');

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
const codes = (r) => r.warnings.map((w) => w.code);
const R = (t, config, slots) => render(t, { config: config || {}, slots });
const IF = (f) => `<!-- tpm:if ${f} -->`;
const END = '<!-- tpm:endif -->';

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

process.stdout.write('tpm-template-hardening.test.js\n');

// ── negation ──
check('negation: !flag is the exact inverse for ON, OFF, "", 0, [] values', () => {
  const cfg = { on: true, off: false, s: '', n: 0, a: [], t: 'x' };
  for (const [f, expectKept] of [['on', true], ['!on', false], ['off', false], ['!off', true], ['s', false], ['!s', true],
    ['n', false], ['!n', true], ['a', false], ['!a', true], ['t', true], ['!t', false]]) {
    const r = R(`${IF(f)}\nBODY\n${END}\n`, cfg);
    assert.strictEqual(r.text, expectKept ? 'BODY\n' : '', `flag ${f}`);
  }
});
check('negation: if X + if !X pair renders exactly one body (the else-idiom)', () => {
  for (const v of [true, false]) {
    const r = R(`${IF('x')}\nYES\n${END}\n${IF('!x')}\nNO\n${END}\n`, { x: v });
    assert.strictEqual(r.text, v ? 'YES\n' : 'NO\n');
  }
});
check('negation: flags[] records negated + on consistently with the region outcome', () => {
  const r = R(`${IF('!off')}\nA\n${END}\n`, { off: false });
  assert.strictEqual(r.flags[0].negated, true); assert.strictEqual(r.flags[0].on, true); assert.strictEqual(r.text, 'A\n');
});
check('negation: unresolved path is OFF for BOTH x and !x (fail closed, not inverted)', () => {
  const r = R(`${IF('!nope.x')}\nA\n${END}\n${IF('nope.y')}\nB\n${END}\n`, {});
  assert.strictEqual(r.text, ''); assert.deepStrictEqual(codes(r), ['unresolved-flag', 'unresolved-flag']);
});

// ── stack pop ──
check('stack: text after a closed region is governed by the PARENT again (kept parent, dropped child)', () => {
  const t = `${IF('p')}\nP1\n${IF('c')}\nC\n${END}\nP2\n${END}\nTOP\n`;
  assert.strictEqual(R(t, { p: true, c: false }).text, 'P1\nP2\nTOP\n');
});
check('stack: text after a closed region is DROPPED when the parent is OFF (child ON must not resurrect it)', () => {
  const t = `${IF('p')}\nP1\n${IF('c')}\nC\n${END}\nP2\n${END}\nTOP\n`;
  assert.strictEqual(R(t, { p: false, c: true }).text, 'TOP\n');
});
check('stack: depth-3 nesting with sibling regions restores each level on pop', () => {
  const t = [IF('a'), 'a1', IF('b'), 'b1', IF('c'), 'c1', END, 'b2', END, 'a2', IF('d'), 'd1', END, 'a3', END, 'z'].join('\n') + '\n';
  assert.strictEqual(R(t, { a: true, b: true, c: false, d: true }).text, 'a1\nb1\nb2\na2\nd1\na3\nz\n');
  assert.strictEqual(R(t, { a: true, b: false, c: true, d: false }).text, 'a1\na2\na3\nz\n');
  assert.strictEqual(R(t, { a: false, b: true, c: true, d: true }).text, 'z\n');
});
check('stack: an extra endif after balanced regions is stray (stack really emptied), literal + stray-endif', () => {
  const r = R(`${IF('a')}\nx\n${END}\n${END}\ny\n`, { a: true });
  assert.deepStrictEqual(codes(r), ['stray-endif']); assert.strictEqual(r.text, `x\n${END}\ny\n`);
});
check('stack: N opens with N closes leaves zero unclosed-if; N opens with N-1 closes leaves exactly one', () => {
  const bal = R(`${IF('a')}\n${IF('a')}\n${IF('a')}\nx\n${END}\n${END}\n${END}\n`, { a: true });
  assert.deepStrictEqual(codes(bal), []);
  const un = R(`${IF('a')}\n${IF('a')}\nx\n${END}\n`, { a: true });
  assert.deepStrictEqual(codes(un), ['unclosed-if']);
});
check('stack: explain region endLine is the matching endif line (pop pairs the right region)', () => {
  const r = render(`${IF('a')}\n${IF('b')}\nx\n${END}\ny\n${END}\n`, { config: { a: true, b: true }, explain: true });
  const [outer, inner] = r.regions;
  assert.strictEqual(inner.endLine, 4); assert.strictEqual(outer.endLine, 6); assert.strictEqual(inner.depth, 1);
});

// ── raw ──
const DIRS = [IF('a'), IF('!a'), END, '<!-- tpm:inject s -->', '<!-- tpm:else -->', '<!-- tpm:raw -->', '  <!-- tpm:if a -->  ', 'x <!-- tpm:inline --> y'];
check('raw: every directive-looking line inside is emitted byte-exact (fences removed)', () => {
  const t = `before\n<!-- tpm:raw -->\n${DIRS.join('\n')}\n<!-- tpm:endraw -->\nafter\n`;
  const r = R(t, { a: false }, { s: 'SLOT' });
  assert.strictEqual(r.text, `before\n${DIRS.join('\n')}\nafter\n`);
  assert.deepStrictEqual(codes(r), []);
});
check('raw: no inject, no unresolved-flag, no flags[] entries from inside raw', () => {
  const r = R(`<!-- tpm:raw -->\n${IF('nope')}\n<!-- tpm:inject s -->\n<!-- tpm:endraw -->\n`, {}, { s: 'SLOT' });
  assert.ok(!r.text.includes('SLOT')); assert.strictEqual(r.flags.length, 0); assert.deepStrictEqual(codes(r), []);
});
check('raw: whitespace, tabs, blank lines and trailing spaces preserved exactly', () => {
  const body = '\t  indented  \n\n   \n  trailing   ';
  assert.strictEqual(R(`<!-- tpm:raw -->\n${body}\n<!-- tpm:endraw -->\n`).text, `${body}\n`);
});
check('raw inside an ON region is kept; inside an OFF region dropped whole; region after it unaffected', () => {
  const t = `${IF('a')}\n<!-- tpm:raw -->\n${IF('q')}\n<!-- tpm:endraw -->\n${END}\nz\n`;
  assert.strictEqual(R(t, { a: true }).text, `${IF('q')}\nz\n`);
  assert.strictEqual(R(t, { a: false }).text, 'z\n');
});
check('raw: scanTemplate/lint ignore everything inside (unbalanced/unknown-flag hidden), count raws', () => {
  const t = `<!-- tpm:raw -->\n${IF('zz.nope')}\n<!-- tpm:inject Bad_Name -->\n<!-- tpm:endraw -->\n`;
  const s = scanTemplate(t);
  assert.strictEqual(s.raws, 1); assert.deepStrictEqual(s.issues, []); assert.deepStrictEqual(s.flags, []); assert.deepStrictEqual(s.injects, []);
  assert.deepStrictEqual(lint(t, { defaults: {} }), []);
});

// ── injected text never re-scanned ──
const HOSTILE = `${IF('a')}\nINJECTED-A\n${END}\n<!-- tpm:raw -->\n<!-- tpm:inject other -->\n<!-- tpm:unknown x -->`;
check('inject: hostile slot text (if/endif/raw/inject/unknown) is emitted byte-exact, no warnings from it', () => {
  const r = R('top\n<!-- tpm:inject s -->\nbottom\n', { a: false }, { s: HOSTILE, other: 'NOPE' });
  assert.strictEqual(r.text, `top\n${HOSTILE}\nbottom\n`);
  assert.deepStrictEqual(codes(r), []); assert.strictEqual(r.flags.length, 0);
});
check('inject: a slot containing endif cannot close the OUTER region early (and no stray-endif)', () => {
  const t = `${IF('a')}\n<!-- tpm:inject s -->\nSTILL-INSIDE\n${END}\nOUT\n`;
  const r = R(t, { a: false }, { s: END });
  assert.strictEqual(r.text, 'OUT\n');
  const on = R(t, { a: true }, { s: END });
  assert.strictEqual(on.text, `${END}\nSTILL-INSIDE\nOUT\n`); assert.deepStrictEqual(codes(on), []);
});
check('inject: a slot containing `tpm:raw` does not swallow the rest of the template', () => {
  const r = R('<!-- tpm:inject s -->\n' + IF('a') + '\nA\n' + END + '\nB\n', { a: false }, { s: '<!-- tpm:raw -->' });
  assert.strictEqual(r.text, '<!-- tpm:raw -->\nB\n'); assert.deepStrictEqual(codes(r), []);
});
check('inject: array slots are joined and equally opaque; CRLF inside a slot is normalised only', () => {
  const r = R('<!-- tpm:inject s -->\n', { a: true }, { s: [IF('a'), 'x\r\ny', END] });
  assert.strictEqual(r.text, `${IF('a')}\nx\ny\n${END}\n`);
});
check('inject: a slot value equal to a template with a directive does not make render() non-idempotent for the template itself', () => {
  const a = R('<!-- tpm:inject s -->\n', {}, { s: IF('a') });
  const b = R('<!-- tpm:inject s -->\n', {}, { s: IF('a') });
  assert.deepStrictEqual(a, b);
});

// ── never throws: degrade, don't die ──
check('FAULT INJECTION: an internal scanner fault returns the template (+ banner), degraded:true, never throws', () => {
  const evil = { toString() { throw new Error('boom-in-slot'); } };
  const t = 'KEEP-ME\n<!-- tpm:inject s -->\nTAIL\n';
  let r; assert.doesNotThrow(() => { r = render(t, { config: {}, slots: { s: [evil] } }); });
  assert.strictEqual(r.degraded, true); assert.ok(/boom-in-slot/.test(r.degradedReason));
  assert.ok(r.text.includes('KEEP-ME') && r.text.includes('TAIL'), 'prose survives');
  assert.ok(/^> WARNING: tpm degraded config \(template engine fault/.test(r.text), 'banner leads');
  assert.ok(r.text.length > t.length - 1);
  const nb = render(t, { config: {}, slots: { s: [evil] }, banner: false });
  assert.strictEqual(nb.text, t); assert.strictEqual(nb.degraded, true);
});
check('FAULT INJECTION: Proxy slots whose get/has traps throw still do not throw', () => {
  const slots = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); }, get() { throw new Error('trap'); } });
  let r; assert.doesNotThrow(() => { r = render('a\n<!-- tpm:inject s -->\nb\n', { config: {}, slots }); });
  assert.ok(r.text.includes('a') && r.text.includes('b'));
});
check('degrade: resolveConfig on a corrupt project + unreadable defaults returns (never throws) an empty-fallback result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpmh-'));
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'claude-tpm', 'config.json'), '{ nope');
  const env = Object.assign({}, process.env, { CLAUDE_TPM_USER_CONFIG: '' });
  let rc; assert.doesNotThrow(() => { rc = withEnv({ TPM_DEFAULTS_FILE: path.join(root, 'missing.json') }, () => resolveConfig({ projectRoot: root, env })); });
  assert.strictEqual(rc.degraded, true); assert.strictEqual(rc.fallback, 'empty'); assert.deepStrictEqual(rc.config, {});
});
check('degrade: corrupt project + readable defaults => never throws, fallback "defaults", banner names shipped defaults, defaults drive regions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpmh-'));
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'claude-tpm', 'config.json'), '{ nope');
  const env = Object.assign({}, process.env, { CLAUDE_TPM_USER_CONFIG: '' });
  let rc; assert.doesNotThrow(() => { rc = resolveConfig({ projectRoot: root, env }); });
  assert.strictEqual(rc.degraded, true); assert.strictEqual(rc.fallback, 'defaults');
  assert.ok(rc.config.session && typeof rc.config.session === 'object', 'defaults content returned');
  let r; assert.doesNotThrow(() => { r = render(`${IF('session.enabled')}\nON\n${END}\nSTAY\n`, { projectRoot: root, env }); });
  assert.ok(/rendered with shipped defaults\./.test(r.text) && r.text.includes('STAY'), r.text);
  assert.ok(r.text.includes('ON\n'), 'defaults (session.enabled true) still drive the region');
});
check('degrade: render with corrupt project config => banner first, unconditional prose kept, never empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpmh-'));
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'claude-tpm', 'config.json'), '{ nope');
  const env = Object.assign({}, process.env, { CLAUDE_TPM_USER_CONFIG: '' });
  const r = render('PROSE-LINE\n', { projectRoot: root, env });
  assert.strictEqual(r.degraded, true);
  assert.ok(r.text.startsWith('> WARNING: tpm degraded config (') && r.text.endsWith('\n\nPROSE-LINE\n'), r.text);
  assert.strictEqual(r.text.split('WARNING: tpm degraded config').length, 2, 'exactly one banner');
});
check('never throws: 400 randomized token soups (broken nesting, raw, inject, junk, CR/LF)', () => {
  const toks = [IF('a'), IF('!a'), IF('a b'), IF(''), '<!-- tpm:if -->', END, '<!-- tpm:raw -->', '<!-- tpm:endraw -->', '<!-- tpm:inject s -->',
    '<!-- tpm:inject -->', '<!-- tpm:zzz -->', 'plain', '', '<!--', '-->', 'tpm:if a', 'x <!-- tpm:if a --> y', '\r', '\u0000'];
  let seed = 1337; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 400; i += 1) {
    const lines = Array.from({ length: 1 + rnd(14) }, () => toks[rnd(toks.length)]);
    const t = lines.join(rnd(2) ? '\n' : '\r\n');
    let r; assert.doesNotThrow(() => { r = render(t, { config: { a: rnd(2) === 1 }, slots: { s: 'S' } }); }, JSON.stringify(t));
    assert.strictEqual(typeof r.text, 'string');
    assert.doesNotThrow(() => { scanTemplate(t); lint(t, { defaults: {} }); }, JSON.stringify(t));
    if (!/tpm:/.test(t) && t.trim()) assert.ok(r.text.length > 0, 'directive-free input is never emptied');
  }
});
check('never throws on junk opts: config array/number/null, slots null/array, nonsense banner', () => {
  for (const o of [{ config: [] }, { config: 5 }, { config: null, projectRoot: os.tmpdir() }, { config: {}, slots: null }, { config: {}, slots: [] }, { config: {}, banner: 'x' }]) {
    let r; assert.doesNotThrow(() => { r = render(`${IF('a')}\nx\n${END}\nstay\n<!-- tpm:inject s -->\n`, o); }, JSON.stringify(o));
    assert.ok(r.text.includes('stay'));
  }
});
check('only a non-string template throws, and it is a TypeError', () => {
  for (const bad of [undefined, null, 5, {}, []]) assert.throws(() => render(bad), TypeError);
});

// ── bad-inject ──
check('bad-inject: missing / uppercase / underscore / spaced names => marker removed + bad-inject (once each)', () => {
  for (const marker of ['<!-- tpm:inject -->', '<!-- tpm:inject Bad -->', '<!-- tpm:inject a_b -->', '<!-- tpm:inject a b -->', '<!-- tpm:inject 9x -->']) {
    const r = R(`keep\n${marker}\nkeep2\n`, {}, { Bad: 'LEAK', a_b: 'LEAK', 'a b': 'LEAK', '9x': 'LEAK' });
    assert.strictEqual(r.text, 'keep\nkeep2\n', marker); assert.deepStrictEqual(codes(r), ['bad-inject'], marker);
  }
});
check('bad-inject: lint reports it as an ERROR with the right line; scanTemplate does not list it as an inject', () => {
  const t = 'a\n<!-- tpm:inject Bad_Name -->\nb\n';
  const issues = lint(t, { defaults: {} });
  assert.deepStrictEqual(issues.map((i) => [i.code, i.line, i.severity]), [['bad-inject', 2, 'error']]);
  assert.deepStrictEqual(scanTemplate(t).injects, []);
});
check('bad-inject is registered in WARNING_CODES; a valid inject emits no bad-inject', () => {
  assert.ok(require('../lib/tpm-template').WARNING_CODES.includes('bad-inject'));
  assert.deepStrictEqual(codes(R('<!-- tpm:inject ok-1 -->\n', {}, { 'ok-1': 'v' })), []);
});

// ── unknown directives ──
check('unknown directive: byte-exact pass-through (indent + args kept) + warning with line number', () => {
  const lines = ['<!-- tpm:else -->', '   <!-- tpm:elif a -->', '<!-- tpm:include foo.md -->', '<!-- tpm:IF a -->'.replace('IF', 'future-thing')];
  const r = R(`x\n${lines.join('\n')}\ny\n`, {});
  assert.strictEqual(r.text, `x\n${lines.join('\n')}\ny\n`);
  assert.deepStrictEqual(r.warnings.map((w) => [w.code, w.line]), [['unknown-directive', 2], ['unknown-directive', 3], ['unknown-directive', 4], ['unknown-directive', 5]]);
});
check('unknown directive: kept inside ON regions, dropped with OFF regions, literal inside raw (no warning)', () => {
  const t = `${IF('a')}\n<!-- tpm:else -->\n${END}\n`;
  assert.strictEqual(R(t, { a: true }).text, '<!-- tpm:else -->\n');
  assert.strictEqual(R(t, { a: false }).text, '');
  assert.deepStrictEqual(codes(R('<!-- tpm:raw -->\n<!-- tpm:else -->\n<!-- tpm:endraw -->\n')), []);
});
check('unknown directive: lint WARNING (not error); vocabulary words else/elif are NOT directives', () => {
  const issues = lint('<!-- tpm:else -->\n', { defaults: {} });
  assert.deepStrictEqual(issues.map((i) => [i.code, i.severity]), [['unknown-directive', 'warning']]);
  assert.ok(!require('../lib/tpm-template').DIRECTIVES.includes('else'));
});

process.stdout.write(`PASS ${count} checks\n`);
