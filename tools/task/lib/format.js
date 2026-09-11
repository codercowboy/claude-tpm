#!/usr/bin/env node
/**
 * lib/format.js — the tpm-task format token SSOT (checklist B4 / build-plan Wave 2).
 *
 * PURPOSE
 *   ONE module that owns the canonical body + index tokens (headings, `- **Label:**` field
 *   lines, `- [ ] A.` checkbox lines, index table rows, the `**Next ID:**` marker) AND the
 *   read/write logic over them. store.js (the engine) is the only importer, so write/read
 *   tokens cannot drift.
 *
 * THE G1 CONTRACT — SURGICAL IN-PLACE REWRITE, NOT RENDER-FROM-STRUCT
 *   The module's defining constraint (spec §1 #5, wiki §"HARD constraint"): a body is plain
 *   markdown a human reads + hand-edits, and the tool MUST preserve any free-form prose it does
 *   not specifically manage. The sibling tools/session/lib/format.js `renderNote()` rebuilds a
 *   file from a parsed struct and DROPS everything it doesn't re-emit — copying that here would
 *   silently lose data on the first write. So this module does NOT render-from-struct for edits.
 *   Instead:
 *     - Every MANAGED datum is a SINGLE canonical line (the H1 title, each `- **Label:**`
 *       field, `**Summary:**`, `**Context:**`, the `**Subtasks:**` header, each `- [ ] A.`
 *       checkbox). Managed = a distinct landmark line the tool owns.
 *     - Parse is LENIENT (by markdown landmark, never byte offset): tolerant of case, extra
 *       whitespace, a missing `- ` bullet, `·`/`:`/`-` title separators.
 *     - A mutation (setField/removeField/setHeadline/setSummary/setContext/setSubtasks/
 *       setSubtaskChecked) edits ONLY the managed line(s) it targets — replacing them
 *       canonically in place, or inserting a new managed line at a defined anchor — and leaves
 *       EVERY other byte (blank lines, `## Notes` blocks, stray paragraphs) untouched.
 *   Result: preserve-unmanaged-prose + normalize-managed-on-write + idempotency are mutually
 *   consistent. `buildBody()` (render-from-struct) is used ONLY to author a BRAND-NEW body
 *   (add/import) where there is no prose to preserve — never to rewrite an existing one.
 *
 * CANONICAL BODY FORMAT (bodies/<bucket>/task-<N>.md)
 *   # #1245 · <headline>
 *
 *   - **State:** open
 *   - **Created:** 2026-08-27
 *   - **Started:** 2026-08-28        (optional, stamped by `start`)
 *   - **Ended:** 2026-08-29          (optional, stamped by finish/drop)
 *   - **End action:** <text>         (optional, stamped by finish/drop)
 *   - **Reopened:** 2026-08-30       (optional, stamped by reopen)
 *
 *   **Summary:** <one or two sentences>
 *
 *   **Context:** <full detail — cross-refs in `backticks`>
 *
 *   **Subtasks:**                     (epics only)
 *   - [ ] A. <subtask>
 *   - [x] B. <subtask>
 *
 * CANONICAL INDEX FORMAT (task-index.md / finished-tasks-index.md / removed-tasks-index.md)
 *   # <title>
 *   **Next ID:** 1008                 (task-index.md ONLY — survives an empty open table)
 *
 *   | #    | State       | Created    | Task |
 *   |------|-------------|------------|------|
 *   | 1007 | in-progress | 2026-08-27 | Collapse task-add/list into /tpm-task  (2/5) |
 */

'use strict';

// ── States + state-block field order ──────────────────────────────────────────
const STATES = ['open', 'in-progress', 'finished', 'dropped', 'removed'];
// Canonical top-of-body field order (state-block). New fields insert to keep this order.
const FIELD_ORDER = ['State', 'Created', 'Started', 'Ended', 'End action', 'Reopened'];

