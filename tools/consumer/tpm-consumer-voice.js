#!/usr/bin/env node
/**
 * tpm-consumer-voice.js — EVERY user-facing string of the installer / doctor, as a function of State/Action.
 *
 * Spec: dev/20261001-installer-updates/installer-repl-voice.md (§2 vocabulary + never-print list, §3 skeleton,
 * §4 screens, §5 prose rules, §7 the hook-to-Claude voice). One file so the voice can be reviewed — and its
 * wording pinned by tests — in one place. Pure: no I/O, no process state except $HOME (for `~`).
 *
 * Inputs are the State from tpm-consumer-observe.js and plain Action objects (the shape phase 02 builds):
 *   Action = { id, commands?: string[]   // display lines WITHOUT the "$ " (the voice adds it)
 *              variant?, saveDev?, folder?, oldVersion?, newVersion?, ownCopy?, otherId? }
 *   ids: repoint · register · dep · plugin-install · plugin-enable · disable-old · config-seed
 *
 * NEVER-PRINT (voice §2): marketplace, row, registry, record, cache, cache-miss, scope, symlink, realpath,
 * canonical, bundle, manifest, hook (unless broken: `hooks/hooks.json`), stamp, spawn, probe, preflight,
 * idempotent, legitimate, "step N/5". `findNeverPrint(text)` is the enforcement; commands (`$ …` lines,
 * which legitimately carry `claude plugin marketplace …`) are exempt because users are entitled to see
 * exactly what runs. `sampleAll(state)` renders every renderer for a State so a test can grep them all.
 */
'use strict';

const os = require('os');
const path = require('path');

const MARK = { pass: '✓', warn: '⚠', fail: '✗', info: '·', skip: '·' };

// ── primitives ───────────────────────────────────────────────────────────────────────────────────────

/** `~`-shorten a path (HOME at call time). null/'' → ''. */
function tilde(p) {
  if (!p) return '';
  const home = process.env.HOME || os.homedir();
  if (home && (p === home || p.indexOf(home + path.sep) === 0)) return '~' + p.slice(home.length);
  return p;
}
function ver(v) { return v ? `claude-tpm ${v}` : 'claude-tpm'; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }
function shellQuote(a) { return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`; }
/** A command as one display line (quotes only what needs it). */
function displayCommand(bin, argv) { return [bin].concat(argv).map(shellQuote).join(' '); }
function projectName(state) { return tilde(state.target.dir); }
function ind(n, text) { return String(text).split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n'); }
function cmdLines(action, n) { return (action.commands || []).map((c) => `${' '.repeat(n)}$ ${c}`); }

/**
 * Voice §3 width rule: nothing wider than 100 columns — a line that won't fit wraps at a word boundary with a
 * continuation indented 4 past the line's own indent. `$ command` lines and lines without spaces are left alone;
 * a backticked span is never split.
 */
const WIDTH = 100;
function fit(text, width) {
  const w = width || WIDTH;
  return String(text).split('\n').map((line) => {
    if (line.length <= w || /^\s*\$ /.test(line)) return line;
    const lead = /^\s*/.exec(line)[0];
    const tokens = line.slice(lead.length).match(/(?:`[^`]*`|\S)+/g) || [];
    const out = []; let cur = lead;
    tokens.forEach((t) => {
      const sep = cur.trim() === '' ? '' : ' ';
      if (cur.trim() !== '' && (cur + sep + t).length > w) { out.push(cur); cur = lead + '    ' + t; } else cur += sep + t;
    });
    out.push(cur);
    return out.join('\n');
  }).join('\n');
}

const NOTHING_CHANGED = '  Nothing was changed.';

// ── header / checking / diagnosis (§3, §4.3) ─────────────────────────────────────────────────────────

function header(state) {
  const s = state.self;
  const from = s.shape === 'this-project-copy' ? "this project's own copy in node_modules" : tilde(s.root);
  return fit(`${ver(s.version)} → ${projectName(state)}  (from ${from})`);
}

function checking(state) { return `Checking ${projectName(state)} …`; }

/** The one sentence per diagnosis label (design §4.3). ctx: {oldVersion, regFolder}. */
function diagnosisSentence(label, state, ctx) { return fit(diagnosisSentenceRaw(label, state, ctx)); }
function diagnosisSentenceRaw(label, state, ctx) {
  const c = ctx || {};
  const v = state.self.version;
  const old = c.oldVersion || state.projectVersion;
  switch (label) {
    case 'registered-elsewhere': return `${ver(v)} is already registered on this machine, from a different folder:`;
    case 'not-installed': return 'claude-tpm is not installed here.';
    case 'upgrade': return old ? `${ver(old)} is installed here. This is an upgrade to ${v}.` : `claude-tpm is installed here. This is an upgrade to ${v}.`;
    case 'broken': return `${ver(v)} is installed here but broken.`;
    case 'partial': return `${ver(v)} is partly installed here.`;
    case 'healthy': return `${ver(v)} is already installed in ${projectName(state)} and healthy — ${plural((c.checks || 0), 'check')} ok, nothing to do.`;
    case 'healthy-with-warnings': return `${ver(v)} is already installed in ${projectName(state)} — ${plural((c.checks || 0), 'check')} ok, ${plural((c.warnings || 0), 'warning')}; nothing to do.`;
    default: return '';
  }
}

