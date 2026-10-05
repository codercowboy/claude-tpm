'use strict';
/**
 * tpm-hygiene-config.js — the `hygiene` config-section resolver (#1152, E′).
 *
 * PURPOSE
 *   A minimal resolver for the `hygiene` section of a project's config, layered through the shared
 *   overlay lib (defaults.json -> project config.json -> $CLAUDE_TPM_USER_CONFIG). Before #1152 there was
 *   NO hygiene resolver: the only consumer (tools/hooks/tpm-hooks-session-start.js) read the raw project
 *   config.json inline. This module is now that consumer's resolver, so the SessionStart health-note gate
 *   (`hygiene.healthCheck.enabled`, default ON) reads through the same overlay every other section uses.
 *
 *   Kept intentionally minimal (decision: Hygiene scope = FULL re-point, but the section stays small for
 *   #1152): the only keys that any code reads are `hygiene.enabled` (via session's readModuleEnablement,
 *   which is NOT re-pointed — it reads raw) and `hygiene.healthCheck.enabled` (via the hook, below). The
 *   not-yet-built sweep settings config-guide §4 mentions are NOT invented here.
 *
 * FAIL-OPEN CONTRACT (the hook relies on this)
 *   resolveHygieneConfig reads the PROJECT layer STRICTLY (invalid project JSON throws EBADJSON, like the
 *   session/workflow resolvers) and the USER layer tolerantly (warn + skip). The SessionStart hook wraps
 *   the call in try/catch and returns the default-ON answer on ANY throw — so a broken config never
 *   silences or crashes the health note. See tpm-hooks-session-start.js healthCheckEnabled().
 *
 * REUSABLE API (this file is a module; it has no CLI/bin route — imported, not run)
 *   getDefaults() -> { enabled: true, healthCheck: { enabled: true } }  (from defaults.json, comment-stripped)
 *   resolveHygieneConfig(projectRoot, opts) -> the merged `hygiene` section (defaults->project->user)
 *
 * Zero third-party deps; Node built-ins + the shared overlay lib only. Inspectable via `node <file>`.
 */

const overlay = require('../lib/tpm-config-overlay');

/** The built-in hygiene defaults, sourced from the shipped defaults.json (comment keys stripped). */
function getDefaults() {
  return overlay.loadDefaults().hygiene;
}

/**
 * Resolve the `hygiene` section for a project via the three-layer overlay.
 * @param {string} projectRoot the project root (…/.claude/claude-tpm/config.json is the project layer)
 * @param {object} [opts] { warn, env }
 * @returns {object} the merged hygiene section (defaults -> project -> user, user wins)
 */
function resolveHygieneConfig(projectRoot, opts = {}) {
  return overlay.resolveLayers({ section: 'hygiene', projectRoot, warn: opts.warn, env: opts.env });
}

module.exports = { getDefaults, resolveHygieneConfig };

if (require.main === module) {
  const d = getDefaults();
  process.stdout.write(`tpm-hygiene-config OK — defaults: ${JSON.stringify(d)}\n`);
}