// ── Landmark regexes (LENIENT — case-insensitive labels, tolerant whitespace) ──
const TITLE_RE = /^#\s+#?(\d+)\s*(?:[·:–—-]\s*)?(.*)$/;
const FIELD_RE = /^\s*-?\s*\*\*\s*(State|Created|Started|Ended|End action|Reopened)\s*:\s*\*\*\s*(.*)$/i;
const SUMMARY_RE = /^\s*\*\*\s*Summary\s*:\s*\*\*\s*(.*)$/i;
const CONTEXT_RE = /^\s*\*\*\s*Context\s*:\s*\*\*\s*(.*)$/i;
const SUBTASKS_HDR_RE = /^\s*\*\*\s*Subtasks\s*:\s*\*\*\s*$/i;
const CHECKBOX_RE = /^\s*-\s*\[\s*([ xX])\s*\]\s*([A-Za-z])\s*[.)]\s*(.*)$/;

// Index landmarks
const NEXT_ID_RE = /^\s*\*\*\s*Next ID\s*:\s*\*\*\s*(\d+)\s*$/i;
const INDEX_ROW_RE = /^\s*\|(.*)\|\s*$/;

// Canonical field label lookup (normalizes a lenient-parsed label back to canonical casing).
const FIELD_CANON = {
  state: 'State', created: 'Created', started: 'Started',
  ended: 'Ended', 'end action': 'End action', reopened: 'Reopened',
};

function canonField(label) {
  return FIELD_CANON[label.toLowerCase()] || label;
}

// ── Body parse (read) ─────────────────────────────────────────────────────────

/**
 * Parse a raw body into a structured view WITH the original line array + landmark indices.
 * Managed data are single lines; everything else is preserved as-is in `.lines`.
 */
function parseBody(raw) {
  const lines = raw.split('\n');
  const out = {
    lines,
    raw,
    number: null,
    headline: null,
    titleIdx: -1,
    fields: {}, // canonName -> { idx, value }
    summary: null, // { idx, value }
    context: null, // { idx, value }
    subtasks: null, // { headerIdx, items: [{ idx, letter, checked, text }] }
  };

  const items = [];
  let subtasksHeaderIdx = -1;
  // Subtasks are collected ONLY from the contiguous checkbox run that begins at the
  // `**Subtasks:**` header (blank lines tolerated within it). Any non-blank, non-checkbox
  // line — a `## Notes` heading, a prose paragraph — ends the run, so a `- [ ] X.` line a
  // human wrote in UNMANAGED prose is never mistaken for a subtask (the G1 no-data-loss
  // contract: `setSubtasks`'s owned span can then never straddle an unmanaged block).
  let inSubtasks = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Inside the managed subtasks run: collect checkbox lines, tolerate blank lines, and
    // stop at the first other line (which then falls through to be parsed normally below).
    if (inSubtasks) {
      const bm = CHECKBOX_RE.exec(line);
      if (bm) {
        items.push({ idx: i, letter: bm[2].toUpperCase(), checked: bm[1].toLowerCase() === 'x', text: bm[3].trim() });
        continue;
      }
      if (line.trim() === '') continue;
      inSubtasks = false;
    }

    if (out.titleIdx === -1) {
      const tm = TITLE_RE.exec(line);
      if (tm) {
        out.titleIdx = i;
        out.number = parseInt(tm[1], 10);
        out.headline = tm[2].trim();
        continue;
      }
    }

    const fm = FIELD_RE.exec(line);
    if (fm) {
      const name = canonField(fm[1]);
      if (!out.fields[name]) out.fields[name] = { idx: i, value: fm[2].trim() };
      continue;
    }

    const sm = SUMMARY_RE.exec(line);
    if (sm && !out.summary) { out.summary = { idx: i, value: sm[1].trim() }; continue; }

    const cm = CONTEXT_RE.exec(line);
    if (cm && !out.context) { out.context = { idx: i, value: cm[1].trim() }; continue; }

    if (SUBTASKS_HDR_RE.test(line) && subtasksHeaderIdx === -1) { subtasksHeaderIdx = i; inSubtasks = true; continue; }
  }

  if (subtasksHeaderIdx !== -1 || items.length > 0) {
    out.subtasks = { headerIdx: subtasksHeaderIdx, items };
  }
  return out;
}

