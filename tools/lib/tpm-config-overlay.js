'use strict';
/**
 * tpm-config-overlay.js — the shared, zero-dep layered-config overlay lib (#1152).
 *
 * The ONE place claude-tpm's config layering lives. It ships three things the per-suite resolvers
 * (session/task/workflow) and the `tpm config` router all consume AS A MODULE (not via the CLI):
 *
 *   1. loadDefaults()  — read + parse the shipped tools/config/defaults.json and RECURSIVELY STRIP
 *      every `_comment`/`$comment` key from the RESOLVED output. Each suite's getDefaults() re-points
 *      onto `loadDefaults().<section>`. It does NOT absolutize workflow's subagentConfigs[].charterFile
 *      — that one domain-specific transform stays co-located in the workflow resolver (bundleRoot()).
 *   2. deepMerge / layer resolution — deep-merge plain objects key-by-key; scalars + objects + arrays
 *      REPLACE (later layer wins); only a dotted path in the EXPLICIT additive allowlist CONCATs+DEDUPs.
 *      The allowlist (ADDITIVE_ARRAYS) is seeded with ONLY the #1155 session arrays — every pre-existing array keeps REPLACE.
 *      Three layers, lowest→highest: defaults.json -> project .claude/claude-tpm/config.json ->
 *      $CLAUDE_TPM_USER_CONFIG. Missing project/user layer is tolerated; a present-but-invalid USER file
 *      warns (stderr) and is ignored, never fatal. The per-value flag/env rungs still win on top, in the
 *      existing resolve*Dir resolvers — this lib wires in at the "config" rung only.
 *   3. a `set` primitive — setPathEx (dotted + `[i]`/`[+]` array ops), coerce (string -> JSON literal),
 *      setLayer (edit the RAW target-layer file, create-if-absent, atomic write) — round-trips `_comment`
 *      keys and sibling sections because it reads/writes the raw file, not the comment-stripped view.
 *
 * COMPOSITION (decision: overlay composition (a)). The resolvers do NOT let this lib own their final
 * merge. They fold the USER layer onto the PROJECT section via overlayUserOnto(), then feed the result
 * to their EXISTING per-suite whitelist merge<Section>Config() as its "raw" input. That keeps every
 * type-guard + back-compat alias, strips stray comment keys for free, and (because merge<Section>Config
 * reseeds defaults) stays byte-identical to getDefaults() when no project/user layer is present.
 *
 * Zero third-party deps; Node built-ins + the suite-local lib/_util, lib/io, lib/paths only.
 * Loadable/inspectable via `node tpm-config-overlay.js`.
 */

const fs = require('fs');
const path = require('path');
const { isPlainObject } = require('./_util');
const { atomicWriteFileSync } = require('./io');

// ── defaults.json location ──────────────────────────────────────────────────────────────────────
// Self-located relative to THIS file (tools/lib/ -> tools/config/defaults.json), the same trick as
// tpm-home.js bundleRoot(). TPM_DEFAULTS_FILE overrides it (tests; a vendored-bundle hatch). Do NOT
// depend on TPM_HOME (informational, read by nothing).
const BUILT_IN_DEFAULTS = path.resolve(__dirname, '..', 'config', 'defaults.json');
function defaultsFile() {
  return process.env.TPM_DEFAULTS_FILE || BUILT_IN_DEFAULTS;
}

// ── comment keys ─────────────────────────────────────────────────────────────────────────────────
const COMMENT_KEYS = new Set(['_comment', '$comment']);
function isCommentKey(k) {
  return COMMENT_KEYS.has(k);
}

/** Deep clone a JSON-serialisable value, dropping every _comment/$comment key as it goes. */
function cloneStripped(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneStripped);
  const out = {};
  for (const k of Object.keys(v)) {
    if (isCommentKey(k)) continue;
    out[k] = cloneStripped(v[k]);
  }
  return out;
}

