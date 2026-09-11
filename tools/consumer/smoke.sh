#!/usr/bin/env bash
#
# smoke.sh — consumer integration smoke tests for claude-tpm.
#
# Runs headless `claude -p` probes INSIDE a claude-tpm CONSUMER project and asserts on them
# DETERMINISTICALLY: each probe asks the consumer-claude to answer in a STRICT JSON schema, then
# check-json.js parses that JSON and checks fields (instead of fuzzy-grepping prose). This is the
# LLM-in-the-loop complement to the zero-dep node unit tests — it proves the lived integration (does the
# CLAUDE.md -> boot.md -> skill-discovery flow actually work when consumed).
#
# Repeatable + growing: run it after scaffolding a consumer (the scaffolder offers to), and re-run it as
# we build skills — each new behavior gets one more `probe` below.
#
# Usage:  bash tools/consumer/smoke.sh <consumer-dir>
# Exit:   0 = all probes passed, 1 = a probe failed, 2 = usage error.
#
# NOTE: each probe is a full headless Claude session (real token cost) — keep the suite lean. JSON-schema
# answers make it far more deterministic than prose, but some variance is still inherent.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-}"
[ -n "$DIR" ] || { echo "usage: smoke.sh <consumer-dir>"; exit 2; }
[ -d "$DIR" ] || { echo "smoke: no such dir: $DIR"; exit 2; }
command -v claude >/dev/null 2>&1 || { echo "smoke: 'claude' not on PATH"; exit 2; }
command -v node   >/dev/null 2>&1 || { echo "smoke: 'node' not on PATH"; exit 2; }

PASS=0; FAIL=0

# probe <name> <prompt-asking-for-JSON> <check-json.js args…>
probe() {
  local name="$1"; shift
  local prompt="$1"; shift
  printf '── probe: %s\n' "$name"
  if ( cd "$DIR" && claude -p "$prompt" --permission-mode auto ) </dev/null 2>&1 \
       | node "$HERE/check-json.js" "$@"; then
    printf '   ⇒ PASS\n'; PASS=$((PASS + 1))
  else
    printf '   ⇒ FAIL\n'; FAIL=$((FAIL + 1))
  fi
}

echo "=== claude-tpm consumer smoke tests → $DIR ==="

# ── PROBES (add one per skill/behavior as the toolset grows) ─────────────────

# 1. Boot -> discovery: the vendored tpm-* skills surface, self-reported in strict JSON.
probe "boot-and-skills" \
'Follow the boot instructions in your CLAUDE.md, then reply with ONLY this JSON object (no prose, no code fences):
{"boot_ran": <true|false: did you read boot.md?>,
 "tpm_skills": [<exact names of every tpm-* skill available to you>],
 "tpm_session_present": <true|false>,
 "tpm_workflow_present": <true|false>,
 "notes": "<any missing-file or path errors you hit while booting, else empty string>"}' \
  --truthy boot_ran \
  --eq tpm_session_present=true \
  --eq tpm_workflow_present=true \
  --includes tpm_skills=tpm-session \
  --includes tpm_skills=tpm-workflow

# 2. DEEP: a skill that must read the SHARED methodology — exposes the relocatable-paths blocker.
#    RED until the fix: skills reference `claude-context/methodology/…` at the CONSUMER root (doesn't
#    exist); the bundle's copy lives under `node_modules/@codercowboy/claude-tpm/`. Goes GREEN once refs
#    are anchored to the skill's base directory (the bundle root).
probe "methodology-resolves" \
'Follow the boot instructions in your CLAUDE.md, then actually attempt the first steps of the /tpm-session open ritual — which requires READING a claude-tpm methodology file (e.g. its subagent reading-list, or something under claude-context/methodology/). ACTUALLY try to open one such file from disk (do not simulate). Then reply with ONLY this JSON object (no prose, no code fences):
{"skill_flow_started": <true|false>,
 "methodology_files_readable": <true|false: did a methodology file actually open from disk?>,
 "example_path_tried": "<the exact path you tried to read>",
 "first_error": "<the error text if the read failed, else empty string>"}' \
  --eq methodology_files_readable=true

# 3. TOKEN RESOLUTION: the ${TPM_HOME} placeholder in a skill's bundle refs resolves in a consumer —
#    a methodology READ (self-locating expand hook) proven from the consumer root. (The Bash tool-run
#    half, `node ${TPM_HOME}/tools/…` via the relative env var, is covered by the expand-hook tests +
#    the manual e2e; it needs elevated Bash perms this read-only probe deliberately avoids.)
probe "token-methodology-read" \
'Use the Read tool on this exact literal path, verbatim (do NOT resolve ${TPM_HOME} yourself): `${TPM_HOME}/claude-context/methodology/overview.md`. Then reply with ONLY this JSON (no prose): {"read_ok": <true|false>, "first_line": "<the exact first line of the file, or empty string>"}' \
  --truthy read_ok \
  --truthy first_line

echo ""
printf '== %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
