#!/usr/bin/env node
/**
 * cost-ledger.js - append a per-subagent cost row to a working folder's
 * tmp/cost-ledger.md, or print a running total.
 *
 * PURPOSE. The orchestrator spawns workers + verifiers, and the harness
 * reports each one's token + tool-call usage in its completion notification.
 * That data has historically been jotted ad hoc into session notes and then
 * scrolled out of context. This tool makes it durable: ONE row per spawned
 * subagent, written at teardown into the SAME working folder the round lives
 * in (`<dir>/tmp/cost-ledger.md`), so the cost record travels with the round
 * instead of living only in a session transcript.
 *
 * A subagent CANNOT reliably introspect its own cumulative token count from
 * inside — so this is an ORCHESTRATOR tool, fed from the completion
 * notification. What a subagent knows (its tool-call count) can be passed via
 * --calls as a cross-check.
 *
 * PORTABILITY. Project-agnostic. No project paths, no domain knowledge. Any
 * project that spawns subagents into `dev/<task>/` (or any folder with a
 * tmp/) can use it unchanged.
 *
 * USAGE.
 *   # append a row (creates <dir>/tmp/cost-ledger.md + header if absent)
 *   node tools/workflow/cost-ledger.js --dir "<working folder>" \
 *     --agent round-w-8b3e --role worker --model opus \
 *     --tokens 715k --calls 198 --verdict ACCEPT --round "phase B merge" \
 *     --note "landed first try"
 *
 *   # print the running total for a working folder
 *   node tools/workflow/cost-ledger.js --dir "<working folder>" --summary
 *
 * FLAGS.
 *   --dir <path>       REQUIRED. The round's working folder (its tmp/ gets the ledger).
 *   --agent <name>     subagent label / uuid (e.g. round-w-8b3e).
 *   --role <role>      worker | verifier | design | fix-loop | ... (free text).
 *   --model <model>    opus | sonnet | fable | haiku | ... (free text).
 *   --tokens <n>       token count. Accepts 715000, "715k", "~715k", "1.2m".
 *   --calls <n>        tool-call count (the subagent-observable cross-check).
 *   --verdict <text>   ACCEPT | ACCEPT-W-EXC | FAIL | SHIPPED | n/a | ...
 *   --round <text>     round / phase label (free text).
 *   --note <text>      anything worth keeping (fix-loop count, retries, etc.).
 *   --date <YYYY-MM-DD> override the auto-stamped date (default: today, in --tz).
 *   --tz <IANA zone>   timezone for the auto-stamped date (default:
 *                      COST_LEDGER_TZ env var, else America/Los_Angeles).
 *   --summary          print totals for <dir>'s ledger and exit (no row written).
 *   --file <name>      ledger filename inside tmp/ (default cost-ledger.md).
 */

'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

/** Parse a token/call count that may carry ~, commas, or a k/m suffix. */
function parseCount(raw) {
  if (raw === undefined || raw === true) return null;
  let s = String(raw).trim().replace(/[~,\s]/g, '').toLowerCase();
  if (s === '' || s === 'n/a' || s === 'na') return null;
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * mult);
}

/**
 * Today as YYYY-MM-DD in the given IANA timezone. Configurable so the ledger
 * date matches the operator's locale rather than a baked-in default; falls back
 * to COST_LEDGER_TZ, then to America/Los_Angeles.
 */
function todayInZone(tz) {
  const timeZone = tz || process.env.COST_LEDGER_TZ || 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function fmt(n) { return n === null ? '—' : n.toLocaleString('en-US'); }
function cell(s) { return String(s === undefined || s === true ? '' : s).replace(/\|/g, '\\|').trim(); }

const HEADER = [
  '# Cost ledger',
  '',
  'One row per spawned subagent, written by the orchestrator at teardown from the completion',
  "notification's usage figures. `tokens` is authoritative (the subagent can't introspect its own);",
  '`calls` is the subagent-observable cross-check. Append-only — run `cost-ledger.js --summary` for totals.',
  '',
  '| Date | Round / phase | Agent | Role | Model | Tokens | Calls | Verdict | Notes |',
  '|------|---------------|-------|------|-------|-------:|------:|---------|-------|',
  '',
].join('\n');

const dir = arg('dir');
if (!dir || dir === true) {
  console.error('cost-ledger: --dir <working folder> is REQUIRED.');
  process.exit(2);
}
const ledgerName = (arg('file', 'cost-ledger.md') === true) ? 'cost-ledger.md' : arg('file', 'cost-ledger.md');
const tmpDir = path.join(dir, 'tmp');
const ledgerPath = path.join(tmpDir, ledgerName);

/** Parse existing data rows (skip header/separator/blank lines). */
function readRows() {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').split('\n')
    .filter(l => l.trim().startsWith('|'))
    .map(l => l.split('|').slice(1, -1).map(c => c.trim()))
    .filter(cols => cols.length >= 9 && cols[0] !== 'Date' && !/^-+$/.test(cols[0].replace(/:/g, '')));
}

if (arg('summary') === true) {
  const rows = readRows();
  if (!rows.length) { console.log(`cost-ledger: no ledger at ${ledgerPath}`); process.exit(0); }
  let tokens = 0, calls = 0, tokRows = 0, callRows = 0;
  const byModel = {};
  for (const r of rows) {
    const t = parseCount(r[5]); const c = parseCount(r[6]); const model = r[4] || '(none)';
    if (t !== null) { tokens += t; tokRows++; byModel[model] = (byModel[model] || 0) + t; }
    if (c !== null) { calls += c; callRows++; }
  }
  console.log(`Cost ledger — ${ledgerPath}`);
  console.log(`  ${rows.length} subagent(s)`);
  console.log(`  tokens: ${fmt(tokens)} total (${tokRows} row(s) with a token count)`);
  console.log(`  calls:  ${fmt(calls)} total (${callRows} row(s) with a call count)`);
  const models = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  if (models.length > 1) for (const [m, t] of models) console.log(`    ${m}: ${fmt(t)}`);
  process.exit(0);
}

const tz = (arg('tz', null) && arg('tz') !== true) ? arg('tz') : null;
const date = (arg('date', null) && arg('date') !== true) ? arg('date') : todayInZone(tz);
const row = `| ${[
  date,
  cell(arg('round', '')),
  cell(arg('agent', '')),
  cell(arg('role', '')),
  cell(arg('model', '')),
  fmt(parseCount(arg('tokens'))),
  fmt(parseCount(arg('calls'))),
  cell(arg('verdict', '')),
  cell(arg('note', '')),
].join(' | ')} |`;

fs.mkdirSync(tmpDir, { recursive: true });
if (!fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, HEADER);
let body = fs.readFileSync(ledgerPath, 'utf8').replace(/\s*$/, '');
fs.writeFileSync(ledgerPath, body + '\n' + row + '\n');
console.log(`cost-ledger: appended to ${ledgerPath}`);
console.log(`  ${row}`);