// ── THE ADDITIVE-ARRAY ALLOWLIST (decision #4) — #1155 entries only ────────────────────────────
// Dotted paths whose arrays CONCAT+DEDUP across layers (everything else REPLACES).
// SEEDED EMPTY for #1152 — all existing arrays must keep REPLACE semantics so pinned tests stay green:
//   workflow.blockedFilenamePatterns (REPLACE — config-resolver test),
//   tasks.defaultListState           (REPLACE via .slice()),
//   workflow.subagentConfigs / workflow.teams (name-keyed; handled by mergeByName inside
//     mergeWorkflowConfig, NOT by this additive allowlist).
// #1155 populates it (first real entries): `session.proseInjections` (#1153 prose file list) and
// `session.readingList` (#1154 reading-list pointers) STACK across layers (concat+dedup) so a user
// layer ADDS to the project's list instead of clobbering it. Every other array keeps REPLACE.
const ADDITIVE_ARRAYS = ['session.proseInjections', 'session.readingList'];

// ── deep merge ─────────────────────────────────────────────────────────────────────────────────────

/** Concat two arrays then dedup: name-keyed object arrays via mergeByName semantics, else by value. */
function concatDedup(base, overlay) {
  const all = base.concat(overlay);
  const allNamed = all.length > 0 && all.every(
    (x) => isPlainObject(x) && typeof x.name === 'string',
  );
  if (allNamed) {
    const out = [];
    const idx = new Map();
    for (const e of all) {
      if (idx.has(e.name)) {
        out[idx.get(e.name)] = Object.assign({}, out[idx.get(e.name)], cloneStripped(e));
      } else {
        idx.set(e.name, out.length);
        out.push(cloneStripped(e));
      }
    }
    return out;
  }
  const out = [];
  const seen = new Set();
  for (const e of all) {
    const key = e !== null && typeof e === 'object' ? JSON.stringify(cloneStripped(e)) : e;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cloneStripped(e));
  }
  return out;
}

/**
 * deepMerge(base, overlay, { additiveArrays, _path }) -> merged value (comment keys stripped).
 *   - undefined overlay  -> clone of base (comment-stripped); undefined base -> clone of overlay.
 *   - both plain objects -> recurse key-by-key (overlay keys win).
 *   - both arrays        -> REPLACE with overlay, UNLESS the dotted _path is in additiveArrays (concat+dedup).
 *   - anything else      -> overlay wins wholesale (scalar/object/type-mismatch REPLACE).
 */
function deepMerge(base, overlay, opts = {}) {
  const additive = opts.additiveArrays || ADDITIVE_ARRAYS;
  const curPath = opts._path || '';
  if (overlay === undefined) return cloneStripped(base);
  if (base === undefined) return cloneStripped(overlay);

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out = {};
    for (const k of Object.keys(base)) {
      if (isCommentKey(k)) continue;
      out[k] = cloneStripped(base[k]);
    }
    for (const k of Object.keys(overlay)) {
      if (isCommentKey(k)) continue;
      const childPath = curPath ? `${curPath}.${k}` : k;
      out[k] = (k in base && !isCommentKey(k))
        ? deepMerge(base[k], overlay[k], { additiveArrays: additive, _path: childPath })
        : cloneStripped(overlay[k]);
    }
    return out;
  }

  if (Array.isArray(base) && Array.isArray(overlay)) {
    if (additive.includes(curPath)) return concatDedup(cloneStripped(base), cloneStripped(overlay));
    return cloneStripped(overlay); // REPLACE (the default)
  }

  return cloneStripped(overlay);
}

// ── defaults loader ─────────────────────────────────────────────────────────────────────────────

/** Read + parse + comment-strip the shipped defaults.json. Fresh object each call (safe to mutate). */
function loadDefaults() {
  const file = defaultsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = new Error(`tpm-config-overlay: cannot read defaults file '${file}': ${err.message}`);
    e.code = 'ENODEFAULTS';
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`tpm-config-overlay: defaults file '${file}' is not valid JSON: ${err.message}`);
    e.code = 'EBADDEFAULTS';
    throw e;
  }
  return cloneStripped(parsed);
}

// ── layer reads ───────────────────────────────────────────────────────────────────────────────────

/**
 * Read a section (or the whole object when `section` is falsy) from a config FILE.
 *   tolerant:false (project) -> invalid JSON throws EBADJSON (matches the resolvers' error contract).
 *   tolerant:true  (user)    -> invalid JSON -> warn(stderr) + return undefined (skip the layer).
 * A missing/unreadable file always returns undefined (absent layer is normal).
 */
