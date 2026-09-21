#!/usr/bin/env node
/**
 * tpm-reading-list.js — `tpm reading-list <role>`: emit a role's methodology reading chain, resolved
 * to ready-to-run anchor-form commands.
 *
 * PURPOSE
 *   The reading-list manifests
 *   (`claude-context/methodology/orchestrator/reading-list.md` and `.../subagent/reading-list.md`) are
 *   the single source of truth for what each actor reads at step zero. Historically a reader had to
 *   fetch the manifest and hand-walk its `../`-relative markdown links. This verb does that walk for
 *   the reader: it parses the manifest's machine markers, translates each entry's `../`-relative link
 *   to a bundle-root-relative path, and prints the ordered chain in ANCHOR form — a leading
 *   `npx tpm resolve-home` line (its printed path IS the bundle root) followed by one
 *   `npx tpm doc <bundle-relpath>` line per entry. The reader runs the block; every doc resolves.
 *
 *   Self-locating + zero-dep, mirroring tpm-home.js / tpm-doc.js: it finds the bundle from the shared
 *   `bundleRoot()` primitive and reads the manifests out of the bundle, so it works in every
 *   permission mode with no env var and no hook.
 *
 * MARKERS
 *   The orchestrator manifest fences its boot block with `<!-- reading-list:begin <id> -->` …
 *   `<!-- reading-list:end -->`; the subagent manifest fences its blocks with `<!-- lint:begin <id> -->`
 *   … `<!-- lint:end -->` (the same block the subagent-prompt lint parses). This parser accepts BOTH
 *   spellings so the emitted chain and the enforced chain cannot drift.
 *
 * USAGE
 *   tpm reading-list orchestrator   # → the boot core chain (Tier-1 tpm-session-open block)
 *   tpm reading-list subagent       # → the base every-round chain
 *   tpm reading-list --help|-h
 *   exit 0 = printed · 1 = manifest unreadable · 2 = usage / unknown role
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { bundleRoot } = require('./tpm-home.js');

// role -> { manifest: bundle-relpath, blocks: [marker ids to emit, in order] }.
// Each role emits its ALWAYS-ON chain: the orchestrator's Tier-1 boot core, the subagent's base list.
// (Conditional subagent blocks — resume/shipping/verifier/… — are spawn-prompt-driven, not part of
// the unconditional walk this verb prints.)
const ROLES = {
  orchestrator: {
    manifest: 'claude-context/methodology/orchestrator/reading-list.md',
    blocks: ['tpm-session-open'],
  },
  subagent: {
    manifest: 'claude-context/methodology/subagent/reading-list.md',
    blocks: ['base'],
  },
};

// Parse every marked block in a manifest into { id: [line, …] }. Accepts both marker spellings:
//   <!-- reading-list:begin <id> --> … <!-- reading-list:end -->   (orchestrator manifest)
//   <!-- lint:begin <id> -->         … <!-- lint:end -->           (subagent manifest)
function parseBlocks(content) {
  const begin = /<!--\s*(?:reading-list|lint):begin\s+([\w-]+)\s*-->/;
  const end = /<!--\s*(?:reading-list|lint):end\s*-->/;
  const blocks = {};
  let cur = null;
  for (const line of content.split('\n')) {
    const b = line.match(begin);
    if (b) { cur = b[1]; blocks[cur] = []; continue; }
    if (end.test(line)) { cur = null; continue; }
    if (cur !== null) blocks[cur].push(line);
  }
  return blocks;
}

// Extract an entry's PRIMARY markdown-link target from a numbered list line:
//   `1. **[`project-workspace.md`](../project-workspace.md)** — …`  ->  `../project-workspace.md`
// Returns null for lines that are not numbered entries (prose, comments, blank lines).
function entryLink(line) {
  const m = line.match(/^\s*\d+\.\s+.*?\]\(([^)]+)\)/);
  return m ? m[1] : null;
}

// Translate a manifest-relative link (`../foo.md`, `./bar.md`) into a bundle-ROOT-relative path by
// resolving it against the manifest's OWN directory, e.g. for the orchestrator manifest at
// `claude-context/methodology/orchestrator/reading-list.md`:
//   `../project-workspace.md` -> `claude-context/methodology/project-workspace.md`
//   `./handbook.md`           -> `claude-context/methodology/orchestrator/handbook.md`
function toBundleRelpath(manifestRel, link) {
  const dir = path.posix.dirname(manifestRel.split(path.sep).join('/'));
  const joined = path.posix.normalize(path.posix.join(dir, link.split(path.sep).join('/')));
  return joined.replace(/^\.\//, '');
}

// The ordered bundle-relpaths for a role, derived from the live manifest content.
function chainEntries(role, content) {
  const spec = ROLES[role];
  const blocks = parseBlocks(content);
  const out = [];
  for (const id of spec.blocks) {
    const blk = blocks[id];
    if (!blk) continue;
    for (const line of blk) {
      const link = entryLink(line);
      if (link) out.push(toBundleRelpath(spec.manifest, link));
    }
  }
  return out;
}

// Render the anchor-form command block for a role given its resolved entries.
function render(role, entries) {
  const n = entries.length;
  const lines = [
    `# Reading list — ${role} (${n} doc${n === 1 ? '' : 's'}, in order).`,
    '# Run the anchor first (its printed path IS the bundle root); then read each doc under it:',
    'npx tpm resolve-home',
  ];
  for (const rel of entries) lines.push(`npx tpm doc ${rel}`);
  return lines.join('\n') + '\n';
}

function usage() {
  const roles = Object.keys(ROLES).join(', ');
  return `tpm reading-list <role> — emit a role's methodology reading chain in anchor form
  (a \`npx tpm resolve-home\` line + one \`npx tpm doc <bundle-relpath>\` per entry).

Known roles: ${roles}`;
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') { console.log(usage()); return 0; }

  const role = args[0];
  if (!role || !ROLES[role]) {
    process.stderr.write(role ? `tpm reading-list: unknown role '${role}'.\n\n` : 'tpm reading-list: missing <role>.\n\n');
    process.stderr.write(usage() + '\n');
    return 2;
  }

  const root = bundleRoot();
  const spec = ROLES[role];
  let content;
  try { content = fs.readFileSync(path.join(root, spec.manifest), 'utf8'); }
  catch (e) {
    process.stderr.write(`tpm reading-list: cannot read the ${role} manifest '${spec.manifest}' under the bundle (${e.code || e.message})\n`);
    return 1;
  }

  process.stdout.write(render(role, chainEntries(role, content)));
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { ROLES, parseBlocks, entryLink, toBundleRelpath, chainEntries, render, main };