/** `Checking ~/proj … <sentence>` first line + indented finding lines ({mark, text}). */
function checkingBlock(state, sentence, findings) {
  const out = [`${checking(state)} ${sentence}`];
  (findings || []).forEach((f) => out.push(`  ${MARK[f.mark] || f.mark} ${f.text}`));
  return fit(out.join('\n'));
}

// ── the rows (doctor table §4.9; also the findings under "Checking …") ───────────────────────────────

/** Each row → {label, mark: pass|warn|fail|skip, text, fix?}. Unknown layers (light mode / no claude) are 'skip'. */
function rowPackageJson(state) {
  const label = 'package.json'; const d = state.dep; const self = state.self;
  if (!state.target.pkg.exists) return { label, mark: 'fail', text: 'not found', fix: `run \`npm init -y\` in ${projectName(state)}, then \`tpm install .\`` };
  if (!state.target.pkg.valid) return { label, mark: 'fail', text: `is not valid JSON: ${state.target.pkg.err}`, fix: 'fix the JSON, then run `npx tpm doctor .` again' };
  if (d.onDisk === 'dangling') return { label, mark: 'fail', text: 'the link in node_modules is dangling (its folder is gone)', fix: 'run `tpm install .` from the live claude-tpm folder' };
  if (!d.declared) return { label, mark: 'fail', text: 'claude-tpm is not in package.json', fix: 'run `tpm install .` from the claude-tpm folder' };
  if (d.onDisk === 'absent') return { label, mark: 'fail', text: 'claude-tpm is in package.json but not installed in node_modules', fix: 'run `npm install`, or `tpm install .` from the claude-tpm folder' };
  if (d.version && self.version && d.version !== self.version) {
    const where = d.linksTo ? ` (${tilde(d.linksTo)})` : '';
    return { label, mark: 'warn', text: `points at ${ver(d.version)}${where} — this project would run the old version from npx`, fix: 'run `tpm install .` to upgrade' };
  }
  const how = d.onDisk === 'link' ? `links to ${tilde(d.linksTo)}` : 'a copy inside this project';
  return { label, mark: 'pass', text: `${ver(d.version || self.version)}, ${how}` };
}

function rowRegistered(state) {
  const label = 'registered'; const r = state.reg; const v = state.self.version;
  switch (r.state) {
    case 'unknown': return { label, mark: 'skip', text: 'not checked' };
    case 'absent': return { label, mark: 'fail', text: `${ver(v)} is not registered with Claude Code`, fix: 'run `tpm install .`' };
    case 'dead': return { label, mark: 'fail', text: `registered from ${tilde(r.storedPath)}, and that folder is gone (moved or deleted)`, fix: 'run `tpm install .` from the live claude-tpm folder to re-point' };
    case 'github': return { label, mark: 'warn', text: 'registered from a GitHub source, not a local folder', fix: 'run `tpm install . --repoint` to register this folder instead' };
    case 'elsewhere': {
      const what = r.where === 'other-project-copy' ? 'a copy inside another project' : r.where === 'this-project-copy' ? "this project's own copy" : 'a standalone folder';
      return { label, mark: 'warn', text: `registered from ${tilde(r.realPath)} (${what}), not from ${tilde(state.self.root)}`, fix: 'run `tpm install . --repoint` to register this folder instead' };
    }
    case 'same-via-link': return { label, mark: 'warn', text: `registered through a link (${tilde(r.storedPath)} → ${tilde(r.realPath)}); it breaks if the link is removed`, fix: 'register the real folder: `tpm install . --repoint`' };
    default: return { label, mark: 'pass', text: `${ver(r.version || v)} from ${tilde(r.realPath)}` };
  }
}

