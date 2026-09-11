#!/usr/bin/env node
/**
 * lib/format.js — the session-notes format token SSOT (task B1's shared dependency).
 *
 * PURPOSE
 *   ONE place that owns the canonical headings/tokens for `session-notes.md`, per
 *   `session-notes-design.md` §Format ("the format spec is the SSOT; the tool derives its
 *   landmarks from it — don't hardcode a second copy"). `session-notes.js` (write) and
 *   `session-review.js` (read) both import this — so write/read tokens cannot drift.
 *
 * FORMAT (canonical, top-loaded per the corpus review)
 *   # SESSION <NNN> — <date> — <theme>
 *
 *   ## RESUME                                    <- STATE zone: rewritten IN PLACE
 *   **Where we are:** <one dense paragraph>
 *   **Next action:** <the one next step, or "None pending.">
 *   **In flight:** <what's running + where its output lands, or "Nothing in flight.">
 *
 *   ## Open items                                 <- STATE zone: rewritten IN PLACE
 *   - [ ] OPEN(<owner>) #<id>: <text>
 *   - [x] OPEN(<owner>) #<id>: <text>              (done items keep the line, checked)
 *   (or the literal line "None open." when empty — always present, never omitted)
 *
 *   ## Decisions                                  <- appended, landmark per bullet
 *   - **Decided:** <what> — <why>
 *
 *   ## Log                                        <- LOG zone: APPEND-ONLY, never rewritten
 *   - [<STATUS>] <ISO date> — <text>              (<STATUS> is free text — any bracketed tag
 *                                                   round-trips, not just the STATUS_TAGS set)
 *
 *   SEALED <date>                                  <- stamped at the very end by `seal`
 *
 * TWO-ZONE RULE (session-notes-design.md)
 *   STATE (RESUME + Open items) is edited IN PLACE, always reflects NOW. LOG is APPEND-ONLY
 *   chronological history — never rewritten, only added to. `resume`/`open add`/`open done`
 *   touch STATE; `log`/`decide` touch LOG/Decisions (append-only); `seal` appends the SEALED
 *   stamp. This module's render/parse functions enforce that split structurally: there is no
 *   function here that rewrites the Log or Decisions sections, only ones that append to them.
 *
 * EXPORTS
 *   HEADINGS, STATUS_TAGS, DECIDED_PREFIX, SEALED_PREFIX, OPEN_ITEM_RE, LOG_ENTRY_RE, DECISION_RE
 *   buildTitle(number, date, theme)
 *   parseNote(content)   -> { title, number, date, theme, resume:{whereWeAre,nextAction,inFlight},
 *                             openItems:[{id,owner,done,text}], decisions:[{what,why}],
 *                             log:[{status,date,text}], sealedAt: string|null, raw }
 *   renderNote(sections) -> full markdown string (inverse of parseNote for a freshly-built note)
 *   nextOpenItemId(openItems) -> next integer id (max existing + 1, 1 if none)
 */

'use strict';

const HEADINGS = {
  RESUME: '## RESUME',
  OPEN_ITEMS: '## Open items',
  DECISIONS: '## Decisions',
  LOG: '## Log',
};

const STATUS_TAGS = ['DONE', 'WIP', 'BLOCKED', 'HELD', 'PARKED', 'DROPPED'];
const DECIDED_PREFIX = '**Decided:**';
const SEALED_PREFIX = 'SEALED';

const TITLE_RE = /^#\s*SESSION\s+(\d{3})\s*—\s*([^—]+?)\s*—\s*(.+)$/;
const OPEN_ITEM_RE = /^- \[( |x)\] OPEN\(([^)]+)\)\s*#(\d+):\s*(.*)$/;
// Matches ANY bracketed tag, not just STATUS_TAGS — session-notes.js's own docstring
// promises `log --status <TAG>` is "free text (no enforced enum)"; STATUS_TAGS is a
// convention for display/suggestion purposes only, never a parse-time allowlist. Narrowing
// this to a fixed alternation (as it used to be) silently drops any log entry whose tag
// falls outside that list on the very next write — see findings/HANDOFF.md "Bug-fixer r1".
const LOG_ENTRY_RE = /^- \[([^\]]+)\]\s*([^—]+?)\s*—\s*(.*)$/;
const DECISION_RE = /^- \*\*Decided:\*\*\s*([^—]+?)\s*—\s*(.*)$/;
const SEALED_RE = /^SEALED\s+(.+)$/;

function buildTitle(number, date, theme) {
  return `# SESSION ${number} — ${date} — ${theme}`;
}

