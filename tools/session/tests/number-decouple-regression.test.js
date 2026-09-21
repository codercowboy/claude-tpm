'use strict';
/**
 * number-decouple-regression.test.js (P05, #1122.C) — cross-cutting regression pinning the LOCKED
 * decouple: the STORED `meta.number` is the canonical zero-padded width-4 STRING, INDEPENDENT of the
 * input form, and it (i) resolves the correct on-disk `session-<NNNN>.json` and (ii) renders
 * `# Session NNNN` — regardless of whether the number arrived as an int, an un-padded string, or an
 * already-padded string.
 *
 * Complements (does not duplicate) session-ops.test.js's single '31' robustness case and
 * session-model.test.js's canonicalNumber unit: this SWEEPS the equivalence class of input forms
 * through the REAL ops path (open → save JSON + .md → reload → render) so a regression that stored an
 * un-padded number, or broke filename/render padding, goes red for EVERY form at once. Includes a
 * >4-digit case (natural width kept) to pin padNumber's boundary too.
 *
 * All writes go to THROWAWAY dirs (os.tmpdir mkdtemp) — NEVER the live sessions tree.
 * Run: node tests/number-decouple-regression.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const os = require('os');
const { assert, test, done, fs, path } = require('./helpers/harness');
const { NOW } = require('./helpers/e2e-helpers');

const ops = require('../tpm-session-ops');
const model = require('../lib/session-model');
const { render } = require('../lib/session-converter');
const { canonicalNumber } = require('../lib/session-model');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-decouple-')); }

// Each row: the input FORM, and the canonical NNNN it must all collapse to.
const CASES = [
  { forms: [31, '31', '0031', '00031'], nnnn: '0031' },
  { forms: [7, '7', '0007'], nnnn: '0007' },
  { forms: [12345, '12345'], nnnn: '12345' }, // >4 digits: natural width kept (padNumber boundary)
];

for (const { forms, nnnn } of CASES) {
  forms.forEach((form) => {
    test(`open with ${JSON.stringify(form)} → stored meta.number "${nnnn}" (STRING), file session-${nnnn}.json, renders "# Session ${nnnn}"`, () => {
      const dir = scratch();
      const rec = ops.opOpen({ sessionsDir: dir, number: form, sessionId: `sid-${nnnn}`, tpmVersion: '1.0.0', now: NOW });

      // (stored form) canonical zero-padded width-4 STRING, independent of the input form.
      assert.strictEqual(rec.meta.number, nnnn, 'stored meta.number is the canonical form');
      assert.strictEqual(typeof rec.meta.number, 'string', 'stored meta.number is a STRING (not the integer)');

      // (i) resolves the correct on-disk file — the canonical NESTED session-<NNNN>/session-<NNNN>.json,
      //     not a folder/file under the raw input form.
      const jsonPath = path.join(dir, `session-${nnnn}`, `session-${nnnn}.json`);
      assert.ok(fs.existsSync(jsonPath), `on-disk canonical file is session-${nnnn}/session-${nnnn}.json`);
      // no un-canonical folder was written under the raw input form.
      if (`session-${form}` !== `session-${nnnn}`) {
        const rawPath = path.join(dir, `session-${form}`, `session-${form}.json`);
        assert.ok(!fs.existsSync(rawPath), `no file written under the raw form (session-${form}/…)`);
      }

      // the ops path reloads the session by its canonical number (resolution round-trips).
      const reloaded = model.loadSession(jsonPath);
      assert.strictEqual(reloaded.meta.number, nnnn, 'reloaded record carries the canonical number');

      // (ii) renders "# Session NNNN".
      const md = render(reloaded, { now: NOW });
      assert.ok(new RegExp(`^# Session ${nnnn} · `, 'm').test(md), `human render header is "# Session ${nnnn}"`);
      // the derived .md the op wrote alongside says the same.
      const mdOnDisk = fs.readFileSync(path.join(dir, `session-${nnnn}`, `session-${nnnn}.md`), 'utf8');
      assert.ok(new RegExp(`^# Session ${nnnn} · `, 'm').test(mdOnDisk), `on-disk .md header is "# Session ${nnnn}"`);
    });
  });
}

test('canonicalNumber collapses the whole equivalence class to one canonical STRING', () => {
  for (const { forms, nnnn } of CASES) {
    for (const form of forms) {
      const got = canonicalNumber(form);
      assert.strictEqual(got, nnnn, `canonicalNumber(${JSON.stringify(form)}) === "${nnnn}"`);
      assert.strictEqual(typeof got, 'string', 'canonicalNumber returns a STRING');
    }
  }
});

done('number-decouple-regression.test.js');
