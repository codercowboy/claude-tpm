#!/usr/bin/env node
'use strict';
/**
 * tpm-render.js — `tpm render`: compose a skill template against the resolved claude-tpm config.
 *
 * USAGE (see tpm-render.md)
 *   tpm render <template-file> [--explain | --list-flags | --lint]
 *              [--slot name=@file | name=text]... [--config <json-file>] [--project-root <dir>] [--no-banner]
 *   tpm render --help | -h
 *
 * Exit codes: 0 ok · 1 unreadable template/slot/config file, or a lint error · 2 usage.
 * Thin wrapper over lib/tpm-template.js (the engine); self-locating, zero deps.
 */

const fs = require('fs');
const path = require('path');
const engine = require('./lib/tpm-template');
const overlay = require('./lib/tpm-config-overlay');

const HELP = `tpm render — compose a skill template against the resolved claude-tpm config

Usage:
  tpm render <template-file> [--explain | --list-flags | --lint]
             [--slot name=@file | name=text]... [--config <json-file>] [--project-root <dir>] [--no-banner]
  tpm render --help | -h

Default: print the composed text to stdout (warnings go to stderr as "render: <code> (line N): <message>").
Directives (whole-line HTML comments): tpm:if [!]FLAG, tpm:endif, tpm:inject NAME, tpm:raw / tpm:endraw.

Options:
  --explain         print the kept/dropped region table + the driving flag values instead of the text
  --list-flags      list every flag the template references, with its shipped default (static)
  --lint            check the template (unbalanced if/endif, flags absent from defaults.json); exit 1 on error
  --slot n=@file    fill "tpm:inject n" from a file (repeatable); --slot n=text fills it literally
  --config <file>   use this JSON file as the resolved config instead of resolving layers (golden/CI use)
  --project-root d  resolve the project layer from this project root
  --no-banner       do not prepend the degraded-config banner

--explain, --list-flags and --lint are mutually exclusive.
Exit codes: 0 ok · 1 unreadable file or lint error · 2 usage.`;

function usage(msg) {
  process.stderr.write(`render: ${msg}\n\n${HELP}\n`);
  return 2;
}

function parseArgs(argv) {
  const o = { positional: [], slots: {}, mode: [], banner: true };
  for (let i = 0; i < argv.length; i += 1) {
    let a = argv[i];
    let inlineVal;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq !== -1) { inlineVal = a.slice(eq + 1); a = a.slice(0, eq); }
    const val = () => {
      if (inlineVal !== undefined) return inlineVal;
      i += 1;
      return argv[i];
    };
    switch (a) {
      case '--help': case '-h': o.help = true; break;
      case '--explain': o.mode.push('explain'); break;
      case '--list-flags': o.mode.push('list-flags'); break;
      case '--lint': o.mode.push('lint'); break;
      case '--no-banner': o.banner = false; break;
      case '--config': o.config = val(); if (o.config === undefined) o.err = '--config needs a file'; break;
      case '--project-root': o.projectRoot = val(); if (o.projectRoot === undefined) o.err = '--project-root needs a directory'; break;
      case '--slot': {
        const v = val();
        if (v === undefined || v.indexOf('=') < 1) { o.err = '--slot needs name=@file or name=text'; break; }
        const k = v.indexOf('=');
        const name = v.slice(0, k);
        if (!/^[a-z][a-z0-9-]*$/.test(name)) { o.err = `--slot name "${name}" must match [a-z][a-z0-9-]*`; break; }
        o.slots[name] = v.slice(k + 1);
        break;
      }
      default:
        if (a.startsWith('-') && a !== '-') o.err = `unknown option ${a}`;
        else o.positional.push(argv[i]);
    }
  }
  return o;
}