function splitSections(content) {
  const lines = content.split('\n');
  const sections = { preamble: [], resume: [], openItems: [], decisions: [], log: [], trailer: [] };
  let cur = 'preamble';
  for (const line of lines) {
    if (line.trim() === HEADINGS.RESUME) { cur = 'resume'; continue; }
    if (line.trim() === HEADINGS.OPEN_ITEMS) { cur = 'openItems'; continue; }
    if (line.trim() === HEADINGS.DECISIONS) { cur = 'decisions'; continue; }
    if (line.trim() === HEADINGS.LOG) { cur = 'log'; continue; }
    if (SEALED_RE.test(line.trim())) { cur = 'trailer'; sections.trailer.push(line); continue; }
    sections[cur].push(line);
  }
  return sections;
}

function parseResume(lines) {
  const out = { whereWeAre: '', nextAction: '', inFlight: '' };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('**Where we are:**')) out.whereWeAre = t.slice('**Where we are:**'.length).trim();
    else if (t.startsWith('**Next action:**')) out.nextAction = t.slice('**Next action:**'.length).trim();
    else if (t.startsWith('**In flight:**')) out.inFlight = t.slice('**In flight:**'.length).trim();
  }
  return out;
}

function parseOpenItems(lines) {
  const items = [];
  for (const line of lines) {
    const m = OPEN_ITEM_RE.exec(line.trim());
    if (m) items.push({ done: m[1] === 'x', owner: m[2], id: parseInt(m[3], 10), text: m[4] });
  }
  return items;
}

function parseDecisions(lines) {
  const out = [];
  for (const line of lines) {
    const m = DECISION_RE.exec(line.trim());
    if (m) out.push({ what: m[1].trim(), why: m[2].trim() });
  }
  return out;
}

function parseLog(lines) {
  const out = [];
  for (const line of lines) {
    const m = LOG_ENTRY_RE.exec(line.trim());
    if (m) out.push({ status: m[1], date: m[2].trim(), text: m[3].trim() });
  }
  return out;
}

function parseSealed(trailerLines) {
  for (const line of trailerLines) {
    const m = SEALED_RE.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/** Parse a full session-notes.md (or notes.md) into a structured object. */
function parseNote(content) {
  const titleLine = content.split('\n').find((l) => l.trim().startsWith('# SESSION'));
  let number = null;
  let date = null;
  let theme = null;
  if (titleLine) {
    const m = TITLE_RE.exec(titleLine.trim());
    if (m) {
      number = m[1];
      date = m[2].trim();
      theme = m[3].trim();
    }
  }
  const sections = splitSections(content);
  return {
    title: titleLine || null,
    number,
    date,
    theme,
    resume: parseResume(sections.resume),
    openItems: parseOpenItems(sections.openItems),
    decisions: parseDecisions(sections.decisions),
    log: parseLog(sections.log),
    sealedAt: parseSealed(sections.trailer),
    raw: content,
  };
}

function renderOpenItems(items) {
  if (!items || items.length === 0) return 'None open.';
  return items
    .map((it) => `- [${it.done ? 'x' : ' '}] OPEN(${it.owner}) #${it.id}: ${it.text}`)
    .join('\n');
}

function renderDecisions(decisions) {
  if (!decisions || decisions.length === 0) return '_None yet._';
  return decisions.map((d) => `- ${DECIDED_PREFIX} ${d.what} — ${d.why}`).join('\n');
}

function renderLog(log) {
  if (!log || log.length === 0) return '_Nothing logged yet._';
  return log.map((e) => `- [${e.status}] ${e.date} — ${e.text}`).join('\n');
}

/**
 * Render a full note from a structured sections object (inverse-ish of parseNote — used by
 * session-notes.js after it mutates the parsed structure).
 */
function renderNote(sections) {
  const {
    number, date, theme,
    resume = {}, openItems = [], decisions = [], log = [], sealedAt = null,
  } = sections;

  const parts = [
    buildTitle(number, date, theme),
    '',
    HEADINGS.RESUME,
    `**Where we are:** ${resume.whereWeAre || ''}`,
    `**Next action:** ${resume.nextAction || ''}`,
    `**In flight:** ${resume.inFlight || 'Nothing in flight.'}`,
    '',
    HEADINGS.OPEN_ITEMS,
    renderOpenItems(openItems),
    '',
    HEADINGS.DECISIONS,
    renderDecisions(decisions),
    '',
    HEADINGS.LOG,
    renderLog(log),
  ];

  if (sealedAt) {
    parts.push('', `${SEALED_PREFIX} ${sealedAt}`);
  }

  return `${parts.join('\n')}\n`;
}

function nextOpenItemId(openItems) {
  if (!openItems || openItems.length === 0) return 1;
  return Math.max(...openItems.map((it) => it.id)) + 1;
}

module.exports = {
  HEADINGS,
  STATUS_TAGS,
  DECIDED_PREFIX,
  SEALED_PREFIX,
  OPEN_ITEM_RE,
  LOG_ENTRY_RE,
  DECISION_RE,
  buildTitle,
  parseNote,
  renderNote,
  nextOpenItemId,
};
