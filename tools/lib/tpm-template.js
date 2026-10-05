'use strict';
/**
 * tpm-template.js — the claude-tpm skill TEMPLATE ENGINE (#1155, engine half).
 *
 * PURPOSE
 *   Compose a skill body from a small template + the resolved claude-tpm config, so a skill ships a tiny
 *   skeleton and the module/flag-specific prose is cut (not merely relocated) before the model reads it.
 *   The vocabulary is FROZEN and tiny (see DIRECTIVES): whole-line HTML-comment directives only.
 *
 *     <!-- tpm:if FLAG -->  /  <!-- tpm:if !FLAG -->   open a region (dotted config path; NO else/exprs)
 *     <!-- tpm:endif -->                               close the innermost region
 *     <!-- tpm:inject NAME -->                         insert caller-supplied slots[NAME] (never re-scanned)
 *     <!-- tpm:raw --> … <!-- tpm:endraw -->          lines between pass through LITERALLY
 *   A directive line is REMOVED from the output. Any other `tpm:NAME` line passes through + warns
 *   (forward-compat). An unresolved flag turns its region OFF (fail closed), even under `!`.
 *
 * GUARANTEES
 *   - render() is PURE (no writes, no env/cwd mutation, no stdout/stderr) and idempotent; it NEVER throws
 *     for a string input (TypeError only for a non-string template — a programmer error).
 *   - fail-safe: config trouble degrades (project -> shipped defaults -> empty config) with a visible
 *     banner; output is never emptied.
 *   - injected + raw text is never re-scanned (the injection-safety boundary).
 *
 * EXPORTS
 *   render(template, opts) / resolveConfig(opts) / scanTemplate(template) / lint(template, opts)
 *   DIRECTIVES, VOCAB_VERSION, WARNING_CODES, truthy
 *
 * Zero third-party deps; Node built-ins + ./tpm-config-overlay + ./paths only. `node tpm-template.js` = self-check.
 */

const overlay = require('./tpm-config-overlay');
const { findRoot } = require('./paths');

const DIRECTIVES = Object.freeze(['if', 'endif', 'inject', 'raw', 'endraw']);
const VOCAB_VERSION = 1;

// Stable warning / lint codes (tests assert on these strings). `bad-inject` is an additive code beyond the
// planner's list: an `inject` marker with a missing/invalid slot name.
const WARNING_CODES = Object.freeze([
  'unknown-directive', 'inline-directive', 'unresolved-flag', 'unknown-slot', 'unterminated-raw',
  'stray-endraw', 'stray-endif', 'unclosed-if', 'bad-if', 'bad-flag', 'bad-inject', 'unknown-flag',
]);

// Lint severity: anything not listed here is an error.
const LINT_WARNING_CODES = new Set(['unknown-directive', 'inline-directive']);

const DIRECTIVE_RE = /^[ \t]*<!--\s*tpm:([a-z][a-z0-9-]*)(?:\s+(.*?))?\s*-->[ \t]*$/;
const INLINE_RE = /<!--\s*tpm:[a-z]/;
const SLOT_RE = /^[a-z][a-z0-9-]*$/;
// FLAG grammar: dotted segments, each `name` or `name[i]`.
const FLAG_RE = /^[A-Za-z_$][\w$-]*(?:\[\d+\])?(?:\.[A-Za-z_$][\w$-]*(?:\[\d+\])?)*$/;