function rowTurnedOn(state) {
  const label = 'turned on'; const e = state.en; const proj = projectName(state);
  if (e.record === 'unknown') {
    if (state.mode === 'light') return e.enabledHere ? { label, mark: 'pass', text: `for ${proj}` } : { label, mark: 'fail', text: `not turned on for ${proj}`, fix: 'run `tpm install .`' };
    return { label, mark: 'skip', text: 'not checked' };
  }
  if (!e.record.present) {
    if (e.loadsWithoutRecord) return { label, mark: 'warn', text: `turned on for ${proj}, but Claude Code has lost its note that the plugin is installed here`, fix: 'run `tpm install .` to restore it' };
    return { label, mark: 'fail', text: `not turned on for ${proj}`, fix: 'run `tpm install .`' };
  }
  if (!e.record.enabled) return { label, mark: 'fail', text: `installed but switched off for ${proj}`, fix: 'run `tpm install .`' };
  if (e.record.installPathExists === false) return { label, mark: 'fail', text: `turned on for ${proj}, but the folder Claude Code recorded for it is gone`, fix: 'run `tpm install .`' };
  if (e.otherIds.length) {
    const vs = e.otherVersions.map((o) => o.version || 'another version');
    return { label, mark: 'warn', text: `two versions are turned on here (${vs.join(', ')} and ${state.self.version}) — Claude Code uses the first and ignores the other`, fix: 'run `tpm install .` to turn the old one off' };
  }
  return { label, mark: 'pass', text: `for ${proj}` };
}

function rowProjectFolder(state) {
  const label = 'project folder'; const m = state.marker;
  if (!m.dir) return { label, mark: 'fail', text: '.claude/claude-tpm/ is missing — the task and session tools refuse to run without it', fix: 'run `tpm install .`' };
  if (m.config === 'invalid') return { label, mark: 'fail', text: `.claude/claude-tpm/config.json is not valid JSON: ${m.err}`, fix: 'fix or delete .claude/claude-tpm/config.json, then run `tpm install .`' };
  return { label, mark: 'pass', text: m.config === 'valid' ? '.claude/claude-tpm/ present, config.json valid' : '.claude/claude-tpm/ present' };
}

function rowClaudeTpmFolder(state) {
  const label = 'claude-tpm folder'; const s = state.self;
  if (!s.root) return { label, mark: 'fail', text: 'could not locate the claude-tpm folder', fix: 'reinstall claude-tpm' };
  if (!s.stampOk) return { label, mark: 'fail', text: `mislabelled — its version (${s.version}) and its registration name (${s.name}) disagree; a packaging problem in claude-tpm`, fix: 'reinstall claude-tpm from a clean source' };
  if (!s.complete) return { label, mark: 'fail', text: s.hooks && s.hooks.err ? 'incomplete — hooks/hooks.json is not valid JSON' : 'incomplete — missing hooks/hooks.json', fix: 'reinstall claude-tpm; this checkout is broken' };
  return { label, mark: 'pass', text: `complete (${s.version})` };
}

function rowClaude(state) {
  const label = 'claude'; const e = state.env;
  if (e.claudeOnPath === null) return { label, mark: 'skip', text: 'not checked' };
  return e.claudeOnPath ? { label, mark: 'pass', text: 'found' } : { label, mark: 'fail', text: 'the claude command is not on PATH — install Claude Code first', fix: 'install Claude Code, then re-run' };
}

/** In-session rows (only when state.env.inSession); null otherwise. */
function rowTpmOnPath(state) {
  const e = state.env; if (!e.inSession) return null;
  const label = 'tpm on PATH';
  if (!e.tpmOnPath) return { label, mark: 'warn', text: 'none found — start a new session, or use npx tpm', fix: 'start a new Claude Code session' };
  const ok = [state.self.root, state.reg && state.reg.realPath].filter(Boolean).some((d) => e.tpmOnPath.indexOf(d + path.sep) === 0);
  return ok ? { label, mark: 'pass', text: 'resolves to this folder' } : { label, mark: 'warn', text: `a different tpm shadows it: ${tilde(e.tpmOnPath)}`, fix: 'use `npx tpm`, or start a new session' };
}
function rowTpmHome(state) {
  const e = state.env; if (!e.inSession || !e.tpmHome) return null;
  const label = 'TPM_HOME';
  const same = path.resolve(e.tpmHome) === state.self.root;
  return same ? { label, mark: 'pass', text: 'this folder' } : { label, mark: 'warn', text: `set to ${tilde(e.tpmHome)}, but this doctor runs from ${tilde(state.self.root)} — start a new session`, fix: 'start a new Claude Code session' };
}

/** All rows in doctor order (nulls dropped). "Not installed at all" collapses to one row (S22). */
function doctorRows(state) {
  const rows = [rowPackageJson(state), rowRegistered(state), rowTurnedOn(state), rowProjectFolder(state),
    rowClaudeTpmFolder(state), rowClaude(state), rowTpmOnPath(state), rowTpmHome(state)].filter(Boolean);
  const nothing = !state.dep.declared && state.dep.onDisk === 'absent' && state.reg.state === 'absent' &&
    state.en.record && state.en.record.present === false && !state.en.enabledHere && !state.marker.dir;
  if (nothing) return [{ label: 'registered', mark: 'fail', text: 'claude-tpm is not installed here', fix: 'run `tpm install .`' }];
  return rows;
}