function readSectionFromFile(file, section, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return undefined; // absent layer
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (opts.tolerant) {
      const warn = opts.warn || ((m) => process.stderr.write(m));
      warn(`config: could not parse ${file} as JSON (${err.message}); ignoring that config layer.\n`);
      return undefined;
    }
    const e = new Error(`could not parse ${file} as JSON: ${err.message}`);
    e.code = 'EBADJSON';
    throw e;
  }
  return section ? parsed[section] : parsed;
}

/**
 * The USER layer: process.env.CLAUDE_TPM_USER_CONFIG. Returns the user file's `section` (or the whole
 * object), or undefined. Tolerance (decision): env unset -> undefined; file absent -> undefined; present
 * but invalid JSON -> warn(stderr) + undefined. NEVER throws.
 */
function resolveUserSection(section, opts = {}) {
  const env = opts.env || process.env;
  const file = env.CLAUDE_TPM_USER_CONFIG;
  if (!file) return undefined;
  if (!fs.existsSync(file)) return undefined;
  return readSectionFromFile(file, section, { tolerant: true, warn: opts.warn });
}

/**
 * Fold the USER layer onto a PROJECT section (user wins), for a resolver to feed its whitelist merge.
 * Returns the merged section, the project section unchanged when there is no user layer, or undefined
 * when BOTH are absent (so merge<Section>Config(undefined) === getDefaults() — the preserved default path).
 */
function overlayUserOnto(projectSection, section, opts = {}) {
  const userSection = resolveUserSection(section, opts);
  if (userSection === undefined) return projectSection;
  if (projectSection === undefined) return cloneStripped(userSection);
  return deepMerge(projectSection, userSection, { _path: section || '' });
}

/**
 * The FULL three-layer resolved view (defaults -> project -> user, user wins), comment-stripped — the
 * primitive the `tpm config` router's `get` (no --layer) and `list` use. `section` narrows to one section.
 * NOTE: workflow's subagentConfigs[].charterFile comes back BUNDLE-RELATIVE here (loadDefaults does not
 * absolutize); the absolutized value is what `tpm workflow config --get` reports (the workflow resolver
 * owns that transform). Project-layer invalid JSON throws EBADJSON; user-layer invalid JSON warns+skips.
 */
function resolveLayers(opts = {}) {
  const { section, projectRoot, projectConfigPath } = opts;
  const defaults = loadDefaults();
  let merged = section ? defaults[section] : defaults;

  const pcPath = projectConfigPath
    || (projectRoot && path.join(projectRoot, '.claude', 'claude-tpm', 'config.json'));
  if (pcPath && fs.existsSync(pcPath)) {
    const projSection = readSectionFromFile(pcPath, section, { tolerant: false });
    merged = deepMerge(merged, projSection, { _path: section || '' });
  }

  const userSection = resolveUserSection(section, opts);
  merged = deepMerge(merged, userSection, { _path: section || '' });
  return merged;
}

// ── read a single layer (for `config get --layer <layer>`) ──────────────────────────────────────────
function readLayer(layer, opts = {}) {
  const { section, projectRoot, projectConfigPath } = opts;
  if (layer === 'defaults' || layer === 'default') {
    const d = loadDefaults();
    return section ? d[section] : d;
  }
  if (layer === 'user') {
    return resolveUserSection(section, opts);
  }
  // project
  const pcPath = projectConfigPath
    || (projectRoot && path.join(projectRoot, '.claude', 'claude-tpm', 'config.json'));
  if (!pcPath || !fs.existsSync(pcPath)) return undefined;
  const raw = readSectionFromFile(pcPath, section, { tolerant: false });
  return raw === undefined ? undefined : cloneStripped(raw);
}

// ── path grammar (dotted + [i]/[+]) ────────────────────────────────────────────────────────────────

/** Parse one dotted segment: "name", "name[3]", or "name[+]" -> { key, index: null|int|'+' }. */
function parseSegment(seg) {
  const m = /^([^[\]]+)(?:\[(\d+|\+)\])?$/.exec(seg);
  if (!m) {
    const e = new Error(`invalid config path segment: "${seg}"`);
    e.code = 'EBADPATH';
    throw e;
  }
  return { key: m[1], index: m[2] === undefined ? null : (m[2] === '+' ? '+' : parseInt(m[2], 10)) };
}

/**
 * setPathEx(obj, dotted, value) — like _util.setPath but with ARRAY-INDEX support (`[i]`/`[+]`).
 * A bracketless segment descends/creates a plain object; `[i]` indexes into (creating) an array at that
 * key; `[+]` appends. Out-of-range `[i]` on the last segment assigns at that index (JSON holes -> null).
 * Mutates and returns obj. (NOT a mutation of _util.setPath — other callers rely on its object-only shape.)
 */