function subtaskProgress(parsed) {
  if (!parsed.subtasks || parsed.subtasks.items.length === 0) return null;
  const total = parsed.subtasks.items.length;
  const done = parsed.subtasks.items.filter((it) => it.checked).length;
  return { done, total };
}

// ── Canonical single-line renderers ───────────────────────────────────────────
function fieldLine(name, value) { return `- **${name}:** ${value}`; }
function titleLine(number, headline) { return `# #${number} · ${headline}`; }
function summaryLine(value) { return `**Summary:** ${value}`; }
function contextLine(value) { return `**Context:** ${value}`; }
function checkboxLine(letter, checked, text) { return `- [${checked ? 'x' : ' '}] ${letter}. ${text}`; }

// ── Surgical body mutations (return a NEW raw string; never touch unmanaged lines) ──

/** Set (or insert) a state-block field, keeping FIELD_ORDER within the block. */
function setField(raw, name, value) {
  const canon = canonField(name);
  const parsed = parseBody(raw);
  const lines = parsed.lines.slice();
  const line = fieldLine(canon, value);

  if (parsed.fields[canon]) {
    lines[parsed.fields[canon].idx] = line;
    return lines.join('\n');
  }

  // Insert at the FIELD_ORDER-correct slot within the contiguous state block.
  const myOrd = FIELD_ORDER.indexOf(canon);
  let insertAt = -1;
  // Find the last existing field whose order is < mine -> insert right after it.
  for (const fname of FIELD_ORDER) {
    if (FIELD_ORDER.indexOf(fname) < myOrd && parsed.fields[fname]) {
      insertAt = Math.max(insertAt, parsed.fields[fname].idx);
    }
  }
  if (insertAt === -1) {
    // No earlier field present: insert before the first existing field, else right after title.
    let firstFieldIdx = Infinity;
    for (const fname of Object.keys(parsed.fields)) firstFieldIdx = Math.min(firstFieldIdx, parsed.fields[fname].idx);
    if (firstFieldIdx !== Infinity) insertAt = firstFieldIdx - 1;
    else insertAt = parsed.titleIdx; // after title (may be -1 -> unshift)
  }
  lines.splice(insertAt + 1, 0, line);
  return lines.join('\n');
}

/** Remove a state-block field line if present (no-op otherwise). */
function removeField(raw, name) {
  const canon = canonField(name);
  const parsed = parseBody(raw);
  if (!parsed.fields[canon]) return raw;
  const lines = parsed.lines.slice();
  lines.splice(parsed.fields[canon].idx, 1);
  return lines.join('\n');
}

function getField(raw, name) {
  const parsed = parseBody(raw);
  const f = parsed.fields[canonField(name)];
  return f ? f.value : null;
}

/** Rewrite the H1 headline in place (number stays). */
function setHeadline(raw, headline) {
  const parsed = parseBody(raw);
  if (parsed.titleIdx === -1) return raw;
  const lines = parsed.lines.slice();
  lines[parsed.titleIdx] = titleLine(parsed.number, headline);
  return lines.join('\n');
}

/** Replace (or insert) the single `**Summary:**` line. */
function setSummary(raw, value) {
  const parsed = parseBody(raw);
  const lines = parsed.lines.slice();
  if (parsed.summary) { lines[parsed.summary.idx] = summaryLine(value); return lines.join('\n'); }
  // Insert after the state block (after the last field line), with a blank line separator.
  let anchor = parsed.titleIdx;
  for (const fname of Object.keys(parsed.fields)) anchor = Math.max(anchor, parsed.fields[fname].idx);
  lines.splice(anchor + 1, 0, '', summaryLine(value));
  return lines.join('\n');
}