function renderRow(row) {
  const pad = row.label.length < 18 ? row.label + ' '.repeat(18 - row.label.length) : row.label + ' ';
  const base = `  ${MARK[row.mark]} ${pad}${row.text}`;
  return fit(row.fix && (row.mark === 'warn' || row.mark === 'fail') ? `${base}\n      fix: ${row.fix}` : base);
}

// ── refusals (§4.2; voice §5) ────────────────────────────────────────────────────────────────────────

function toolMissingReason(bin, errorCode) {
  const hint = bin === 'npm' ? 'install Node.js (it includes npm) first' : 'install Claude Code first';
  if (errorCode === 'ENOENT' || !errorCode) return `\`${bin}\` not found on PATH — ${hint}.`;
  if (errorCode === 'EACCES') return `\`${bin}\` found on PATH but not executable (EACCES) — is \`${bin}\` installed on THIS host?`;
  if (/^exited/.test(errorCode)) return `\`${bin}\` is on PATH but \`${bin} --version\` ${errorCode} — check the install.`;
  return `\`${bin}\` could not be run: ${errorCode}.`;
}

/** refusal = {id, detail} from preconditions(); → stderr text ending in "Nothing was changed.". */
function refusal(ref, state) {
  const d = ref.detail || {};
  let msg;
  switch (ref.id) {
    case 'tool-missing': msg = toolMissingReason(d.bin, d.errorCode); break;
    case 'no-package-json': msg = `${projectName(state)} has no package.json. Run \`npm init -y\` there first.`; break;
    case 'bad-package-json': msg = `${projectName(state)}/package.json is not valid JSON (${d.err}). Fix it first.`; break;
    case 'stamp': msg = `this claude-tpm folder is mislabelled (its version ${d.version} and its registration name ${d.actual} disagree) — a packaging problem in claude-tpm, not in your project.`; break;
    case 'other-project-copy': msg = `this claude-tpm is ${tilde(d.owner)}'s copy (${tilde(state.self.root)}).\n  Run the install from a standalone folder, or from inside ${projectName(state)} after npm-installing it there.`; break;
    case 'no-self': msg = 'could not locate the claude-tpm folder this installer belongs to.'; break;
    case 'incomplete': msg = `this claude-tpm folder is incomplete (${d.hooks && d.hooks.err ? 'hooks/hooks.json is not valid JSON' : 'missing hooks/hooks.json'}) — a broken checkout. Re-fetch claude-tpm.`; break;
    case 'non-tty': msg = 'stdin is not a terminal — pass `--quiet` to accept the plan without prompts.'; break;
    case 'self-folder': msg = 'this is the claude-tpm folder, not a project.'; break;
    default: msg = 'cannot continue.';
  }
  return `${fit(`error: not installing — ${msg}`)}\n${NOTHING_CHANGED}\n`;
}

/** `--quiet` with a would-be menu and no pre-answer (voice §4.6). */
function quietMenuRefusal(state) {
  const r = state.reg;
  const where = r.state === 'github' ? 'a GitHub source' : tilde(r.realPath);
  return `${fit(`error: not installing — ${ver(state.self.version)} is already registered from ${where}.`)}\n` +
    '  Re-run with --share to use that copy, or --repoint to register this folder instead.\n' + `${NOTHING_CHANGED}\n`;
}

// ── decision menu (§4.6) ─────────────────────────────────────────────────────────────────────────────

/** The "registered from a different folder" screen body. cmp: optional compare line text. */
function decisionMenu(state, cmp) {
  const r = state.reg; const v = state.self.version;
  const lines = [`${checking(state)} ${diagnosisSentence('registered-elsewhere', state)}`];
  const kind = { 'other-project-copy': '(a copy inside another project)', 'this-project-copy': "(this project's own copy)",
    standalone: '(a standalone folder)', github: '(not a local folder)' }[r.where] || '';
  lines.push(`    ${r.where === 'github' ? 'github:codercowboy/claude-tpm' : tilde(r.realPath)}   ${kind}`);
  if (cmp && r.where !== 'github') lines.push(`  Compared with this folder: ${cmp}.`);
  lines.push('');
  const owner = r.projectDir ? tilde(r.projectDir) : 'that project';
  const useText = {
    'other-project-copy': [`${projectName(state)} uses the copy in ${owner}. Nothing machine-wide changes, but if`, `${owner.replace(/^.*\//, '')} deletes its node_modules, claude-tpm stops working here too.`],
    'this-project-copy': [`${projectName(state)} keeps running its own copy; this folder is unused.`],
    standalone: [`${projectName(state)} links to and runs that folder; this folder is unused.`],
    github: ['use that source.'],
  }[r.where] || ['use the registered one.'];
  lines.push(`  1. use       ${useText[0]}`); useText.slice(1).forEach((t) => lines.push(`               ${t}`));
  lines.push('  2. re-point  Register this folder instead (re-point). Every project on ' + v + ' switches to this folder;',
    '               each should re-run `tpm install .` once to restore its own settings.');
  lines.push('  3. quit      Nothing was changed.');
  return fit(lines.join('\n'));
}
const MENU_PROMPT = 'Choose [1/2/3]: ';
const CONFIRM_PROMPT = 'Proceed? [y/N] ';