/** Truthiness table: ON iff true / non-empty string / finite non-zero number / non-empty array / non-empty object. */
function truthy(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

function normalize(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Parse an `if` argument. Returns { ok, negated, flag } or { ok:false, code, message }.
 */
function parseIfArg(arg) {
  if (arg === undefined || arg === null || arg.trim() === '') {
    return { ok: false, code: 'bad-if', message: 'tpm:if needs a flag (e.g. "tpm:if tasks.enabled")' };
  }
  const a = arg.trim();
  // operators / expressions / extra tokens are not part of the frozen vocabulary
  if (/\s/.test(a) || /[=&|<>()]/.test(a) || a.indexOf('!', 1) !== -1 || a === '!' || a.startsWith('!!')) {
    return { ok: false, code: 'bad-if', message: `tpm:if takes ONE flag, optionally prefixed with "!" — no else/expressions/comparisons (got "${a}")` };
  }
  const negated = a.startsWith('!');
  const flag = negated ? a.slice(1) : a;
  if (flag === '') return { ok: false, code: 'bad-if', message: 'tpm:if needs a flag after "!"' };
  if (/\[\+\]/.test(flag)) {
    return { ok: false, code: 'bad-flag', message: `flag "${flag}" uses "[+]" (append) — not valid in a read path` };
  }
  if (!FLAG_RE.test(flag)) {
    return { ok: false, code: 'bad-flag', message: `flag "${flag}" is not a dotted config path` };
  }
  return { ok: true, negated, flag };
}

/**
 * The single-pass line scanner shared by render and scanTemplate.
 *   ctx.scan        true => static analysis only (everything counts as kept; no flag/slot resolution)
 *   ctx.config      resolved config object (render)
 *   ctx.slots       slot map (render)
 *   ctx.explain     fill regions
 */
function core(template, ctx) {
  const scan = !!ctx.scan;
  const config = ctx.config || {};
  const slots = ctx.slots || {};
  const norm = normalize(template);
  const lines = norm.split('\n');
  let trailing = false;
  if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); trailing = true; }

  const warnings = [];
  const flags = [];
  const regions = [];
  const injects = [];
  let raws = 0;
  const out = [];
  const warn = (code, line, message) => warnings.push({ code, line, message });
  const addRegion = (r) => { if (ctx.explain) regions.push(r); return r; };

  const stack = []; // { kept, region, line }
  const parentKept = () => (stack.length === 0 ? true : stack[stack.length - 1].kept);
  let nextId = 1;
  let raw = null; // { emit, region, startLine }

  for (let i = 0; i < lines.length; i += 1) {
    const ln = i + 1;
    const line = lines[i];

    // ── inside a raw fence: only `tpm:endraw` is recognised ──
    if (raw) {
      const m = line.indexOf('tpm:') !== -1 && line.indexOf('-->') !== -1 ? DIRECTIVE_RE.exec(line) : null;
      if (m && m[1] === 'endraw') {
        if (raw.region) raw.region.endLine = ln;
        raw = null;
      } else if (raw.emit) {
        out.push(line);
      }
      continue;
    }

    let m = null;
    if (line.indexOf('tpm:') !== -1 && line.indexOf('-->') !== -1) {
      m = DIRECTIVE_RE.exec(line);
      if (m && m[2] !== undefined && m[2].indexOf('-->') !== -1) m = null; // two comments on one line
    }

    if (!m) {
      if (INLINE_RE.test(line)) {
        warn('inline-directive', ln, 'a tpm: comment must be alone on its line to be a directive; emitted literally');
      }
      if (parentKept()) out.push(line);
      continue;
    }

    const name = m[1];
    const arg = m[2];
    const pk = parentKept();

    if (name === 'if') {
      const p = parseIfArg(arg);
      let kept = false;
      let region = null;
      if (!p.ok) {
        warn(p.code, ln, p.message);
        region = addRegion({
          id: nextId++, kind: 'if', expr: (arg || '').trim(), flag: null, negated: false, value: undefined,
          resolved: false, kept: false, reason: pk ? 'flag-off' : 'parent-off', startLine: ln, endLine: ln, depth: stack.length,
        });
      } else {
        let resolved = false;
        let value;
        let on = false;
        if (scan) {
          flags.push({ flag: p.flag, negated: p.negated, line: ln });
          kept = true;
        } else {
          let got;
          try { got = overlay.getAtPath(config, p.flag); } catch (_e) { got = { found: false, value: undefined }; }
          resolved = got.found;
          value = got.value;
          if (resolved) on = p.negated ? !truthy(value) : truthy(value);
          else warn('unresolved-flag', ln, `flag "${p.flag}" is not set in the resolved config; region is OFF`);
          flags.push({ flag: p.flag, negated: p.negated, line: ln, resolved, value, on });
          kept = pk && on;
        }
        region = addRegion({
          id: nextId++, kind: 'if', expr: (p.negated ? '!' : '') + p.flag, flag: p.flag, negated: p.negated, value,
          resolved, kept, reason: !pk ? 'parent-off' : (!resolved ? 'unresolved' : (on ? 'flag-on' : 'flag-off')),
          startLine: ln, endLine: ln, depth: stack.length,
        });
      }
      stack.push({ kept: scan ? true : (pk && kept), region });
      continue;
    }

    if (name === 'endif') {
      if (stack.length === 0) {
        warn('stray-endif', ln, 'tpm:endif without a matching tpm:if; emitted literally');
        out.push(line);
      } else {
        const top = stack.pop();
        if (top.region) top.region.endLine = ln;
      }
      continue;
    }

    if (name === 'inject') {
      const slot = (arg || '').trim();
      if (!SLOT_RE.test(slot)) {
        warn('bad-inject', ln, `tpm:inject needs a slot name matching [a-z][a-z0-9-]* (got "${slot}")`);
        continue;
      }
      injects.push(slot);
      if (scan) continue;
      if (!pk) {
        addRegion({ id: nextId++, kind: 'inject', expr: slot, flag: null, negated: false, value: undefined, resolved: true, kept: false, reason: 'parent-off', startLine: ln, endLine: ln, depth: stack.length });
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(slots, slot)) {
        warn('unknown-slot', ln, `no slot named "${slot}" was supplied; marker removed`);
        addRegion({ id: nextId++, kind: 'inject', expr: slot, flag: null, negated: false, value: undefined, resolved: false, kept: false, reason: 'unknown-slot', startLine: ln, endLine: ln, depth: stack.length });
        continue;
      }
      let v = slots[slot];
      if (Array.isArray(v)) v = v.map(String).join('\n');
      v = v === undefined || v === null ? '' : String(v);
      if (v === '') {
        addRegion({ id: nextId++, kind: 'inject', expr: slot, flag: null, negated: false, value: '', resolved: true, kept: false, reason: 'empty', startLine: ln, endLine: ln, depth: stack.length });
        continue;
      }
      // injected text is NEVER re-scanned: push as one opaque chunk (normalised newlines, trailing newline trimmed
      // here and re-added by the join).
      out.push(normalize(v).replace(/\n$/, ''));
      addRegion({ id: nextId++, kind: 'inject', expr: slot, flag: null, negated: false, value: v, resolved: true, kept: true, reason: 'filled', startLine: ln, endLine: ln, depth: stack.length });
      continue;
    }

    if (name === 'raw') {
      raws += 1;
      const region = addRegion({
        id: nextId++, kind: 'raw', expr: 'raw', flag: null, negated: false, value: undefined, resolved: true,
        kept: scan ? true : pk, reason: pk ? 'filled' : 'parent-off', startLine: ln, endLine: ln, depth: stack.length,
      });
      raw = { emit: scan ? false : pk, region, startLine: ln };
      continue;
    }

    if (name === 'endraw') {
      warn('stray-endraw', ln, 'tpm:endraw without a matching tpm:raw; emitted literally');
      if (pk) out.push(line);
      continue;
    }

    // unknown tpm:NAME — forward-compat pass-through (never deleted)
    warn('unknown-directive', ln, `unknown directive "tpm:${name}"; emitted literally`);
    if (pk) out.push(line);
  }

  if (raw) {
    warn('unterminated-raw', raw.startLine, 'tpm:raw has no tpm:endraw; the rest of the file was treated as literal');
    if (raw.region) raw.region.endLine = lines.length;
  }
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const s = stack[k];
    if (s.region) s.region.endLine = lines.length;
    warn('unclosed-if', s.region ? s.region.startLine : lines.length, 'tpm:if has no matching tpm:endif; region closed at end of file');
  }

  let text = out.join('\n');
  if (out.length > 0 && trailing) text += '\n';
  return { text, warnings, flags, regions, injects, raws };
}

