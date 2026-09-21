'use strict';
/**
 * dogfood-corpus.test.js (P07) — an adequacy / dogfood run against a REALISTIC synthetic corpus.
 *
 * Builds a multi-session corpus THE REAL WAY — through the ops (open / note / import-handoff /
 * punchlist / carry-in), not hand-written JSON — so every file is a genuine canonical envelope:
 *   0018  full: handoff, a log line + a decision, an open + a closed punchlist item.
 *   0019  full, opened FROM 0018 (carries 0018's open item forward), own handoff + notes.
 *   0020  NULL-HANDOFF: opened, a note + a punchlist item, never given a handoff (renders the
 *         "_No handoff yet_" placeholder — the lifecycle edge the render must survive).
 *   0021  full, opened FROM 0020 (carries 0020's open item forward), own handoff + notes.
 * Varied handoff/log/punchlist, carried items across two lineages, and a null-handoff session.
 *
 * Then it exercises the export surface over the whole corpus (combined + per-file, JSON + human)
 * and a re-import round-trip, asserting well-formed human output and that every exported JSON
 * re-loads through the real read→migrate→validate path.
 *
 * NOTE (scope): dogfooding the REAL old-format markdown sessions awaits #1114 migration and is OUT
 * OF SCOPE here — this corpus is synthetic-but-realistic, built via the ops.
 *
 * Everything runs in THROWAWAY dirs (os.tmpdir mkdtemp) — NEVER the live sessions dir.
 * Run: node tests/dogfood-corpus.test.js
 * Node built-ins only.
 */
const { assert, test, done } = require('./helpers/harness');
const {
  NOW, scratch, jsonPath, writeTmp, fs,
  assertWellFormedHuman, loadEnvelopeFromBody,
} = require('./helpers/e2e-helpers');

const ops = require('../tpm-session-ops');
const model = require('../lib/session-model');
const exporter = require('../tpm-session-export');