/** Replace (or insert) the single `**Context:**` line. */
function setContext(raw, value) {
  const parsed = parseBody(raw);
  const lines = parsed.lines.slice();
  if (parsed.context) { lines[parsed.context.idx] = contextLine(value); return lines.join('\n'); }
  let anchor = parsed.summary ? parsed.summary.idx : parsed.titleIdx;
  for (const fname of Object.keys(parsed.fields)) if (!parsed.summary) anchor = Math.max(anchor, parsed.fields[fname].idx);
  lines.splice(anchor + 1, 0, '', contextLine(value));
  return lines.join('\n');
}

/**
 * Replace the ENTIRE subtasks block (header + its checkbox lines) with a fresh canonical block.
 * Used by `edit` when the payload supplies subtasks. Letters are re-derived A, B, C… in order.
 * Unmanaged prose outside the block is untouched.
 */
function setSubtasks(raw, subtaskTexts) {
  const parsed = parseBody(raw);
  const lines = parsed.lines.slice();

  // Collect the line indices owned by the current subtasks block (header + checkbox lines).
  const owned = new Set();
  if (parsed.subtasks) {
    if (parsed.subtasks.headerIdx !== -1) owned.add(parsed.subtasks.headerIdx);
    for (const it of parsed.subtasks.items) owned.add(it.idx);
  }

  const block = [];
  if (subtaskTexts && subtaskTexts.length) {
    block.push('**Subtasks:**');
    subtaskTexts.forEach((t, i) => block.push(checkboxLine(String.fromCharCode(65 + i), false, t)));
  }

  if (owned.size === 0) {
    // No existing block: append at end (with a blank separator) if we have subtasks.
    if (block.length) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(...block);
    }
    return lines.join('\n');
  }

  // Replace the contiguous span from the block's first to last owned line with the new block.
  const ownedIdx = [...owned].sort((a, b) => a - b);
  const first = ownedIdx[0];
  const last = ownedIdx[ownedIdx.length - 1];
  lines.splice(first, last - first + 1, ...block);
  return lines.join('\n');
}

/**
 * Tick (or untick) the subtask with the given letter, IN PLACE. Returns
 * { raw, existed, changed }: existed=false if no such letter; changed=false if already in state.
 */
function setSubtaskChecked(raw, letter, checked = true) {
  const parsed = parseBody(raw);
  const target = parsed.subtasks && parsed.subtasks.items.find((it) => it.letter === letter.toUpperCase());
  if (!target) return { raw, existed: false, changed: false };
  if (target.checked === checked) return { raw, existed: true, changed: false };
  const lines = parsed.lines.slice();
  lines[target.idx] = checkboxLine(target.letter, checked, target.text);
  return { raw: lines.join('\n'), existed: true, changed: true };
}

/**
 * Normalize-on-write: collapse a hand-DUPLICATED managed state-block field line to its single
 * canonical (FIRST) occurrence. A human who hand-adds a second `- **State:**` line leaves a
 * stale duplicate: parse authoritatively reads the FIRST, so every later duplicate of the SAME
 * field is dead weight the tool should drop when it next writes the body. Keeps the first line
 * exactly in place; removes only later duplicates.
 *
 * SCOPED TO THE CONTIGUOUS MANAGED STATE BLOCK ONLY — never a free scan of the whole body.
 *   The managed state block is the contiguous run of `- **Label:** value` field lines at the TOP
 *   of the body (right after the `# #N · headline` title; blank lines before the run tolerated),
 *   ending at the first blank / non-managed-field line. Dedupe repeated managed single-value
 *   fields (State/Created/Started/Ended/End action/Reopened) ONLY within that block.
 *
 *   A `- **Label:**`-looking bullet that appears AFTER the block — in unmanaged prose, a
 *   `## Notes` section, a blockquote — is UNMANAGED and is left BYTE-INTACT. This is the SAME
 *   block-scoping discipline that fixed BUG-2 for the subtasks checkbox block: a whole-body scan
 *   would silently DELETE such a prose line (e.g. a human writing `- **State:** of the art` under
 *   `## Notes`) on the next mutating write — a NEW data-loss path violating the G1 no-data-loss
 *   constraint. The block never contains the `**Summary:**`/`**Context:**` lines or the
 *   `**Subtasks:**` checkbox block, so those are never touched here either. This is a no-op on any
 *   body without a duplicated in-block field (returns the input unchanged), so it is safe to run
 *   on every write.
 */