/**
 * resolveConfig({projectRoot?, env?}) -> { config, degraded:false } | { config, degraded:true, reason, fallback }
 * Ladder: resolveLayers -> shipped defaults -> {}. Never throws.
 */
function resolveConfig(opts) {
  const o = opts || {};
  let root = o.projectRoot;
  try {
    if (!root) root = findRoot({ quiet: true });
    return { config: overlay.resolveLayers({ projectRoot: root, env: o.env || process.env }), degraded: false };
  } catch (err) {
    const reason = String((err && err.message) || err).replace(/\s+/g, ' ').trim();
    try {
      return { config: overlay.loadDefaults(), degraded: true, reason, fallback: 'defaults' };
    } catch (err2) {
      return { config: {}, degraded: true, reason: `${reason}; ${String((err2 && err2.message) || err2).replace(/\s+/g, ' ').trim()}`, fallback: 'empty' };
    }
  }
}

function bannerFor(reason, fallback) {
  const r = String(reason || 'unknown').replace(/\s+/g, ' ').trim();
  const what = fallback === 'defaults' ? 'shipped defaults' : 'no config';
  return `> WARNING: tpm degraded config (${r}) — rendered with ${what}. Run \`tpm doctor\` to diagnose.`;
}

/** render(template, opts) -> { text, degraded, degradedReason, warnings, flags, regions }. Never throws (TypeError on non-string). */
function render(template, opts) {
  if (typeof template !== 'string') throw new TypeError('render: template must be a string');
  const o = opts || {};
  let resolved;
  if (o.config !== undefined && o.config !== null) {
    resolved = (typeof o.config === 'object' && !Array.isArray(o.config))
      ? { config: o.config, degraded: false }
      : { config: {}, degraded: true, reason: 'supplied config is not an object', fallback: 'empty' };
  } else {
    resolved = resolveConfig({ projectRoot: o.projectRoot, env: o.env });
  }

  let r;
  try {
    r = core(template, { config: resolved.config, slots: o.slots, explain: !!o.explain });
  } catch (err) {
    // belt and braces: an internal fault must not lose the prose.
    const reason = `template engine fault: ${String((err && err.message) || err)}`;
    const text = normalize(template);
    const banner = o.banner === false || text === '' ? '' : `${bannerFor(reason, 'empty')}\n\n`;
    return { text: banner + text, degraded: true, degradedReason: reason, warnings: [], flags: [], regions: [] };
  }

  let text = r.text;
  if (resolved.degraded && o.banner !== false && template !== '') {
    text = `${bannerFor(resolved.reason, resolved.fallback)}\n\n${text}`;
  }
  return {
    text,
    degraded: !!resolved.degraded,
    degradedReason: resolved.degraded ? resolved.reason : null,
    warnings: r.warnings,
    flags: r.flags,
    regions: r.regions,
  };
}

