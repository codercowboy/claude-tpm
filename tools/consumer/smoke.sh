#!/usr/bin/env bash
#
# smoke.sh — consumer integration smoke tests for claude-tpm.
#
# Runs headless `claude -p` probes INSIDE a claude-tpm CONSUMER project and asserts on them
# DETERMINISTICALLY: each probe asks the consumer-claude to answer in a STRICT JSON schema, then
# tpm-consumer-check-json.js parses that JSON and checks fields (instead of fuzzy-grepping prose). This is the
# LLM-in-the-loop complement to the zero-dep node unit tests — it proves the lived integration (do the
# plugin-delivered tpm-* skills actually surface, and does the bundle's doc / tool resolution work when consumed).
#
# Repeatable + growing: run it after installing into a consumer (`npx tpm install <dir>`), and re-run it
# as we build skills — each new behavior gets one more `probe` below.
#
# Usage:  bash tools/consumer/smoke.sh <consumer-dir>
# Exit:   0 = all probes passed, 1 = a probe failed, 2 = usage error.
#
# NOTE: each `probe` (LLM) is a full headless Claude session (real token cost) — keep the suite lean;
# JSON-schema answers make them far more deterministic than prose, but some variance is still inherent.
# `probe_cli` checks are deterministic and free (no Claude session).
#
# PERMISSION MODE: the LLM probes drive the Read tool from a non-interactive `claude -p` session, which
# blocks on a permission prompt under the default mode (there is no `auto` mode — the modes are default/
# acceptEdits/plan/bypassPermissions). A headless tool-use E2E needs `bypassPermissions` to run unattended
# (empirically confirmed, session 013). That is safe HERE — the session only reads inside the consumer
# dir — but it is why these probes run wide open; do not copy that flag into a less controlled context.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-}"
[ -n "$DIR" ] || { echo "usage: smoke.sh <consumer-dir>"; exit 2; }
[ -d "$DIR" ] || { echo "smoke: no such dir: $DIR"; exit 2; }
command -v claude >/dev/null 2>&1 || { echo "smoke: 'claude' not on PATH"; exit 2; }
command -v node   >/dev/null 2>&1 || { echo "smoke: 'node' not on PATH"; exit 2; }

PASS=0; FAIL=0

# probe <name> <prompt-asking-for-JSON> <tpm-consumer-check-json.js args…>
probe() {
  local name="$1"; shift
  local prompt="$1"; shift
  printf '── probe: %s\n' "$name"
  if ( cd "$DIR" && claude -p "$prompt" --permission-mode bypassPermissions ) </dev/null 2>&1 \
       | node "$HERE/tpm-consumer-check-json.js" "$@"; then
    printf '   ⇒ PASS\n'; PASS=$((PASS + 1))
  else
    printf '   ⇒ FAIL\n'; FAIL=$((FAIL + 1))
  fi
}

# probe_cli <name> <command-string> — a DETERMINISTIC (no-LLM) check that a tpm CLI resolves + runs in
# the consumer. Runs the command from the consumer dir; PASS iff it exits 0. This is the fast complement
# to the LLM probes above — it covers the tool-INVOCATION path (`npx tpm …`) with no token cost.
probe_cli() {
  local name="$1"; local cmd="$2"
  printf '── probe: %s\n' "$name"
  if ( cd "$DIR" && bash -c "$cmd" ) >/dev/null 2>&1; then
    printf '   ⇒ PASS\n'; PASS=$((PASS + 1))
  else
    printf '   ⇒ FAIL\n'; FAIL=$((FAIL + 1))
  fi
}

echo "=== claude-tpm consumer smoke tests → $DIR ==="

# ── PROBES (add one per skill/behavior as the toolset grows) ─────────────────

# 1. Skills present at boot: the plugin delivers the tpm-* skills (eager-loaded by Claude Code), so they are
#    live from message #1 with NO boot preamble (no CLAUDE.md boot block, no boot.md). Ask COLD, assert the JSON.
probe "skills-present" \
'Without reading any "boot" file or special setup instructions, reply with ONLY this JSON object (no prose, no code fences), describing the skills / slash-commands available to you right now:
{"tpm_skills": [<exact names of every tpm-* skill available to you, e.g. tpm-session>],
 "tpm_session_present": <true|false>,
 "tpm_workflow_present": <true|false>,
 "notes": "<any errors, else empty string>"}' \
  --eq tpm_session_present=true \
  --eq tpm_workflow_present=true \
  --includes tpm_skills=tpm-session \
  --includes tpm_skills=tpm-workflow

# 2. DEEP: a skill that must read the SHARED methodology. Skills read methodology through the self-locating
#    `npx tpm doc <bundle-relative-path>` verb (it prints the doc with the bundle-home placeholder resolved),
#    so the read works wherever the plugin's folder lives. The probe has the skill flow actually open one.
probe "methodology-resolves" \
'Begin the first steps of the /tpm-session open ritual — which requires READING a claude-tpm methodology file (e.g. its orchestrator reading-list, or something under claude-context/methodology/). ACTUALLY try to open one such file from disk (do not simulate). Then reply with ONLY this JSON object (no prose, no code fences):
{"skill_flow_started": <true|false>,
 "methodology_files_readable": <true|false: did a methodology file actually open from disk?>,
 "example_path_tried": "<the exact path you tried to read>",
 "first_error": "<the error text if the read failed, else empty string>"}' \
  --eq methodology_files_readable=true

# 3. DOC RESOLUTION (deterministic, no LLM): `npx tpm doc <path>` resolves a bundle doc from the consumer —
#    it prints the doc's content and never leaves an unresolved %TPM_HOME% / ${TPM_HOME} placeholder in it —
#    and `npx tpm resolve-home` prints an existing folder (the bundle root). This replaces the retired
#    probe of the old `${TPM_HOME}` content-hook rewrite, which no longer exists.
probe_cli "tpm-doc-resolves" \
  'out="$(npx tpm doc claude-context/methodology/overview.md)" && [ -n "$out" ] && ! printf "%s" "$out" | grep -qE "%TPM_HOME%|[$][{]TPM_HOME[}]" && [ -d "$(npx tpm resolve-home)" ]'

# 4. TOOL INVOCATION: skills invoke bundle tools via `npx tpm <suite> <verb>` (the routers self-locate the
#    bundle — no env var needed). Prove the `tpm` bin actually resolves and runs FROM the consumer
#    (the consumer's node_modules/.bin/tpm). Deterministic (no LLM). DELIBERATE: this one uses `npx tpm`
#    itself, because that exact resolution path is what is under test.
probe_cli "npx-tpm-resolves" 'npx tpm session config --json | grep -q "\"enabled\""'

echo ""
printf '== %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