function setPathEx(obj, dotted, value) {
  const segs = String(dotted).split('.').map(parseSegment);
  let cur = obj;
  for (let i = 0; i < segs.length; i += 1) {
    const { key, index } = segs[i];
    const last = i === segs.length - 1;
    if (index === null) {
      if (last) {
        cur[key] = value;
      } else {
        if (!isPlainObject(cur[key])) cur[key] = {};
        cur = cur[key];
      }
    } else {
      if (!Array.isArray(cur[key])) cur[key] = [];
      const arr = cur[key];
      const idx = index === '+' ? arr.length : index;
      if (last) {
        arr[idx] = value;
      } else {
        if (!isPlainObject(arr[idx])) arr[idx] = {};
        cur = arr[idx];
      }
    }
  }
  return obj;
}

/** getAtPath(obj, dotted) -> { found, value }. Supports `[i]` on read (`[+]` is a no-match on read). */
function getAtPath(obj, dotted) {
  const segs = String(dotted).split('.').map(parseSegment);
  let cur = obj;
  for (const { key, index } of segs) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) {
      return { found: false, value: undefined };
    }
    cur = cur[key];
    if (index !== null) {
      if (!Array.isArray(cur)) return { found: false, value: undefined };
      const idx = index === '+' ? cur.length : index;
      if (idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    }
  }
  return { found: true, value: cur };
}

/** Coerce a CLI string to a JSON literal (true/false/number/null/array/object), else the raw string. */
function coerce(s) {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch (_e) {
    return s;
  }
}

/**
 * setLayer({ path, value, layer, projectRoot, projectConfigPath, env }) -> { file, path, value }
 * Edit ONE layer's RAW file (comments + sibling sections preserved), create-if-absent, atomic write.
 *   layer 'default'/'defaults' -> the shipped tools/config/defaults.json (⚠ edits the install-global file);
 *   layer 'user'               -> $CLAUDE_TPM_USER_CONFIG (error if the env var is unset);
 *   layer 'project' / absent    -> <projectRoot>/.claude/claude-tpm/config.json.
 */
function setLayer(opts = {}) {
  const { path: dotted, value, layer } = opts;
  const env = opts.env || process.env;
  let file;
  if (layer === 'default' || layer === 'defaults') {
    file = defaultsFile();
  } else if (layer === 'user') {
    file = env.CLAUDE_TPM_USER_CONFIG;
    if (!file) {
      const e = new Error('cannot set --user: CLAUDE_TPM_USER_CONFIG is not set to a file path.');
      e.code = 'ENOUSERCONFIG';
      throw e;
    }
  } else {
    file = opts.projectConfigPath
      || (opts.projectRoot && path.join(opts.projectRoot, '.claude', 'claude-tpm', 'config.json'));
    if (!file) {
      const e = new Error('setLayer: projectRoot (or projectConfigPath) is required for the project layer.');
      e.code = 'ENOPROJECTROOT';
      throw e;
    }
  }

  let obj = {};
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      obj = {}; // create-if-absent
    } else if (err instanceof SyntaxError) {
      const e = new Error(`cannot set: ${file} is not valid JSON (${err.message}); refusing to clobber it.`);
      e.code = 'EBADJSON';
      throw e;
    } else {
      throw err;
    }
  }
  if (!isPlainObject(obj)) obj = {};

  setPathEx(obj, dotted, value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return { file, path: dotted, value };
}

module.exports = {
  defaultsFile,
  loadDefaults,
  deepMerge,
  concatDedup,
  cloneStripped,
  ADDITIVE_ARRAYS,
  readSectionFromFile,
  resolveUserSection,
  overlayUserOnto,
  resolveLayers,
  readLayer,
  parseSegment,
  setPathEx,
  getAtPath,
  coerce,
  setLayer,
};

// `node tpm-config-overlay.js` → a tiny self-check that the defaults file loads + comment-strips.
if (require.main === module) {
  const d = loadDefaults();
  const sections = Object.keys(d).filter((k) => !isCommentKey(k));
  process.stdout.write(`tpm-config-overlay OK — defaults load: ${sections.join(', ')}\n`);
}