function dedupeManagedFields(raw) {
  const lines = raw.split('\n');
  const parsed = parseBody(raw);
  if (parsed.titleIdx === -1) return raw; // no title landmark -> no state block to scope to
  let i = parsed.titleIdx + 1;
  while (i < lines.length && lines[i].trim() === '') i += 1; // tolerate blanks before the block
  const seen = new Set();
  const drop = new Set();
  for (; i < lines.length; i += 1) {
    const fm = FIELD_RE.exec(lines[i]);
    if (!fm) break; // first blank / non-managed-field line ENDS the contiguous state block
    const key = canonField(fm[1]);
    if (seen.has(key)) drop.add(i); else seen.add(key);
  }
  if (drop.size === 0) return raw;
  return lines.filter((_, idx) => !drop.has(idx)).join('\n');
}

// ── Fresh-body author (render-from-struct — NEW bodies only, no prose to preserve) ──
function buildBody(spec) {
  const {
    number, headline, state = 'open', created,
    started, ended, endAction, reopened,
    summary, context, subtasks,
  } = spec;

  const parts = [titleLine(number, headline), ''];
  parts.push(fieldLine('State', state));
  parts.push(fieldLine('Created', created));
  if (started) parts.push(fieldLine('Started', started));
  if (ended) parts.push(fieldLine('Ended', ended));
  if (endAction) parts.push(fieldLine('End action', endAction));
  if (reopened) parts.push(fieldLine('Reopened', reopened));

  if (summary) parts.push('', summaryLine(summary));
  if (context) parts.push('', contextLine(context));

  if (subtasks && subtasks.length) {
    parts.push('', '**Subtasks:**');
    subtasks.forEach((s, i) => {
      // s may be a string, or { text, checked }
      const text = typeof s === 'string' ? s : s.text;
      const checked = typeof s === 'string' ? false : Boolean(s.checked);
      parts.push(checkboxLine(String.fromCharCode(65 + i), checked, text));
    });
  }

  return `${parts.join('\n')}\n`;
}

