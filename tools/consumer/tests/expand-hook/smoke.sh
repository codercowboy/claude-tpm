#!/usr/bin/env bash
#
# smoke.sh — LLM-in-the-loop proof of the ${TPM_HOME} PreToolUse expand hook. Builds a throwaway
# fixture (a "bundle" dir the hook resolves to + a "project" dir with a real .claude/settings.json
# wiring env.TPM_HOME + the expand hook), then runs two headless `claude -p` probes:
#
#   Probe A — DOES EXPANSION HAPPEN: Claude Reads the literal path `${TPM_HOME}/sentinel.txt`. That
#             path is NOT reachable from the project cwd; it resolves ONLY if the hook rewrites it. If
#             Claude sees the sentinel content, Claude Code honored `updatedInput` end-to-end.
#   Probe B — CAN CLAUDE WRITE THE TOKEN: Claude Writes a file whose CONTENT is the literal
#             `${TPM_HOME}` string. We then read that file from disk and assert the token SURVIVED —
#             proving the hook leaves content fields alone (the self-referential trap) AND that the
#             model will author the literal placeholder. This is the load-bearing question.
#
# Usage:  bash tools/consumer/tests/expand-hook/smoke.sh
# Exit:   0 = both probes passed, 1 = a probe failed, 2 = setup error.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
HOOK="$REPO/tools/consumer/hooks/expand-tpm-home.js"
CHECK="$REPO/tools/consumer/tpm-consumer-check-json.js"
command -v claude >/dev/null 2>&1 || { echo "smoke: 'claude' not on PATH"; exit 2; }
command -v node   >/dev/null 2>&1 || { echo "smoke: 'node' not on PATH"; exit 2; }
[ -f "$HOOK" ]  || { echo "smoke: missing hook $HOOK"; exit 2; }
[ -f "$CHECK" ] || { echo "smoke: missing check-json $CHECK"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tpm-expand-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BUNDLE="$WORK/bundle"; PROJ="$WORK/project"
mkdir -p "$BUNDLE/claude-context/methodology" "$PROJ/.claude"

SENTINEL="TPM-SENTINEL-42-OK"
printf '%s\n' "$SENTINEL" > "$BUNDLE/sentinel.txt"

# Write the consumer's .claude/settings.json via node so abs paths (which contain spaces in this repo)
# are escaped correctly: env.TPM_HOME = the bundle root, PreToolUse hook = our expander.
node -e '
  const fs = require("fs");
  const [, out, home, hook] = process.argv; // node -e: no script-path slot, so argv[1] is the first arg
  // The hook SELF-LOCATES its bundle from __dirname; for this throwaway fixture we point it at the temp
  // "bundle" via the test-only TPM_HOME_OVERRIDE env (a literal abs path — no interpolation needed).
  const settings = {
    env: { TPM_HOME_OVERRIDE: home },
    hooks: { PreToolUse: [ {
      matcher: "Read|Edit|Write|Glob|Grep|NotebookEdit",
      hooks: [ { type: "command", command: "node " + JSON.stringify(hook) } ],
    } ] },
  };
  fs.writeFileSync(out, JSON.stringify(settings, null, 2) + "\n");
' "$PROJ/.claude/settings.json" "$BUNDLE" "$HOOK"

echo "=== \${TPM_HOME} expand-hook smoke ==="
echo "  bundle : $BUNDLE"
echo "  project: $PROJ"
echo ""

PASS=0; FAIL=0

# ── Probe A: expansion actually happens on a Read path ───────────────────────
echo "── probe A: \${TPM_HOME} in a Read path is expanded by the hook"
A_OUT="$( cd "$PROJ" && claude -p \
'Use the Read tool DIRECTLY on this exact literal path, passed verbatim: `${TPM_HOME}/sentinel.txt`. Do NOT use Bash and do NOT try to resolve ${TPM_HOME} yourself — pass the literal string as the file path. Then reply with ONLY this JSON object (no prose, no code fences): {"read_ok": <true|false: did the Read succeed?>, "first_line": "<the exact first line of the file, or empty string>"}' \
  --permission-mode acceptEdits </dev/null 2>&1 )"
if printf '%s' "$A_OUT" | node "$CHECK" --eq read_ok=true --eq "first_line=$SENTINEL"; then
  echo "   ⇒ PASS (hook resolved \${TPM_HOME} → real file)"; PASS=$((PASS+1))
else
  echo "   ⇒ FAIL"; FAIL=$((FAIL+1))
  printf '%s\n' "$A_OUT" | tail -8 | sed 's/^/     A> /'
fi
echo ""

# ── Probe B: Claude can WRITE the literal ${TPM_HOME} (hook leaves content alone) ─
echo "── probe B: Claude can author the literal \${TPM_HOME} token (content not eaten)"
B_OUT="$( cd "$PROJ" && claude -p \
'Use the Write tool to create a file named out.md in the current directory. Its content must be EXACTLY this single line, written literally and verbatim: bundle root is ${TPM_HOME}/tools — do NOT resolve, expand, or substitute ${TPM_HOME}; write those 11 characters ($ { T P M _ H O M E }) literally. Then reply with ONLY this JSON object: {"wrote": <true|false>}' \
  --permission-mode acceptEdits </dev/null 2>&1 )"
if [ -f "$PROJ/out.md" ] && grep -qF '${TPM_HOME}' "$PROJ/out.md"; then
  echo "   ✓ out.md exists and contains the LITERAL \${TPM_HOME}:"
  sed 's/^/       out.md> /' "$PROJ/out.md"
  echo "   ⇒ PASS (the token can be authored under the hook)"; PASS=$((PASS+1))
else
  echo "   ✗ the literal \${TPM_HOME} did NOT survive into out.md"
  [ -f "$PROJ/out.md" ] && { echo "     out.md was:"; sed 's/^/       out.md> /' "$PROJ/out.md"; } || echo "     (out.md was not created)"
  printf '%s\n' "$B_OUT" | tail -8 | sed 's/^/     B> /'
  echo "   ⇒ FAIL"; FAIL=$((FAIL+1))
fi
echo ""

printf '== %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
