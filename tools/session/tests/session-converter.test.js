'use strict';
/**
 * session-converter.test.js — unit + golden + wiring tests for the PURE JSON→human converter
 * (P04). Verifies the LOCKED `export-spec.md` render rules: header banner, Handoff → Punchlist →
 * Log ordering, null-handoff placeholder, punchlist age (Q1) + carried marker + struck-through
 * done, and the four log entry shapes (single-line, multi-line, decision, plain). Plus purity
 * (no mutation / deterministic) and the saveSession injection wiring.
 *
 * Run: node session-tooling/tests/session-converter.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const { assert, test, done, tmpDir, fs, path, throwsMatching } = require('./helpers/harness');
const { render, _ageOf, _renderLogEntry, _abbrevId } = require('../lib/session-converter');
const { loadSession, saveSession } = require('../lib/session-model');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const FIXTURE = path.join(GOLDEN_DIR, 'session-0021.fixture.json');
const EXPECTED = path.join(GOLDEN_DIR, 'session-0021.expected.md');
const GOLDEN_NOW = '2026-09-19T13:36:00-07:00'; // 6h after the fixture's openedAt (byte-stable).

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

// ── GOLDEN-FILE TEST ─────────────────────────────────────────────────────────

test('GOLDEN: render(fixture, {now}) === expected.md byte-for-byte', () => {
  const rec = loadFixture();
  const expected = fs.readFileSync(EXPECTED, 'utf8');
  const actual = render(rec, { now: GOLDEN_NOW });
  assert.strictEqual(actual, expected, 'rendered output must match the committed golden');
});

test('GOLDEN: single-file section order is Handoff -> Punchlist -> Log, header first', () => {
  const out = render(loadFixture(), { now: GOLDEN_NOW });
  const iHeader = out.indexOf('# Session 0021');
  const iHand = out.indexOf('## Handoff');
  const iPunch = out.indexOf('## Punchlist');
  const iLog = out.indexOf('## Log');
  assert.ok(iHeader === 0, 'header banner is first');
  assert.ok(iHeader < iHand && iHand < iPunch && iPunch < iLog, 'order Handoff -> Punchlist -> Log');
  assert.ok(out.startsWith('# Session 0021 · 2026-09-19\n'), 'title line');
  assert.ok(out.includes('> _Generated from `session-0021.json`'), 'generated-file banner line 1');
  assert.ok(out.includes('· **open** · schema 1.0.0 · id 31569169…98a3'), 'banner line 2 fields');
  // Q-D content-hash token (wording per Q-D.2, Jason 2026-09-20): `(generated from: <12hex>)`
  // closes banner line 2 (before its italic `_`). Was ` · gen-from <12hex>`.
  assert.ok(/\(generated from: [0-9a-f]{12}\)_$/m.test(out), 'banner line 2 carries the (generated from: <hex>) content-hash token');
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'), 'exactly one trailing newline');
});

// ── PURITY (DoD row 1) ────────────────────────────────────────────────────────

test('PURE: render is deterministic (two calls -> identical output)', () => {
  const rec = loadFixture();
  const a = render(rec, { now: GOLDEN_NOW });
  const b = render(rec, { now: GOLDEN_NOW });
  assert.strictEqual(a, b, 'same (record, now) -> identical output');
});

test('PURE: render does not mutate the input record', () => {
  const rec = loadFixture();
  const before = JSON.stringify(rec);
  render(rec, { now: GOLDEN_NOW });
  assert.strictEqual(JSON.stringify(rec), before, 'record is unchanged after render');
});

// ── HANDOFF ────────────────────────────────────────────────────────────────────

test('HANDOFF: null handoff renders the placeholder and no field labels', () => {
  const rec = loadFixture();
  rec.handoff = null;
  const out = render(rec, { now: GOLDEN_NOW });
  assert.ok(out.includes('## Handoff\n\n_No handoff yet — session opened, not yet saved._\n'),
    'placeholder line');
  assert.ok(!out.includes('**Where we are:**'), 'no labels when handoff is null');
});

test('HANDOFF: labels on their own line, prose on the next; arrays bulleted', () => {
  const out = render(loadFixture(), { now: GOLDEN_NOW });
  assert.ok(out.includes('**Where we are:**\nBase lib promoted;'), 'where label then prose');
  assert.ok(out.includes('**Next:**\nWire the converter'), 'next label then prose');
  assert.ok(out.includes('**In flight:**\n- P04 converter golden under review'), 'in_flight bulleted');
  assert.ok(
    out.includes('**Must not redo:**\n- Re-deriving the payload nesting — it is LOCKED to top-level siblings.\n- Reading the clock inside render — now is injected.'),
    'must_not_redo bulleted (each element a bullet)',
  );
});

// ── PUNCHLIST ────────────────────────────────────────────────────────────────

test('PUNCHLIST: open numbered with #id + age; carried marker; done struck-through + closed time', () => {
  const out = render(loadFixture(), { now: GOLDEN_NOW });
  assert.ok(out.includes('**Open (2)**'), 'open count');
  assert.ok(out.includes('1. `#21.1` Confirm run-all stays green after the converter suite lands. _(6h ago)_'),
    'plain open item: number, #id, text, age');
  assert.ok(out.includes('2. `#21.4` ⤴ _carried from 0020_ — Legacy migration mapping (#1114) — spec only, not built. _(6h ago)_'),
    'carried open item carries the ⤴ _carried from NNNN_ marker (P06 fromSession provenance)');
  assert.ok(out.includes('**Done (1)**'), 'done count');
  assert.ok(out.includes('- ~~`#21.0` Lock the human-render format.~~ _(closed 07:40)_'),
    'done item struck-through with closed time from the close event');
});

test('PUNCHLIST: dropped items are omitted from both Open and Done', () => {
  const rec = loadFixture();
  rec.punchlist.push({
    id: '21.9', slug: 'dd0000', text: 'Abandoned idea.', state: 'dropped',
    createdAt: '2026-09-19T07:36:00-07:00',
    events: [{ ts: '2026-09-19T07:36:00-07:00', op: 'add' }, { ts: '2026-09-19T08:00:00-07:00', op: 'drop' }],
  });
  const out = render(rec, { now: GOLDEN_NOW });
  assert.ok(!out.includes('Abandoned idea.'), 'dropped item does not render');
  assert.ok(out.includes('**Open (2)**'), 'open count unchanged by the dropped item');
});

// ── AGE BOUNDARIES (Q1) ────────────────────────────────────────────────────────

test('AGE: Nm/Nh/Nd boundaries and the 7-day switch to an absolute date', () => {
  const created = '2026-09-01T00:00:00-07:00';
  const at = (deltaMs) => new Date(Date.parse(created) + deltaMs);
  // minutes (< 1h)
  assert.strictEqual(_ageOf(created, at(0)), '0m ago', 'floor at 0 minutes');
  assert.strictEqual(_ageOf(created, at(59 * 60000)), '59m ago', '59 minutes');
  // hours (>= 1h, < 24h)
  assert.strictEqual(_ageOf(created, at(60 * 60000)), '1h ago', 'exactly 1h -> hours');
  assert.strictEqual(_ageOf(created, at(23 * 3600000)), '23h ago', '23 hours');
  // days (>= 24h, < 7d)
  assert.strictEqual(_ageOf(created, at(24 * 3600000)), '1d ago', 'exactly 24h -> days');
  assert.strictEqual(_ageOf(created, at(6 * 86400000)), '6d ago', '6 days');
  assert.strictEqual(_ageOf(created, at(7 * 86400000 - 60000)), '6d ago', '6d23h59m still 6d ago');
  // absolute at >= 7d (shows the createdAt date, independent of now)
  assert.strictEqual(_ageOf(created, at(7 * 86400000)), '2026-09-01', 'exactly 7d -> absolute date');
  assert.strictEqual(_ageOf(created, at(90 * 86400000)), '2026-09-01', '90d -> absolute createdAt date');
});

test('AGE: clamps a future createdAt to 0m and accepts an ISO-string now', () => {
  assert.strictEqual(_ageOf('2026-09-01T12:00:00-07:00', '2026-09-01T11:00:00-07:00'), '0m ago',
    'now before createdAt clamps to 0m');
});

test('AGE: render throws loud when an open item needs age but now is missing', () => {
  const rec = loadFixture();
  throwsMatching(() => render(rec), /opts\.now is required/, 'missing now with open items');
});

test('AGE: render tolerates a missing now when there are no open items', () => {
  const rec = loadFixture();
  rec.punchlist = rec.punchlist.filter((it) => it.state !== 'open');
  const out = render(rec); // no opts -> no age needed
  assert.ok(out.includes('**Open (0)**'), 'no open items, no age computed, no throw');
});

// ── LOG ENTRY SHAPES ───────────────────────────────────────────────────────────

test('LOG: reverse-chron by seq; blank line between EVERY entry; no leading dash', () => {
  const out = render(loadFixture(), { now: GOLDEN_NOW });
  const log = out.slice(out.indexOf('## Log'));
  const i0914 = log.indexOf('2026-09-19 09:14');
  const i0840 = log.indexOf('2026-09-19 08:40');
  const i0736 = log.indexOf('2026-09-19 07:36');
  assert.ok(i0914 < i0840 && i0840 < i0736, 'newest first');
  assert.ok(log.includes('## Log\n_Newest first._\n\n'), 'log header + newest-first note');
  // no entry begins with a dash/bullet
  for (const line of log.split('\n')) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(line)) continue;
    assert.ok(!/^- \d{4}-\d{2}-\d{2}/.test(line), 'no leading dash on a timestamped entry');
  }
});

test('LOG: single-line entry is `YYYY-MM-DD HH:MM: <status> — <text>`', () => {
  const e = { seq: 1, ts: '2026-09-19T09:14:00-07:00', type: 'log', status: 'NOTE', text: 'all green.' };
  assert.strictEqual(_renderLogEntry(e), '2026-09-19 09:14: NOTE — all green.');
});

test('LOG: multi-line log entry puts the timestamp on its own line then the body', () => {
  const e = { seq: 1, ts: '2026-09-19T08:05:00-07:00', type: 'log', status: 'NOTE', text: 'line one\nline two' };
  assert.strictEqual(_renderLogEntry(e), '2026-09-19 08:05:\nNOTE — line one\nline two');
});

test('LOG: decision leads with 🔹 DECISION — and carries a why: line (multi-line)', () => {
  const e = { seq: 1, ts: '2026-09-19T08:40:00-07:00', type: 'decision', what: 'do X', why: 'because Y' };
  assert.strictEqual(_renderLogEntry(e), '2026-09-19 08:40:\n🔹 DECISION — do X\nwhy: because Y');
});

test('LOG: plain log line renders its free-form status inline', () => {
  const out = render(loadFixture(), { now: GOLDEN_NOW });
  assert.ok(out.includes('2026-09-19 07:36: NOTE — Session 0021 opened; 20 prior sessions on disk.'),
    'plain status shown inline');
});

// ── HEADER edge ────────────────────────────────────────────────────────────────

test('HEADER: closed session renders **closed**; id abbreviation is first8…last4', () => {
  const rec = loadFixture();
  rec.meta.closedAt = '2026-09-19T17:00:00-07:00';
  const out = render(rec, { now: GOLDEN_NOW });
  assert.ok(out.includes('· **closed** ·'), 'closed state');
  assert.strictEqual(_abbrevId('31569169-6609-4bcf-b90f-448f25ee98a3'), '31569169…98a3', 'id abbreviation');
});

// ── WIRING (DoD row 5): inject render into saveSession ──────────────────────────

test('WIRING: saveSession(record,{mdPath,render}) writes JSON (atomic) then rendered .md; JSON round-trips', () => {
  const dir = tmpDir('tpm-converter-');
  const jsonPath = path.join(dir, 'session-0021.json');
  const mdPath = path.join(dir, 'session-0021.md');
  const rec = loadFixture();

  // Inject render with `now` bound in a closure (the real P05/P06 injection pattern):
  const boundRender = (r) => render(r, { now: GOLDEN_NOW });
  const persisted = saveSession(rec, { jsonPath, mdPath, render: boundRender });

  // both files exist
  assert.ok(fs.existsSync(jsonPath), 'canonical JSON written');
  assert.ok(fs.existsSync(mdPath), 'derived .md written');

  // the .md is exactly what the converter produces from the persisted record
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.strictEqual(md, render(persisted, { now: GOLDEN_NOW }), 'derived .md == render(persisted record)');
  assert.ok(md.includes('## Handoff') && md.includes('## Punchlist') && md.includes('## Log'),
    'derived .md carries all sections');

  // JSON still round-trips through the model's load path (read -> migrate -> validate)
  const reloaded = loadSession(jsonPath);
  assert.strictEqual(JSON.stringify(reloaded), JSON.stringify(persisted), 'JSON reload round-trips');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('WIRING: no render/mdPath -> saveSession writes JSON only (converter is optional)', () => {
  const dir = tmpDir('tpm-converter-');
  const jsonPath = path.join(dir, 'session-0021.json');
  const mdPath = path.join(dir, 'session-0021.md');
  saveSession(loadFixture(), { jsonPath });
  assert.ok(fs.existsSync(jsonPath), 'JSON written');
  assert.ok(!fs.existsSync(mdPath), 'no .md when render/mdPath omitted');
  fs.rmSync(dir, { recursive: true, force: true });
});

done('session-converter.test.js');