// ── plan (§4.5; voice §4) ────────────────────────────────────────────────────────────────────────────

function planProse(a, state) {
  const folder = tilde(a.folder || (state && state.self && state.self.root));
  const v = a.newVersion || (state && state.self.version);
  switch (a.id) {
    case 'repoint':
      return `Re-point ${ver(v)} at this folder (register ${folder} instead).\n` +
        '   Other projects on ' + v + ' start working again as soon as this runs; each should re-run\n' +
        '   `tpm install .` once to restore its own settings.';
    case 'register':
      return a.ownCopy ? "Register this project's copy of claude-tpm with Claude Code, once for this machine"
        : `Register ${folder} with Claude Code, once for this machine`;
    case 'dep':
      if (a.variant === 'upgrade') return `Point package.json at ${ver(v)} instead of ${a.oldVersion || 'the old version'} (replaces the node_modules copy)`;
      if (a.variant === 'dangling') return 'Point package.json at this folder (the old link is dangling)';
      return `Add claude-tpm to package.json as a ${a.saveDev === false ? '' : 'dev '}dependency, so \`npx tpm\` works in this project`;
    case 'plugin-install':
      if (a.variant === 'restore') return "Restore Claude Code's note that the plugin is installed here";
      if (a.variant === 'again') return 'Turn the plugin on for this project again';
      if (a.variant === 'upgrade') return `Turn the ${v} plugin on for this project`;
      return 'Turn the plugin on for this project (writes one line to .claude/settings.json)';
    case 'plugin-enable': return 'Turn the plugin on for this project (it is installed but switched off)';
    case 'disable-old':
      return `Turn the ${a.oldVersion || 'old'} plugin off for this project — with both on, Claude Code would keep using ${a.oldVersion || 'the old one'}`;
    case 'config-seed': return 'Write .claude/claude-tpm/config.json with the default task and session folders';
    default: return a.id;
  }
}

/** One numbered plan item: text line(s) + `$ command` lines. */
function planLine(n, a, state) {
  const prose = planProse(a, state).split('\n');
  const first = `  ${n}. ${prose[0]}`;
  const rest = prose.slice(1);
  const cmds = cmdLines(a, 7);
  return fit([first].concat(rest, cmds).join('\n'));
}

function planBlock(actions, state, extra) {
  const x = extra || {};
  const out = ['I will:'];
  actions.forEach((a, i) => out.push(planLine(i + 1, a, state)));
  (x.fine || []).forEach((t) => out.push(`  (${t})`));
  if (x.notTouched) out.push(`  Not touched: ${x.notTouched}`);
  (x.warnings || []).forEach((w) => out.push(w));
  return fit(out.join('\n'));
}

const ALREADY_REGISTERED = (state) => `${tilde(state.self.root)} is already registered — nothing to do there`;
function notTouched(oldVersion) { return `the ${oldVersion || 'old'} folder, its registration and other projects that use it.`; }
function fragilityWarning() {
  return '  ⚠ Registering a folder inside node_modules works, but `rm -rf node_modules` or a reinstall will break\n' +
    '    claude-tpm for this project until you run `tpm install .` again. A standalone folder avoids that\n' +
    '    (see docs/INSTALL.md, "Several projects").';
}
function twoTreesWarning(state) {
  return `  ⚠ ${projectName(state)} will run the copy in ${tilde(state.reg.projectDir || state.reg.realPath)} (see above).`;
}

// ── apply (§4.7) ─────────────────────────────────────────────────────────────────────────────────────