// ── Index parse/render ────────────────────────────────────────────────────────
function parseIndex(raw) {
  const out = { title: null, nextId: null, rows: [] };
  const lines = raw.split('\n');
  for (const line of lines) {
    if (out.title === null && /^#\s+/.test(line)) { out.title = line.replace(/^#\s+/, '').trim(); continue; }
    const nm = NEXT_ID_RE.exec(line);
    if (nm) { out.nextId = parseInt(nm[1], 10); continue; }
    const rm = INDEX_ROW_RE.exec(line);
    if (rm) {
      const cells = rm[1].split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const numCell = cells[0].replace(/^#/, '').trim();
      if (!/^\d+$/.test(numCell)) continue; // header / separator / non-data row
      out.rows.push({
        num: parseInt(numCell, 10),
        state: cells[1],
        created: cells[2],
        task: cells.slice(3).join(' | ').trim(),
      });
    }
  }
  return out;
}

function renderIndex(spec) {
  const { title, nextId = null, rows = [], includeNextId = false } = spec;
  const parts = [`# ${title}`];
  if (includeNextId) parts.push(`**Next ID:** ${nextId}`);
  parts.push('');
  parts.push('| #    | State       | Created    | Task |');
  parts.push('|------|-------------|------------|------|');
  for (const r of rows) {
    parts.push(`| ${r.num} | ${r.state} | ${r.created} | ${r.task} |`);
  }
  return `${parts.join('\n')}\n`;
}

// Append ONE lettered subtask, preserving every existing subtask AND its check state (unlike
// setSubtasks, which replaces the whole block and re-derives unchecked letters). The new letter is
// max(existing) + 1 (so it never collides even if letters have a gap). Creates the **Subtasks:** block
// if none exists. This is what `tpm-task add-subtask` uses so a `(3/8)` epic keeps its 3 checked.
function appendSubtask(raw, text) {
  const parsed = parseBody(raw);
  const lines = parsed.lines.slice();
  const items = (parsed.subtasks && parsed.subtasks.items) || [];
  let maxIdx = -1;
  for (const it of items) maxIdx = Math.max(maxIdx, it.letter.charCodeAt(0) - 65);
  const newLine = checkboxLine(String.fromCharCode(65 + maxIdx + 1), false, text);

  if (parsed.subtasks && (parsed.subtasks.headerIdx !== -1 || items.length)) {
    // Existing block: splice the new line in AFTER the last owned line (header or last item) — every
    // existing checkbox line (and its [x]/[ ] state) is left untouched.
    let lastOwned = parsed.subtasks.headerIdx;
    for (const it of items) if (it.idx > lastOwned) lastOwned = it.idx;
    lines.splice(lastOwned + 1, 0, newLine);
    return lines.join('\n');
  }
  // No block yet: append a fresh **Subtasks:** header + this first item at the end.
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.push('**Subtasks:**', newLine);
  return lines.join('\n');
}

// Non-blank payload lines NOT consumed into any managed field (title / State-block / **Summary:** /
// **Context:** / **Subtasks:** + checkboxes). On add/import these are SILENTLY DROPPED (buildBody
// rebuilds from managed fields only) — this lets the caller WARN instead. E.g. a `## Notes` heading and
// its prose come back here (the exact thing that silently ate 63 task bodies, 2026-09-01).
function unmanagedLines(raw) {
  const p = parseBody(raw);
  const managed = new Set();
  // Title: parseBody only sets titleIdx for the stored `# #<id> · …` SIGIL form. An author payload uses
  // a bare `# <headline>` (no sigil), so also treat the first `# ` heading as the (managed) title.
  if (p.titleIdx >= 0) managed.add(p.titleIdx);
  else { const h1 = p.lines.findIndex((l) => /^#\s+/.test(l)); if (h1 >= 0) managed.add(h1); }
  if (p.summary) managed.add(p.summary.idx);
  if (p.context) managed.add(p.context.idx);
  for (const k of Object.keys(p.fields)) managed.add(p.fields[k].idx);
  if (p.subtasks) {
    if (p.subtasks.headerIdx >= 0) managed.add(p.subtasks.headerIdx);
    for (const it of p.subtasks.items) managed.add(it.idx);
  }
  const dropped = [];
  p.lines.forEach((line, i) => {
    if (managed.has(i) || line.trim() === '') return;
    dropped.push({ idx: i, text: line });
  });
  return dropped;
}

module.exports = {
  STATES,
  FIELD_ORDER,
  TITLE_RE,
  FIELD_RE,
  CHECKBOX_RE,
  NEXT_ID_RE,
  INDEX_ROW_RE,
  parseBody,
  subtaskProgress,
  setField,
  removeField,
  getField,
  setHeadline,
  setSummary,
  setContext,
  setSubtasks,
  appendSubtask,
  unmanagedLines,
  setSubtaskChecked,
  dedupeManagedFields,
  buildBody,
  parseIndex,
  renderIndex,
  fieldLine,
  titleLine,
};
