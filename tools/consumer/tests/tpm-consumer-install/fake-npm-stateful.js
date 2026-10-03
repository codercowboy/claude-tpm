#!/usr/bin/env node
/**
 * fake-npm-stateful.js — a STATEFUL stand-in for `npm`, used ONLY by the consumer install tests (copied to
 * <world>/npm and put first on PATH). It models just `npm install file:<rel> --save|--save-dev|--save-optional`
 * the way real npm 10 behaves for a local folder: a SYMLINK node_modules/@codercowboy/claude-tpm → the folder, the
 * spec recorded in the matching package.json bucket, and a failure (ENOENT) for a spec that points INSIDE a
 * node_modules (the shape the installer must never generate). Every call is appended to $NPM_LOG as {argv, cwd}.
 *   FAKE_NPM_FAIL=1  → every install exits 1 with a stderr message
 *   FAKE_NPM_NOOP=1  → every install exits 0 but changes nothing (the "ran, but did not take effect" case)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
try { if (process.env.NPM_LOG) fs.appendFileSync(process.env.NPM_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\n'); } catch (_e) { /* ignore */ }

if (argv[0] === '--version') { process.stdout.write('10.0.0\n'); process.exit(0); }
if (argv[0] !== 'install') process.exit(0);

if (process.env.FAKE_NPM_FAIL) { process.stderr.write('npm ERR! forced failure from the fake npm\n'); process.exit(1); }
if (process.env.FAKE_NPM_NOOP) { process.stdout.write('up to date\n'); process.exit(0); }

const spec = argv[1] || '';
const m = /^file:(.*)$/.exec(spec);
if (!m) { process.stderr.write(`npm ERR! the fake npm only models file: specs (got ${spec})\n`); process.exit(1); }
const target = path.resolve(process.cwd(), m[1]);
if (/(^|[\\/])node_modules([\\/]|$)/.test(target)) { process.stderr.write(`npm ERR! enoent ${target} (a file: spec inside node_modules)\n`); process.exit(1); }
if (!fs.existsSync(target)) { process.stderr.write(`npm ERR! enoent ${target}\n`); process.exit(1); }

const bucket = argv.includes('--save-optional') ? 'optionalDependencies' : argv.includes('--save-dev') ? 'devDependencies' : 'dependencies';
const NAME = '@codercowboy/claude-tpm';
const nmScope = path.join(process.cwd(), 'node_modules', '@codercowboy');
fs.mkdirSync(nmScope, { recursive: true });
const link = path.join(nmScope, 'claude-tpm');
try { fs.rmSync(link, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
fs.symlinkSync(fs.realpathSync(target), link);

const pj = path.join(process.cwd(), 'package.json');
const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
['dependencies', 'devDependencies', 'optionalDependencies'].forEach((b) => { if (j[b]) delete j[b][NAME]; });
j[bucket] = Object.assign({}, j[bucket], { [NAME]: spec });
fs.writeFileSync(pj, JSON.stringify(j, null, 2));
process.stdout.write('added 1 package\n');
process.exit(0);
