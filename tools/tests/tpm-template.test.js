#!/usr/bin/env node
'use strict';
/**
 * tests/tpm-template.test.js — golden-file + behavior tests for the skill template engine
 * (tools/lib/tpm-template.js).
 *
 * PURPOSE
 *   Golden triples under tests/fixtures/template/<name>.{md,config.json,expected.md[,slots.json]}:
 *   template + config fixture -> byte-exact expected output. Then the contract rows: warning codes, fail-safe
 *   degradation, purity (no writes / no mutation / idempotent), injection-safety, lint, the truthiness table.
 *
 * HOW TO RUN
 *   node tools/tests/tpm-template.test.js   # exit 0 = all assertions green
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'template');
const T = require('../lib/tpm-template');
const { render, resolveConfig, scanTemplate, lint } = T;

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
const codes = (r) => r.warnings.map((w) => w.code);
const cfg = (o) => ({ config: o });
const IF = (flag, body) => `<!-- tpm:if ${flag} -->\n${body}\n<!-- tpm:endif -->\n`;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

process.stdout.write('tpm-template.test.js\n');

// ── 1. GOLDEN FILES ──
const goldens = fs.readdirSync(FIX).filter((f) => f.endsWith('.expected.md')).map((f) => f.replace(/\.expected\.md$/, '')).sort();
check('golden fixture set is present (>= 9 triples)', () => assert.ok(goldens.length >= 9, goldens.join(',')));
for (const name of goldens) {
  check(`golden: ${name}`, () => {
    const tpl = fs.readFileSync(path.join(FIX, `${name}.md`), 'utf8');
    const config = JSON.parse(fs.readFileSync(path.join(FIX, `${name}.config.json`), 'utf8'));
    const sp = path.join(FIX, `${name}.slots.json`);
    const slots = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {};
    const expected = fs.readFileSync(path.join(FIX, `${name}.expected.md`), 'utf8');
    const r = render(tpl, { config, slots });
    assert.strictEqual(r.text, expected);
    assert.strictEqual(r.degraded, false);
  });
}

// ── 2. if / endif / ! ──
check('if ON keeps, OFF drops; ! inverts', () => {
  assert.strictEqual(render(IF('a', 'X'), cfg({ a: true })).text, 'X\n');
  assert.strictEqual(render(IF('a', 'X'), cfg({ a: false })).text, '');
  assert.strictEqual(render(IF('!a', 'X'), cfg({ a: false })).text, 'X\n');
  assert.strictEqual(render(IF('!a', 'X'), cfg({ a: true })).text, '');
});
check('directive lines are removed (no blank-line artifacts)', () => {
  assert.strictEqual(render('a\n<!-- tpm:if x -->\nb\n<!-- tpm:endif -->\nc\n', cfg({ x: true })).text, 'a\nb\nc\n');
  assert.strictEqual(render('a\n<!-- tpm:if x -->\nb\n<!-- tpm:endif -->\nc\n', cfg({ x: false })).text, 'a\nc\n');
});
check('indented directive lines are recognised; spacing variants parse', () => {
  assert.strictEqual(render('  <!--tpm:if x-->\nb\n\t<!--   tpm:endif   -->\n', cfg({ x: true })).text, 'b\n');
});
check('unresolved flag => OFF for both x and !x, with unresolved-flag warning', () => {
  const a = render(IF('nope', 'X'), cfg({}));
  const b = render(IF('!nope', 'X'), cfg({}));
  assert.strictEqual(a.text, ''); assert.strictEqual(b.text, '');
  assert.deepStrictEqual(codes(a), ['unresolved-flag']); assert.deepStrictEqual(codes(b), ['unresolved-flag']);
  assert.strictEqual(a.flags[0].resolved, false); assert.strictEqual(a.flags[0].on, false);
});
check('flags[] records every reference with value/on', () => {
  const r = render(IF('a.b', 'X') + IF('!a.c', 'Y'), cfg({ a: { b: 1, c: 0 } }));
  assert.deepStrictEqual(r.flags.map((f) => [f.flag, f.negated, f.resolved, f.value, f.on]), [['a.b', false, true, 1, true], ['a.c', true, true, 0, true]]);
});
check('truthiness table', () => {
  const on = [true, 'x', 1, -2, [1], { k: 1 }];
  const off = [false, null, '', 0, [], {}];
  for (const v of on) assert.strictEqual(render(IF('v', 'X'), cfg({ v })).text, 'X\n', JSON.stringify(v));
  for (const v of off) assert.strictEqual(render(IF('v', 'X'), cfg({ v })).text, '', JSON.stringify(v));
  assert.strictEqual(T.truthy(NaN), false); assert.strictEqual(T.truthy(Infinity), false);
});
check('nesting: parent OFF kills a child whose flag is ON; reasons recorded', () => {
  const t = '<!-- tpm:if p -->\n<!-- tpm:if c -->\nX\n<!-- tpm:endif -->\n<!-- tpm:endif -->\n';
  assert.strictEqual(render(t, cfg({ p: false, c: true })).text, '');
  const r = render(t, { config: { p: false, c: true }, explain: true });
  assert.deepStrictEqual(r.regions.map((g) => [g.kind, g.kept, g.reason, g.depth]), [['if', false, 'flag-off', 0], ['if', false, 'parent-off', 1]]);
});

// ── 3. structural errors never throw / never drop prose ──
check('stray endif -> literal + stray-endif', () => {
  const r = render('a\n<!-- tpm:endif -->\nb\n', cfg({}));
  assert.strictEqual(r.text, 'a\n<!-- tpm:endif -->\nb\n'); assert.deepStrictEqual(codes(r), ['stray-endif']);
});
check('unclosed if at EOF -> closed at EOF, kept/dropped per flag, + unclosed-if', () => {
  const t = 'a\n<!-- tpm:if x -->\nb\n';
  const on = render(t, cfg({ x: true })); const off = render(t, cfg({ x: false }));
  assert.strictEqual(on.text, 'a\nb\n'); assert.strictEqual(off.text, 'a\n');
  assert.ok(codes(on).includes('unclosed-if'));
});
check('bad-if: expressions / empty / missing -> region OFF + bad-if, never throws', () => {
  for (const bad of ['a==b', 'a && b', 'a || b', '!', '!!a', 'a b', '']) {
    const t = `keep\n<!-- tpm:if ${bad} -->\nX\n<!-- tpm:endif -->\n`;
    const r = render(t, cfg({ a: true, b: true }));
    assert.strictEqual(r.text, 'keep\n', bad);
    assert.ok(codes(r).includes('bad-if'), bad);
  }
});
check('bad-flag: [+] and non-path -> OFF + bad-flag', () => {
  for (const bad of ['a[+]', 'a..b', '.a', '1x']) {
    const r = render(`<!-- tpm:if ${bad} -->\nX\n<!-- tpm:endif -->\n`, cfg({ a: true }));
    assert.strictEqual(r.text, '', bad);
    assert.ok(codes(r).includes('bad-flag'), bad);
  }
});
check('hostile inputs never throw', () => {
  const nasty = ['', '\0\0<!-- tpm:', '<!-- tpm:if', '<!-- tpm:if a -->'.repeat(500), '<!-- tpm:endif -->\n'.repeat(50), ' '.repeat(100000) + '<!-- tpm:if x -->', '<!-- tpm:raw -->', '<!-- tpm:inject -->', '<!-- tpm:if __proto__.x -->\n<!-- tpm:endif -->'];
  for (const n of nasty) { const r = render(n, cfg({})); assert.strictEqual(typeof r.text, 'string'); }
});

// ── 4. raw / unknown / inline ──
check('raw passes literally and fence lines are removed', () => {
  const r = render('<!-- tpm:raw -->\n<!-- tpm:if x -->\n<!-- tpm:endraw -->\nz\n', cfg({ x: false }));
  assert.strictEqual(r.text, '<!-- tpm:if x -->\nz\n'); assert.deepStrictEqual(codes(r), []);
});
check('unterminated raw -> rest literal + unterminated-raw', () => {
  const r = render('a\n<!-- tpm:raw -->\n<!-- tpm:if x -->\nb\n', cfg({ x: false }));
  assert.strictEqual(r.text, 'a\n<!-- tpm:if x -->\nb\n'); assert.deepStrictEqual(codes(r), ['unterminated-raw']);
});
check('stray endraw -> literal + stray-endraw', () => {
  const r = render('a\n<!-- tpm:endraw -->\n', cfg({}));
  assert.strictEqual(r.text, 'a\n<!-- tpm:endraw -->\n'); assert.deepStrictEqual(codes(r), ['stray-endraw']);
});
check('raw is not nestable: second raw inside is literal', () => {
  const r = render('<!-- tpm:raw -->\n<!-- tpm:raw -->\nx\n<!-- tpm:endraw -->\ny\n', cfg({}));
  assert.strictEqual(r.text, '<!-- tpm:raw -->\nx\ny\n');
});
check('unknown tpm:* passes through verbatim + unknown-directive (also: else/elif are NOT directives)', () => {
  const r = render('<!-- tpm:frobnicate a b -->\n<!-- tpm:else -->\n', cfg({}));
  assert.strictEqual(r.text, '<!-- tpm:frobnicate a b -->\n<!-- tpm:else -->\n');
  assert.deepStrictEqual(codes(r), ['unknown-directive', 'unknown-directive']);
});
check('inline tpm: comment is literal + inline-directive', () => {
  const r = render('see <!-- tpm:if x --> here\n', cfg({ x: false }));
  assert.strictEqual(r.text, 'see <!-- tpm:if x --> here\n'); assert.deepStrictEqual(codes(r), ['inline-directive']);
});
check('unknown directive inside OFF region is dropped with the region', () => {
  assert.strictEqual(render('<!-- tpm:if x -->\n<!-- tpm:frob -->\n<!-- tpm:endif -->\n', cfg({ x: false })).text, '');
});

// ── 5. inject ──
check('inject: filled / empty (silent) / unknown (warn) / array / OFF-region', () => {
  const t = 'a\n<!-- tpm:inject s -->\nb\n';
  assert.strictEqual(render(t, { config: {}, slots: { s: 'X' } }).text, 'a\nX\nb\n');
  const e = render(t, { config: {}, slots: { s: '' } });
  assert.strictEqual(e.text, 'a\nb\n'); assert.deepStrictEqual(codes(e), []);
  assert.strictEqual(render(t, { config: {}, slots: { s: [] } }).text, 'a\nb\n');
  const u = render(t, { config: {}, slots: {} });
  assert.strictEqual(u.text, 'a\nb\n'); assert.deepStrictEqual(codes(u), ['unknown-slot']);
  assert.strictEqual(render(t, { config: {}, slots: { s: ['p', 'q'] } }).text, 'a\np\nq\nb\n');
  assert.strictEqual(render(IF('x', '<!-- tpm:inject s -->'), { config: { x: false }, slots: { s: 'X' } }).text, '');
});
check('injected text is NEVER re-scanned (injection-safety)', () => {
  const slot = '<!-- tpm:if gone -->\nsecret\n<!-- tpm:endif -->\n<!-- tpm:raw -->\n<!-- tpm:inject s -->';
  const r = render('<!-- tpm:inject s -->\n', { config: { gone: false }, slots: { s: slot } });
  assert.strictEqual(r.text, `${slot}\n`); assert.deepStrictEqual(codes(r), []);
});
check('bad-inject: missing/invalid name -> marker removed + bad-inject', () => {
  const r = render('a\n<!-- tpm:inject -->\n<!-- tpm:inject Bad_Name -->\nb\n', cfg({}));
  assert.strictEqual(r.text, 'a\nb\n'); assert.deepStrictEqual(codes(r), ['bad-inject', 'bad-inject']);
});
check('slots lookup ignores prototype keys (constructor is not a slot)', () => {
  const r = render('<!-- tpm:inject constructor -->\n', { config: {}, slots: {} });
  assert.deepStrictEqual(codes(r), ['unknown-slot']);
});

// ── 6. explain regions ──
check('explain fills regions with kept/dropped + driving flag; absent otherwise', () => {
  const t = '<!-- tpm:if a -->\nx\n<!-- tpm:endif -->\n<!-- tpm:inject s -->\n<!-- tpm:raw -->\nr\n<!-- tpm:endraw -->\n';
  assert.deepStrictEqual(render(t, cfg({ a: true })).regions, []);
  const r = render(t, { config: { a: false }, slots: { s: 'S' }, explain: true });
  assert.deepStrictEqual(r.regions.map((g) => [g.id, g.kind, g.flag, g.kept, g.reason, g.startLine, g.endLine]),
    [[1, 'if', 'a', false, 'flag-off', 1, 3], [2, 'inject', null, true, 'filled', 4, 4], [3, 'raw', null, true, 'filled', 5, 7]]);
});

// ── 7. PURE / idempotent ──
check('same inputs twice => deep-equal; frozen config/slots are not mutated', () => {
  const t = '<!-- tpm:if a.b -->\n<!-- tpm:inject s -->\n<!-- tpm:endif -->\nz\n';
  const o = { config: deepFreeze({ a: { b: true } }), slots: deepFreeze({ s: deepFreeze(['p', 'q']) }), explain: true };
  assert.deepStrictEqual(render(t, o), render(t, o));
});
check('render(render(t).text) is stable for plain templates', () => {
  const t = 'a\n<!-- tpm:if x -->\nb\n<!-- tpm:endif -->\n<!-- tpm:inject s -->\nc\n';
  const once = render(t, { config: { x: true }, slots: { s: 'S' } }).text;
  assert.strictEqual(render(once, cfg({ x: true })).text, once);
});
check('zero side effects: no stdout/stderr/fs writes, env + cwd untouched', () => {
  const ow = process.stdout.write; const ew = process.stderr.write; const wf = fs.writeFileSync; const af = fs.appendFileSync;
  const cwd = process.cwd(); const envBefore = JSON.stringify(process.env);
  let writes = 0;
  const count1 = () => { writes += 1; return true; };
  process.stdout.write = count1; process.stderr.write = count1; fs.writeFileSync = count1; fs.appendFileSync = count1;
  try {
    render('<!-- tpm:if a -->\nx\n<!-- tpm:endif -->\n<!-- tpm:frob -->\n', { config: { a: true }, explain: true });
    render('x\n', { config: null, projectRoot: os.tmpdir(), env: { CLAUDE_TPM_USER_CONFIG: undefined } });
  } finally { process.stdout.write = ow; process.stderr.write = ew; fs.writeFileSync = wf; fs.appendFileSync = af; }
  assert.strictEqual(writes, 0); assert.strictEqual(process.cwd(), cwd); assert.strictEqual(JSON.stringify(process.env), envBefore);
});
check('non-string template => TypeError; empty => empty text, no banner', () => {
  assert.throws(() => render(undefined), TypeError); assert.throws(() => render(5), TypeError);
  const r = withEnv({ TPM_DEFAULTS_FILE: '/nonexistent/defaults.json' }, () => render('', { projectRoot: os.tmpdir() }));
  assert.strictEqual(r.text, '');
});
check('CRLF/CR input normalised to LF', () => {
  assert.strictEqual(render('a\r\nb\rc\r\n', cfg({})).text, 'a\nb\nc\n');
});

// ── 8. FAIL-SAFE ──
function mkProject(configText) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-tpl-'));
  fs.mkdirSync(path.join(d, '.claude', 'claude-tpm'), { recursive: true });
  if (configText !== undefined) fs.writeFileSync(path.join(d, '.claude', 'claude-tpm', 'config.json'), configText);
  return d;
}
const BODY = 'always\n<!-- tpm:if tasks.enabled -->\ntasks\n<!-- tpm:endif -->\n';
check('resolveConfig: clean project => degraded:false with merged defaults', () => {
  const p = mkProject('{ "tasks": { "enabled": false } }');
  const r = withEnv({ CLAUDE_TPM_USER_CONFIG: undefined }, () => resolveConfig({ projectRoot: p }));
  assert.strictEqual(r.degraded, false); assert.strictEqual(r.config.tasks.enabled, false); assert.ok(r.config.session);
});
check('bad project config.json => degraded, fallback defaults, banner, body non-empty', () => {
  const p = mkProject('{ not json');
  const r = withEnv({ CLAUDE_TPM_USER_CONFIG: undefined }, () => render(BODY, { projectRoot: p }));
  assert.strictEqual(r.degraded, true); assert.ok(r.degradedReason);
  assert.ok(r.text.startsWith('> WARNING: tpm degraded config ('), r.text);
  assert.ok(/rendered with shipped defaults\. Run `tpm doctor` to diagnose\.\n\nalways\n/.test(r.text), r.text);
  assert.ok(!/npx tpm/.test(r.text)); assert.ok(r.text.includes('tasks\n'), 'defaults still drive the regions');
});
check('defaults file missing => fallback empty: banner + unconditional text, conditionals OFF', () => {
  const p = mkProject();
  const rc = withEnv({ TPM_DEFAULTS_FILE: '/nonexistent/defaults.json' }, () => resolveConfig({ projectRoot: p }));
  assert.strictEqual(rc.degraded, true); assert.strictEqual(rc.fallback, 'empty'); assert.deepStrictEqual(rc.config, {});
  const r = withEnv({ TPM_DEFAULTS_FILE: '/nonexistent/defaults.json' }, () => render(BODY, { projectRoot: p }));
  assert.ok(/rendered with no config/.test(r.text)); assert.ok(r.text.endsWith('always\n')); assert.ok(!r.text.includes('tasks\n'));
});
check('all-conditional template + failed config => banner alone (never empty)', () => {
  const r = withEnv({ TPM_DEFAULTS_FILE: '/nonexistent/defaults.json' }, () => render(IF('x', 'X'), { projectRoot: mkProject() }));
  assert.ok(r.text.startsWith('> WARNING:')); assert.ok(r.text.length > 20);
});
check('banner:false suppresses the banner but not the degraded flag', () => {
  const r = withEnv({ TPM_DEFAULTS_FILE: '/nonexistent/defaults.json' }, () => render(BODY, { projectRoot: mkProject(), banner: false }));
  assert.strictEqual(r.degraded, true); assert.strictEqual(r.text, 'always\n');
});
check('bad USER layer is NOT degraded (overlay warn-and-skip)', () => {
  const p = mkProject('{ "tasks": { "enabled": true } }');
  const u = path.join(p, 'user.json'); fs.writeFileSync(u, '{ broken');
  const ew = process.stderr.write; process.stderr.write = () => true; // the overlay's own warning; swallow here
  let r;
  try { r = render(BODY, { projectRoot: p, env: { CLAUDE_TPM_USER_CONFIG: u } }); } finally { process.stderr.write = ew; }
  assert.strictEqual(r.degraded, false); assert.ok(!r.text.includes('WARNING'));
});
check('user layer overrides project (flags resolve through the overlay)', () => {
  const p = mkProject('{ "tasks": { "enabled": true } }');
  const u = path.join(p, 'user.json'); fs.writeFileSync(u, '{ "tasks": { "enabled": false } }');
  const r = render(BODY, { projectRoot: p, env: { CLAUDE_TPM_USER_CONFIG: u } });
  assert.strictEqual(r.text, 'always\n');
});
check('non-object opts.config degrades to empty with banner', () => {
  const r = render(BODY, { config: [1] });
  assert.strictEqual(r.degraded, true); assert.ok(r.text.startsWith('> WARNING:'));
});

// ── 9. scanTemplate / lint ──
check('scanTemplate: flags, injects, raws; raw-aware; no config needed', () => {
  const s = scanTemplate('<!-- tpm:if a.b -->\n<!-- tpm:inject p -->\n<!-- tpm:endif -->\n<!-- tpm:raw -->\n<!-- tpm:if hidden -->\n<!-- tpm:endraw -->\n<!-- tpm:if !c -->\n<!-- tpm:endif -->\n');
  assert.deepStrictEqual(s.flags.map((f) => [f.flag, f.negated, f.line]), [['a.b', false, 1], ['c', true, 7]]);
  assert.deepStrictEqual(s.injects, ['p']); assert.strictEqual(s.raws, 1); assert.deepStrictEqual(s.issues, []);
});
check('lint: unbalanced if/endif, unknown-flag vs defaults, severities', () => {
  const defaults = { tasks: { enabled: true } };
  const iss = lint('<!-- tpm:if tasks.enabled -->\n<!-- tpm:if made.up -->\n<!-- tpm:endif -->\n<!-- tpm:endif -->\n<!-- tpm:endif -->\n<!-- tpm:if tasks.enabled -->\n', { defaults });
  assert.deepStrictEqual(iss.map((i) => [i.code, i.line, i.severity]), [['unknown-flag', 2, 'error'], ['stray-endif', 5, 'error'], ['unclosed-if', 6, 'error']]);
});
check('lint: clean template => []; unknown-directive/inline are warnings only; raw hides errors', () => {
  const defaults = { a: true };
  assert.deepStrictEqual(lint('<!-- tpm:if a -->\nx\n<!-- tpm:endif -->\n', { defaults }), []);
  const w = lint('<!-- tpm:frob -->\nx <!-- tpm:if a --> y\n', { defaults });
  assert.deepStrictEqual(w.map((i) => [i.code, i.severity]), [['unknown-directive', 'warning'], ['inline-directive', 'warning']]);
  assert.deepStrictEqual(lint('<!-- tpm:raw -->\n<!-- tpm:if nope -->\n<!-- tpm:endif -->\n<!-- tpm:endif -->\n<!-- tpm:endraw -->\n', { defaults }), []);
  assert.ok(lint('<!-- tpm:raw -->\nx\n', { defaults }).some((i) => i.code === 'unterminated-raw' && i.severity === 'error'));
  assert.ok(lint('<!-- tpm:if a == b -->\n<!-- tpm:endif -->\n', { defaults }).some((i) => i.code === 'bad-if'));
  assert.ok(lint('<!-- tpm:if a[+] -->\n<!-- tpm:endif -->\n', { defaults }).some((i) => i.code === 'bad-flag'));
});
check('lint against the real shipped defaults.json: known flag ok, bogus flagged', () => {
  assert.deepStrictEqual(lint('<!-- tpm:if tasks.enabled -->\n<!-- tpm:endif -->\n'), []);
  assert.deepStrictEqual(lint('<!-- tpm:if tasks.bogus -->\n<!-- tpm:endif -->\n').map((i) => i.code), ['unknown-flag']);
});

// ── 10. frozen vocabulary + codes ──
check('vocabulary is frozen: DIRECTIVES, VOCAB_VERSION, WARNING_CODES', () => {
  assert.deepStrictEqual([...T.DIRECTIVES], ['if', 'endif', 'inject', 'raw', 'endraw']);
  assert.ok(Object.isFrozen(T.DIRECTIVES)); assert.strictEqual(T.VOCAB_VERSION, 1);
  for (const c of ['unknown-directive', 'inline-directive', 'unresolved-flag', 'unknown-slot', 'unterminated-raw', 'stray-endraw', 'stray-endif', 'unclosed-if', 'bad-if', 'bad-flag', 'unknown-flag']) assert.ok(T.WARNING_CODES.includes(c), c);
});

process.stdout.write(`\ntpm-template.test.js: ${count} checks passed\n`);