function applyLabel(a) { return { repoint: 're-pointed', register: 'registered', dep: 'package.json', 'plugin-install': 'turned on', 'plugin-enable': 'turned on', 'disable-old': 'turned off', 'config-seed': 'config.json' }[a.id] || a.id; }
function applyOk(a, state) {
  const label = applyLabel(a).padEnd(14);
  const proj = projectName(state); const folder = tilde(a.folder || state.self.root);
  const what = { repoint: folder, register: folder, dep: `node_modules/@codercowboy/claude-tpm links to ${folder}`,
    'plugin-install': `for ${proj}`, 'plugin-enable': `for ${proj}`, 'disable-old': `${a.oldVersion || 'old version'} for ${proj}`, 'config-seed': 'written' }[a.id] || 'done';
  return fit(`  ✓ ${label} ${what}`);
}
function applyFail(a, child) {
  const label = applyLabel(a).padEnd(14);
  const cmd = a.commands && a.commands[0] ? a.commands[0].replace(/^(\S+ \S+ \S+).*$/, '$1') : a.id;
  const err = String((child && child.stderr) || '').replace(/\s+$/, '');
  return `  ✗ ${label} \`${cmd}\` exited ${child && child.status != null ? child.status : 'abnormally'}:` + (err ? '\n' + ind(24, err) : '');
}
function stoppedAfter(n, m) { return `  Stopped after ${n} of ${m}. Re-running \`tpm install .\` picks up where this left off.`; }
function declined() { return NOTHING_CHANGED.slice(0); }

// ── closing (§4.8) + Next ────────────────────────────────────────────────────────────────────────────

/** ctx: {checks, warnings, failures, upgradedFrom}. */
function closing(state, ctx) {
  const c = ctx || {}; const proj = projectName(state); const v = ver(state.self.version);
  if (c.failures) return fit(`✗ The steps ran, but ${plural(c.failures, 'check')} still fail${c.failures === 1 ? 's' : ''} (see ✗ above). \`npx tpm doctor .\` shows the full list.`);
  const up = c.upgradedFrom ? ` (upgraded from ${c.upgradedFrom})` : '';
  const warn = c.warnings ? `, ${plural(c.warnings, 'warning')} (see ⚠ above)` : '';
  return fit(`✓ ${v} is installed in ${proj}${up} — ${plural(c.checks || 0, 'check')} ok${warn}.`);
}
function nextLine(state, ctx) {
  const proj = projectName(state);
  if (ctx && ctx.upgradedFrom) return fit(`  Next: start a new \`claude\` session in ${proj} to pick up the new version.`);
  return fit(`  Next: open \`claude\` in ${proj}; the /tpm-* commands are there from the first message. \`npx tpm doctor .\` re-checks later.`);
}
function doctorSummary(rows) {
  const f = rows.filter((r) => r.mark === 'fail').length; const w = rows.filter((r) => r.mark === 'warn').length;
  const ok = rows.filter((r) => r.mark === 'pass').length;
  if (!f && !w) return `✓ ${plural(ok, 'check')} ok.`;
  const parts = [`${plural(ok, 'check')} ok`];
  if (w) parts.push(plural(w, 'warning'));
  if (f) parts.push(plural(f, 'problem'));
  return `${f ? '✗' : '⚠'} ${parts.join(', ')}.`;
}

// ── the hook speaks to Claude (§7) ───────────────────────────────────────────────────────────────────

/** Problems visible to the file-only light observer. → [{kind, text}] */
function lightProblems(state) {
  const out = [];
  const running = (state.reg && state.reg.version) || state.self.version;
  if (state.dep.version && running && state.dep.version !== running) {
    out.push({ kind: 'version-skew', text: `package.json points at ${ver(state.dep.version)} but the running plugin is ${running}, so \`npx tpm\` runs the old version.` });
  }
  if (state.en.otherIds.length) {
    out.push({ kind: 'other-ids', text: `Another claude-tpm version is also turned on here (${state.en.otherIds.join(', ')}); Claude Code uses whichever is first.` });
  }
  if (!state.marker.dir) out.push({ kind: 'no-marker', text: '.claude/claude-tpm/ is missing, so the task and session tools will refuse to run.' });
  if (state.marker.config === 'invalid') out.push({ kind: 'bad-config', text: `.claude/claude-tpm/config.json is not valid JSON (${state.marker.err}). The task and session tools will refuse to run until it is fixed.` });
  return out;
}

/** '' when healthy (silent, zero tokens). Else ONE `[claude-tpm]` line addressed to Claude. */
function hookMessage(state) {
  const ps = lightProblems(state).slice(0, 3);
  if (!ps.length) return '';
  const onlyConfig = ps.length === 1 && ps[0].kind === 'bad-config';
  const tail = onlyConfig ? 'Tell the user; do not rewrite the file without asking.'
    : 'Tell the user and suggest `npx tpm install .` from a terminal. Do not edit files to fix this.';
  if (ps.length === 1) return `[claude-tpm] 1 problem in this project: ${ps[0].text} ${tail}`;
  const body = ps.map((p, i) => `(${i + 1}) ${p.text}`).join(' ');
  return `[claude-tpm] ${ps.length} problems in this project. ${body} ${tail}`;
}

// ── help (§4.10) ─────────────────────────────────────────────────────────────────────────────────────

function help() {
  return [
    'tpm install [dir] [options] — add claude-tpm to a project that already has a package.json',
    '',
    '  It checks the project, shows you the plan, and asks once before changing anything.',
    '  Safe to re-run: a healthy project is left alone.',
    '',
    '  [dir]          the project (default: the current folder)',
    '  --plan         show the plan and exit; change nothing',
    '  --quiet        accept the plan without prompting (for scripts; needed if stdin is not a terminal)',
    '  --save         add claude-tpm as a regular dependency (default: dev dependency)',
    '  --repoint      if claude-tpm is already registered from another folder, register this one instead',
    '  --share        if claude-tpm is already registered from another folder, use that one',
    '  --from <spec>  use this npm spec for the dependency instead of this folder',
    '  --debug        trace every command (also TPM_DEBUG=1)',
    '  -h, --help',
    '',
    '  tpm doctor [dir]   check a project without changing it (--verbose for every check)',
    '  tpm uninstall      remove claude-tpm from a project (or this machine)',
    '',
    '  More: docs/INSTALL.md in the claude-tpm folder.',
    '',
  ].join('\n');
}

// ── never-print enforcement (voice §2) ───────────────────────────────────────────────────────────────

const NEVER_PRINT = [
  ['marketplace', /\bmarketplaces?\b/i], ['row', /\brows?\b/i], ['registry', /\bregistry\b/i], ['record', /\brecords?\b/i],
  ['cache', /\bcache[ds]?\b/i], ['cache-miss', /cache-miss/i], ['scope', /\bscope\b/i], ['symlink', /\bsymlink(?:s|ed)?\b/i],
  ['realpath', /\brealpath\b/i], ['canonical', /\bcanonical\b/i], ['bundle', /\bbundles?\b/i], ['manifest', /\bmanifest\b/i],
  ['hook', /\bhooks?\b/i], ['stamp', /\bstamp\b/i], ['spawn', /\bspawn(?:s|ed|ing)?\b/i], ['probe', /\bprobe[ds]?\b/i],
  ['preflight', /\bpreflight\b/i], ['idempotent', /\bidempotent\b/i], ['legitimate', /\blegitimate\b/i],
  ['step N/5', /\bstep \d+\s*\/\s*\d+/i],
];

/** Offences in `text` → [{word, line}]. `$ command` lines, backticked commands (`claude …`, `npm …`, `npx …`, `tpm …`) and a broken-`hooks/hooks.json`
 * mention are exempt (voice §4.7 itself prints the failing command; users may see exactly what runs). */
