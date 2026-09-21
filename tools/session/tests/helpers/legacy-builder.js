'use strict';
/**
 * legacy-builder.js — writes SYNTHETIC old-format ("marked 3-file") sessions to a SCRATCH dir so
 * the P05 cross-cutting suites can dogfood the REAL migrator (tpm-session-migrate.js) end-to-end on
 * a whole corpus, not just the single frozen 0021 golden. NOT a *.test.js (run-all never runs it
 * standalone); it only provides builders the new suites `require`.
 *
 * The markdown shape it emits mirrors the committed legacy fixtures under fixtures/legacy/ exactly
 * (banner line, "## Where we are / Next / In flight" handoff, "## Decisions" / "## Log" ledger,
 * "## Open" / "## Done" punchlist with a trailing "[slug, ISO-TZ]" tag) — the exact shape
 * detectShape / parseHandoff / parseLog / parsePunchlist accept.
 *
 * Everything is written under a caller-supplied SCRATCH base dir (os.tmpdir mkdtemp) — NEVER the
 * live sessions tree, NEVER the sandbox fixtures in place. Node built-ins only.
 */
const fs = require('fs');
const path = require('path');

const MID = '·'; // U+00B7 middle dot   ("#id · text")
const EMD = '—'; // U+2014 em dash      ("what — why")

function banner(num) {
  return (
    `<!-- tpm-session: ${num} · 2026-09-10 · tpm-session-version: 1.0 · ` +
    `files: session-${num}-handoff.md, session-${num}-log.md, session-${num}-punchlist.md -->`
  );
}

/**
 * handoffMd(num, handoff) -> string
 *   handoff === null | undefined  → a null-handoff file (banner + title only; NO Where/Next lines,
 *                                   so parseHandoff returns null — the lifecycle A3 edge).
 *   handoff = { where, next, in_flight?[], mustNotRedo?[] } → a full handoff.
 */
function handoffMd(num, handoff) {
  const lines = [banner(num), `# HANDOFF — session ${num} — 2026-09-10`, ''];
  if (!handoff) {
    lines.push('## Where we are / Next / In flight', '_(session opened; no handoff captured yet)_', '');
    return lines.join('\n') + '\n';
  }
  lines.push('## Where we are / Next / In flight');
  lines.push(`**Where we are:** ${handoff.where}`);
  lines.push(`**Next action:** ${handoff.next}`);
  if (Array.isArray(handoff.in_flight) && handoff.in_flight.length) {
    lines.push(`**In flight:** ${handoff.in_flight.join('; ')}`);
  }
  lines.push('');
  if (Array.isArray(handoff.mustNotRedo) && handoff.mustNotRedo.length) {
    lines.push('## MUST NOT redo');
    for (const m of handoff.mustNotRedo) lines.push(`- ${m}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

/**
 * logMd(num, { decisions, logs }) -> string
 *   decisions = [{ what, why, ts }]   logs = [{ status, text, ts }]
 * Emits the "## Decisions" + "## Log" sections (empty sections when the arrays are empty — the
 * no-timestamp case the openedAt-refuse suite needs).
 */
function logMd(num, opts) {
  const o = opts || {};
  const decisions = o.decisions || [];
  const logs = o.logs || [];
  const lines = [banner(num), `# SESSION ${num}`, '', '## Decisions'];
  for (const d of decisions) lines.push(`- **Decided:** ${d.what} ${EMD} ${d.why}  [${d.ts}]`);
  lines.push('', '## Log');
  for (const l of logs) lines.push(`- [${l.status}] ${l.text}  [${l.ts}]`);
  lines.push('', 'SEALED 2026-09-10');
  return lines.join('\n') + '\n';
}

/**
 * punchlistMd(num, { open, done }) -> string
 *   open = [{ id, slug, text, ts }]
 *   done = [{ id, slug, text, ts, closedTs }]
 */
function punchlistMd(num, opts) {
  const o = opts || {};
  const open = o.open || [];
  const done = o.done || [];
  const lines = [banner(num), `# Punchlist — session ${num} — 2026-09-10`, '', '## Open'];
  for (const it of open) lines.push(`- [ ] #${it.id} ${MID} ${it.text}  [${it.slug}, ${it.ts}]`);
  lines.push('', '## Done');
  for (const it of done) {
    lines.push(`- [x] #${it.id} ${MID} ${it.text}  [${it.slug}, ${it.ts}] (closed ${it.closedTs})`);
  }
  return lines.join('\n') + '\n';
}

/**
 * writeOldSession(baseDir, num, spec) -> inDir (the per-session dir with the marked 3-file trio)
 *   spec = { handoff, decisions, logs, open, done }  (all optional; handoff null → null-handoff)
 */
function writeOldSession(baseDir, num, spec) {
  const s = spec || {};
  const inDir = path.join(baseDir, `session-${num}`);
  fs.mkdirSync(inDir, { recursive: true });
  fs.writeFileSync(path.join(inDir, `session-${num}-handoff.md`), handoffMd(num, s.handoff));
  fs.writeFileSync(path.join(inDir, `session-${num}-log.md`), logMd(num, { decisions: s.decisions, logs: s.logs }));
  fs.writeFileSync(path.join(inDir, `session-${num}-punchlist.md`), punchlistMd(num, { open: s.open, done: s.done }));
  return inDir;
}

module.exports = { writeOldSession, handoffMd, logMd, punchlistMd, banner, MID, EMD };