function fmt(v) {
  if (v === undefined) return '(unset)';
  try { return JSON.stringify(v); } catch (_e) { return String(v); }
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(`${HELP}\n`); return 0; }
  if (o.err) return usage(o.err);
  if (o.positional.length !== 1) return usage('exactly one <template-file> is required');
  if (o.mode.length > 1) return usage('--explain, --list-flags and --lint are mutually exclusive');
  const mode = o.mode[0] || 'render';

  const file = path.resolve(process.cwd(), o.positional[0]);
  let template;
  try { template = fs.readFileSync(file, 'utf8'); } catch (_e) {
    process.stderr.write(`render: cannot read ${o.positional[0]}\n`);
    return 1;
  }

  if (mode === 'lint') {
    const issues = engine.lint(template);
    for (const it of issues) process.stdout.write(`${o.positional[0]}:${it.line} ${it.code} ${it.message}\n`);
    return issues.some((it) => it.severity === 'error') ? 1 : 0;
  }

  if (mode === 'list-flags') {
    const s = engine.scanTemplate(template);
    let defaults = null;
    try { defaults = overlay.loadDefaults(); } catch (_e) { defaults = null; }
    const byFlag = new Map();
    for (const f of s.flags) {
      if (!byFlag.has(f.flag)) byFlag.set(f.flag, []);
      byFlag.get(f.flag).push(f.line);
    }
    for (const [flag, ls] of byFlag) {
      let def = '(defaults unavailable)';
      if (defaults) {
        let got = { found: false };
        try { got = overlay.getAtPath(defaults, flag); } catch (_e) { got = { found: false }; }
        def = got.found ? fmt(got.value) : '(not in defaults)';
      }
      process.stdout.write(`${flag}\t${def}\t${ls.join(',')}\n`);
    }
    return 0;
  }

  // slots: name=@path reads a file (CLI only)
  const slots = {};
  for (const [name, v] of Object.entries(o.slots)) {
    if (v.startsWith('@')) {
      try { slots[name] = fs.readFileSync(path.resolve(process.cwd(), v.slice(1)), 'utf8'); } catch (_e) {
        process.stderr.write(`render: cannot read slot file ${v.slice(1)}\n`);
        return 1;
      }
    } else {
      slots[name] = v;
    }
  }

  const ropts = { slots, banner: o.banner, explain: mode === 'explain', name: o.positional[0] };
  if (o.config) {
    try { ropts.config = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), o.config), 'utf8')); } catch (e) {
      process.stderr.write(`render: cannot read config ${o.config}: ${e.message}\n`);
      return 1;
    }
  }
  if (o.projectRoot) ropts.projectRoot = path.resolve(process.cwd(), o.projectRoot);

  const r = engine.render(template, ropts);

  if (mode === 'explain') {
    if (r.degraded) process.stdout.write(`degraded: ${r.degradedReason}\n`);
    for (const g of r.regions) {
      const lines = g.startLine === g.endLine ? String(g.startLine) : `${g.startLine}-${g.endLine}`;
      const because = g.kind === 'if' && g.flag
        ? `${g.negated ? '!' : ''}${g.flag}=${fmt(g.value)}`
        : (g.kind === 'inject' ? `slot ${g.expr}` : (g.kind === 'raw' ? 'raw' : g.expr));
      process.stdout.write(`${g.id}  ${g.kind}  ${lines}  ${g.kept ? 'KEPT' : 'DROPPED'}  because ${because} (${g.reason})\n`);
    }
    process.stdout.write('flags:\n');
    for (const f of r.flags) {
      process.stdout.write(`  ${f.negated ? '!' : ''}${f.flag} = ${f.resolved ? fmt(f.value) : '(unresolved)'} -> ${f.on ? 'ON' : 'OFF'} (line ${f.line})\n`);
    }
    for (const w of r.warnings) process.stderr.write(`render: ${w.code} (line ${w.line}): ${w.message}\n`);
    return 0;
  }

  process.stdout.write(r.text);
  for (const w of r.warnings) process.stderr.write(`render: ${w.code} (line ${w.line}): ${w.message}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs };
