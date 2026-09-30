#!/usr/bin/env node
/**
 * fake-claude-stateful.js — a STATEFUL stand-in for the real `claude` CLI, used ONLY by the consumer
 * install/uninstall tests (copied to <tmp>/claude and put first on PATH). It never touches any real
 * registry: all state lives in the JSON file named by $FAKE_CLAUDE_STATE, and every call is appended to
 * the JSONL file named by $FAKE_CLAUDE_LOG as { argv, cwd }.
 *
 * Models just enough of Claude Code (shapes verified live; see dev/plugin-topology/probe-findings.md):
 *   state = { marketplaces: [{name,source,path}], records: [{id,scope,enabled,installPath,projectPath}] }
 *   --version                          → prints a version
 *   plugin marketplace list --json     → state.marketplaces
 *   plugin marketplace add <dir> [--scope X]
 *                                      → name read from <dir>/.claude-plugin/marketplace.json; stored path
 *                                        EXACTLY as given. With `--scope project` it ALSO writes an
 *                                        extraKnownMarketplaces entry into <cwd>/.claude/settings.json
 *                                        (so a test can prove the installer does not do that).
 *   plugin marketplace remove <name>   → drops the row AND every install record for that marketplace
 *                                        (probe #11a)
 *   plugin list --json                 → ALL records (machine-wide, one per project, like the real list)
 *   plugin install <id> --scope project [-y]
 *                                      → record {scope:project, projectPath:cwd, installPath:<market path>};
 *                                        writes <cwd>/.claude/settings.json {enabledPlugins:{id:true}}
 *   plugin enable|disable <id> --scope project → flips this cwd's record + the settings entry
 *   plugin uninstall <id> --scope project [-y] → drops this cwd's record + settings entry
 * Anything else exits 0 silently. Set FAKE_CLAUDE_FAIL=<verb words> to make a matching call exit 1.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_CLAUDE_STATE;
const logPath = process.env.FAKE_CLAUDE_LOG;
try { if (logPath) fs.appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd() }) + '\n'); } catch (_e) { /* ignore */ }

function load() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_e) { return { marketplaces: [], records: [] }; }
}
function save(st) { fs.writeFileSync(statePath, JSON.stringify(st, null, 2)); }
function emit(x) { process.stdout.write(JSON.stringify(x)); process.exit(0); }
function same(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch (_e) { return path.resolve(a) === path.resolve(b); }
}
function settingsPath() { return path.join(process.cwd(), '.claude', 'settings.json'); }
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (_e) { return {}; } }
function writeSettings(o) { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(o, null, 2)); }
function flag(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

if (process.env.FAKE_CLAUDE_FAIL && argv.join(' ').indexOf(process.env.FAKE_CLAUDE_FAIL) === 0) {
  process.stderr.write('fake claude: forced failure\n'); process.exit(1);
}
if (argv[0] === '--version') { process.stdout.write('9.9.9 (fake)\n'); process.exit(0); }

const st = load();
if (argv[0] === 'plugin' && argv[1] === 'marketplace') {
  const verb = argv[2];
  if (verb === 'list') emit(st.marketplaces.map((m) => ({ name: m.name, source: m.source, path: m.path, installLocation: m.path })));
  if (verb === 'add') {
    const dir = argv[3];
    let name = 'unknown-market';
    try { name = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')).name; } catch (_e) { /* keep */ }
    st.marketplaces = st.marketplaces.filter((m) => m.name !== name);
    st.marketplaces.push({ name, source: 'directory', path: dir });
    save(st);
    if (flag('--scope') === 'project') {
      const s = readSettings();
      s.extraKnownMarketplaces = Object.assign({}, s.extraKnownMarketplaces, { [name]: { source: { source: 'directory', path: dir } } });
      writeSettings(s);
    }
    process.exit(0);
  }
  if (verb === 'remove') {
    const name = argv[3];
    if (!st.marketplaces.some((m) => m.name === name)) { process.stderr.write('Marketplace not found\n'); process.exit(1); }
    st.marketplaces = st.marketplaces.filter((m) => m.name !== name);
    st.records = st.records.filter((r) => !String(r.id).endsWith('@' + name));
    save(st); process.exit(0);
  }
  process.exit(0);
}
if (argv[0] === 'plugin' && argv[1] === 'list') emit(st.records);
if (argv[0] === 'plugin' && ['install', 'enable', 'disable', 'uninstall'].indexOf(argv[1]) >= 0) {
  const verb = argv[1]; const id = argv[2]; const scope = flag('--scope') || 'user';
  const market = String(id).split('@')[1];
  const mk = st.marketplaces.find((m) => m.name === market);
  const mine = (r) => r.id === id && r.scope === scope && r.projectPath && same(r.projectPath, process.cwd());
  if (verb === 'install') {
    if (!mk) { process.stderr.write(`Plugin "${id}" not found in marketplace\n`); process.exit(1); }
    st.records = st.records.filter((r) => !mine(r));
    st.records.push({ id, version: '0.0.0', scope, enabled: true, installPath: mk.path, projectPath: process.cwd() });
    save(st);
    if (scope === 'project') { const s = readSettings(); s.enabledPlugins = Object.assign({}, s.enabledPlugins, { [id]: true }); writeSettings(s); }
    process.exit(0);
  }
  const rec = st.records.find(mine);
  if (!rec) { process.stderr.write(`Plugin "${id}" is not installed\n`); process.exit(1); }
  if (verb === 'uninstall') {
    st.records = st.records.filter((r) => !mine(r)); save(st);
    const s = readSettings(); if (s.enabledPlugins) { delete s.enabledPlugins[id]; writeSettings(s); }
  } else {
    rec.enabled = verb === 'enable'; save(st);
    const s = readSettings(); s.enabledPlugins = Object.assign({}, s.enabledPlugins, { [id]: rec.enabled }); writeSettings(s);
  }
  process.exit(0);
}
process.exit(0);