function withSeverity(w) {
  return { code: w.code, line: w.line, message: w.message, severity: LINT_WARNING_CODES.has(w.code) ? 'warning' : 'error' };
}

/** scanTemplate(template) -> { flags, injects, raws, issues } — static; no config. Raw-aware. */
function scanTemplate(template) {
  if (typeof template !== 'string') throw new TypeError('scanTemplate: template must be a string');
  const r = core(template, { scan: true });
  return { flags: r.flags, injects: r.injects, raws: r.raws, issues: r.warnings.map(withSeverity) };
}

/** lint(template, {defaults?}) -> Issue[] — scan issues + `unknown-flag` against defaults.json (the flag registry). */
function lint(template, opts) {
  const s = scanTemplate(template);
  const issues = s.issues.slice();
  let defaults = opts && opts.defaults;
  if (!defaults) {
    try { defaults = overlay.loadDefaults(); } catch (_e) { defaults = null; }
  }
  if (defaults) {
    const seen = new Set();
    for (const f of s.flags) {
      let found = false;
      try { found = overlay.getAtPath(defaults, f.flag).found; } catch (_e) { found = false; }
      const key = `${f.flag}@${f.line}`;
      if (!found && !seen.has(key)) {
        seen.add(key);
        issues.push({ code: 'unknown-flag', line: f.line, message: `flag "${f.flag}" is not in defaults.json (the flag registry)`, severity: 'error' });
      }
    }
  }
  issues.sort((a, b) => a.line - b.line);
  return issues;
}

module.exports = { render, resolveConfig, scanTemplate, lint, truthy, DIRECTIVES, VOCAB_VERSION, WARNING_CODES };

if (require.main === module) {
  const r = render('<!-- tpm:if a.b -->\nyes\n<!-- tpm:endif -->\n', { config: { a: { b: true } } });
  process.stdout.write(`tpm-template OK — render self-check: ${JSON.stringify(r.text)}\n`);
}