function findNeverPrint(text) {
  const out = [];
  String(text).split('\n').forEach((line) => {
    if (/^\s*\$ /.test(line)) return;
    const scrubbed = line.replace(/hooks\/hooks\.json/g, '').replace(/`(?:claude|npm|npx|tpm|node) [^`]*`/g, '');
    NEVER_PRINT.forEach(([word, re]) => { if (re.test(scrubbed)) out.push({ word, line: line.trim() }); });
  });
  return out;
}

// ── sampleAll — every renderer, for the §13.5 grep ───────────────────────────────────────────────────

/**
 * Render EVERY string the voice can produce for `state` (and a fixed catalogue of actions/refusals/rows) →
 * [{name, text}]. Used by the never-print and width tests; phase 02/03 tests can reuse it per scenario.
 */
function sampleAll(state) {
  const out = []; const add = (name, text) => { if (text !== undefined && text !== null) out.push({ name, text: String(text) }); };
  add('header', header(state)); add('checking', checking(state));
  ['registered-elsewhere', 'not-installed', 'upgrade', 'broken', 'partial', 'healthy', 'healthy-with-warnings']
    .forEach((l) => add('diagnosis:' + l, diagnosisSentence(l, state, { oldVersion: '0.1.0', checks: 12, warnings: 1 })));
  const rows = doctorRows(state);
  rows.forEach((r) => add('row:' + r.label, renderRow(r)));
  [rowPackageJson, rowRegistered, rowTurnedOn, rowProjectFolder, rowClaudeTpmFolder, rowClaude, rowTpmOnPath, rowTpmHome]
    .forEach((f) => { const r = f(state); if (r) add('rowfn:' + f.name, renderRow(r)); });
  add('doctorSummary', doctorSummary(rows));
  add('checkingBlock', checkingBlock(state, diagnosisSentence('broken', state), rows.filter((r) => r.mark !== 'pass').map((r) => ({ mark: MARK[r.mark], text: r.text }))));
  const ids = ['tool-missing', 'no-package-json', 'bad-package-json', 'stamp', 'other-project-copy', 'no-self', 'incomplete', 'non-tty', 'self-folder'];
  ids.forEach((id) => add('refusal:' + id, refusal({ id, detail: { bin: 'claude', errorCode: 'ENOENT', err: 'Unexpected token', version: '0.2.0', actual: 'claude-tpm-market-0.2.0-dev', owner: tilde(os.homedir()) + '/projB', hooks: { err: null } } }, state)));
  ['EACCES', 'ENOMEM', 'exited 3'].forEach((c) => add('refusal:tool:' + c, refusal({ id: 'tool-missing', detail: { bin: 'npm', errorCode: c } }, state)));
  add('quietMenuRefusal', quietMenuRefusal(state));
  ['other-project-copy', 'this-project-copy', 'standalone', 'github'].forEach((where) => {
    const s2 = Object.assign({}, state, { reg: Object.assign({}, state.reg, { where, realPath: state.reg.realPath || '/x/projB/node_modules/@codercowboy/claude-tpm', projectDir: '/x/projB' }) });
    add('menu:' + where, decisionMenu(s2, 'same version, 3 files differ'));
  });
  const actions = [
    { id: 'repoint', commands: ['claude plugin marketplace remove m', 'claude plugin marketplace add /x'] },
    { id: 'register', commands: ['claude plugin marketplace add /x'] }, { id: 'register', ownCopy: true, commands: ['claude plugin marketplace add /x'] },
    { id: 'dep', commands: ['npm install file:../x --save-dev'] }, { id: 'dep', saveDev: false }, { id: 'dep', variant: 'upgrade', oldVersion: '0.1.0' }, { id: 'dep', variant: 'dangling' },
    { id: 'plugin-install' }, { id: 'plugin-install', variant: 'restore' }, { id: 'plugin-install', variant: 'again' }, { id: 'plugin-install', variant: 'upgrade' },
    { id: 'plugin-enable' }, { id: 'disable-old', oldVersion: '0.1.0' }, { id: 'config-seed' },
  ];
  actions.forEach((a, i) => { add(`plan:${a.id}:${i}`, planLine(i + 1, a, state)); add(`ok:${a.id}:${i}`, applyOk(a, state)); add(`fail:${a.id}:${i}`, applyFail(a, { status: 1, stderr: 'boom\nline two' })); });
  add('planBlock', planBlock(actions, state, { fine: [ALREADY_REGISTERED(state)], notTouched: notTouched('0.1.0'), warnings: [fragilityWarning(), twoTreesWarning(state)] }));
  add('stoppedAfter', stoppedAfter(1, 4)); add('declined', declined());
  add('closing:ok', closing(state, { checks: 12 })); add('closing:warn', closing(state, { checks: 11, warnings: 1, upgradedFrom: '0.1.0' }));
  add('closing:fail', closing(state, { failures: 2 })); add('closing:fail1', closing(state, { failures: 1 }));
  add('next', nextLine(state)); add('next:upgrade', nextLine(state, { upgradedFrom: '0.1.0' }));
  add('hook', hookMessage(state)); add('help', help());
  add('prompts', MENU_PROMPT + CONFIRM_PROMPT);
  // synthetic hook messages that cover every problem kind
  const sick = Object.assign({}, state, { dep: Object.assign({}, state.dep, { version: '0.1.0' }), en: Object.assign({}, state.en, { otherIds: ['claude-tpm@claude-tpm-market'] }),
    marker: { dir: false, config: 'invalid', err: 'Unexpected token } at line 4' } });
  add('hook:sick', hookMessage(sick));
  add('hook:config', hookMessage(Object.assign({}, state, { dep: Object.assign({}, state.dep, { version: state.self.version }), en: Object.assign({}, state.en, { otherIds: [] }), marker: { dir: true, config: 'invalid', err: 'Unexpected token } at line 4' } })));
  return out;
}

module.exports = {
  MARK, NOTHING_CHANGED, MENU_PROMPT, CONFIRM_PROMPT, NEVER_PRINT,
  fit, WIDTH, tilde, ver, plural, shellQuote, displayCommand, projectName,
  header, checking, diagnosisSentence, checkingBlock,
  rowPackageJson, rowRegistered, rowTurnedOn, rowProjectFolder, rowClaudeTpmFolder, rowClaude, rowTpmOnPath, rowTpmHome,
  doctorRows, renderRow, doctorSummary,
  refusal, quietMenuRefusal, decisionMenu,
  planProse, planLine, planBlock, ALREADY_REGISTERED, notTouched, fragilityWarning, twoTreesWarning,
  applyOk, applyFail, stoppedAfter, declined, closing, nextLine,
  lightProblems, hookMessage, help, findNeverPrint, sampleAll,
};