// Build the corpus and return { dir, numbers }.
function buildCorpus() {
  const dir = scratch('tpm-dogfood-');

  // 0018 — a full, self-contained session.
  ops.opOpen({ sessionsDir: dir, number: '0018', sessionId: 'sid-18', tpmVersion: '1.0.0', now: NOW });
  ops.opImportHandoff({ sessionsDir: dir, number: '0018', txtFile: writeTmp(dir, 'h18.txt', 'bootstrapped the corpus'), next: 'carry the open item to 0019', now: NOW });
  ops.opNote({ sessionsDir: dir, number: '0018', type: 'log', status: 'NOTE', text: 'session 0018 opened', now: NOW });
  ops.opNote({ sessionsDir: dir, number: '0018', type: 'decision', what: 'JSON-first storage', why: 'one canonical file, derived human', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0018', action: 'add', text: 'design the ops layer', slug: 'ops18a', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0018', action: 'add', text: 'a task already handled', slug: 'don18a', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0018', action: 'close', idOrSlug: 'don18a', now: NOW });

  // 0019 — opened FROM 0018 (carries the still-open 'ops18a' forward), then its own work.
  ops.opOpen({ sessionsDir: dir, number: '0019', sessionId: 'sid-19', tpmVersion: '1.0.0', priorSessionPath: jsonPath(dir, 18), now: NOW });
  ops.opImportHandoff({ sessionsDir: dir, number: '0019', txtFile: writeTmp(dir, 'h19.txt', 'continued the ops design'), next: 'ship the converter', now: NOW });
  ops.opNote({ sessionsDir: dir, number: '0019', type: 'log', status: 'PROGRESS', text: 'converter sketched', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0019', action: 'add', text: 'write the export tool', slug: 'exp19a', now: NOW });

  // 0020 — NULL-HANDOFF: opened, a note + a punchlist item, but NEVER given a handoff.
  ops.opOpen({ sessionsDir: dir, number: '0020', sessionId: 'sid-20', tpmVersion: '1.0.0', now: NOW });
  ops.opNote({ sessionsDir: dir, number: '0020', type: 'log', status: 'NOTE', text: 'quick session, no handoff yet', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0020', action: 'add', text: 'revisit the null-handoff render', slug: 'nul20a', now: NOW });

  // 0021 — opened FROM 0020 (carries 'nul20a' forward), then its own handoff + notes.
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-21', tpmVersion: '1.0.0', priorSessionPath: jsonPath(dir, 20), now: NOW });
  ops.opImportHandoff({ sessionsDir: dir, number: '0021', txtFile: writeTmp(dir, 'h21.txt', 'hardening with cross-cutting tests'), next: 'close the epic', now: NOW });
  ops.opNote({ sessionsDir: dir, number: '0021', type: 'decision', what: 'add the P07 test train', why: 'per-phase suites miss cross-cutting invariants', now: NOW });

  return { dir, numbers: ['0018', '0019', '0020', '0021'] };
}

test('corpus is built via the ops and every file is a valid canonical session', () => {
  const { dir, numbers } = buildCorpus();
  numbers.forEach((n) => {
    const rec = model.loadSession(jsonPath(dir, n)); // read→migrate→validate; throws loud if bad
    assert.strictEqual(rec.kind, 'session');
    assert.strictEqual(String(Number(rec.meta.number)), String(Number(n)));
  });
  // the null-handoff session really has a null handoff
  assert.strictEqual(model.loadSession(jsonPath(dir, '0020')).handoff, null, '0020 is a genuine null-handoff session');
  // the carried lineages are present (same slug, new session-prefixed id, carry-in event w/ provenance)
  const s19 = model.loadSession(jsonPath(dir, '0019'));
  const carried19 = s19.punchlist.find((it) => it.slug === 'ops18a');
  assert.ok(carried19 && carried19.events.some((e) => e.op === 'carry-in' && e.fromSession === '0018'), '0019 carried 0018.ops18a with provenance');
  const s21 = model.loadSession(jsonPath(dir, '0021'));
  const carried21 = s21.punchlist.find((it) => it.slug === 'nul20a');
  assert.ok(carried21 && carried21.events.some((e) => e.op === 'carry-in' && e.fromSession === '0020'), '0021 carried 0020.nul20a with provenance');
});

test('export combined (JSON bare-array + human repeated header) over the whole corpus is well-formed', () => {
  const { dir, numbers } = buildCorpus();
  const out = exporter.exportSessions({ sessionsDir: dir, selector: numbers, styles: ['json', 'human'], combine: 'one-file', now: NOW });

  const combinedJson = out.outputs.find((o) => o.style === 'json');
  const arr = JSON.parse(combinedJson.body);
  assert.ok(Array.isArray(arr), 'combined JSON is a bare array (Q4)');
  assert.strictEqual(arr.length, numbers.length, 'one envelope per corpus session');
  const rtDir = scratch('tpm-dogfood-rt-');
  arr.forEach((env, i) => {
    const loaded = loadEnvelopeFromBody(JSON.stringify(env, null, 2) + '\n', rtDir, `combined-${i}`);
    assert.strictEqual(loaded.kind, 'session', 'each combined-array element re-loads as a valid envelope');
  });

  const combinedHuman = out.outputs.find((o) => o.style === 'human');
  assertWellFormedHuman(combinedHuman.body, numbers.length, 'corpus combined human');
  assert.ok(combinedHuman.body.includes('_No handoff yet'), 'the null-handoff session renders its placeholder within the combined human');
  assert.ok(/⤴ _carried from 0018_/.test(combinedHuman.body) && /⤴ _carried from 0020_/.test(combinedHuman.body), 'both carried lineages render their provenance');
});

test('export per-file (JSON + human) over the corpus + re-import round-trip', () => {
  const { dir, numbers } = buildCorpus();
  const out = exporter.exportSessions({ sessionsDir: dir, selector: numbers, styles: ['json', 'human'], combine: 'per-file', now: NOW });

  const perJson = out.outputs.filter((o) => o.style === 'json');
  const perHuman = out.outputs.filter((o) => o.style === 'human');
  assert.strictEqual(perJson.length, numbers.length, 'one JSON file per session');
  assert.strictEqual(perHuman.length, numbers.length, 'one human file per session');

  // each per-file JSON re-loads identical to the live record (round-trip), each human is well-formed
  const rtDir = scratch('tpm-dogfood-rt-');
  perJson.forEach((o) => {
    const env = JSON.parse(o.body);
    const live = model.loadSession(jsonPath(dir, env.meta.number));
    const reloaded = loadEnvelopeFromBody(o.body, rtDir, `perfile-${env.meta.number}`);
    assert.deepStrictEqual(reloaded, live, `per-file JSON for ${o.suggestedName} round-trips to the live record`);
  });
  perHuman.forEach((o) => assertWellFormedHuman(o.body, 1, `per-file human ${o.suggestedName}`));

  // re-import round-trip via an ops verb: export 0018's full record, import its handoff into a NEW session.
  const j18 = perJson.find((o) => Number(JSON.parse(o.body).meta.number) === 18);
  const src = model.loadSession(jsonPath(dir, '0018'));
  const fresh = scratch('tpm-dogfood-import-');
  ops.opOpen({ sessionsDir: fresh, number: '0099', sessionId: 'sid-import', tpmVersion: '1.0.0', now: NOW });
  const impFile = writeTmp(fresh, 'exported-0018.json', j18.body);
  const rec = ops.opImportHandoff({ sessionsDir: fresh, number: '0099', jsonFile: impFile, now: NOW });
  assert.strictEqual(rec.handoff.where, src.handoff.where, 'exported→imported handoff.where round-trips');
  assert.strictEqual(rec.handoff.next, src.handoff.next, 'exported→imported handoff.next round-trips');
  assertWellFormedHuman(require('../lib/session-converter').render(rec, { now: NOW }), 1, 'the re-imported session renders well-formed');
});

done('dogfood-corpus.test.js');
