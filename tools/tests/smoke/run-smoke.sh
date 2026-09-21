#!/usr/bin/env bash
#
# run-smoke.sh — the Stage-D FUNCTIONAL smoke harness for claude-tpm's promoted session/task tooling.
#
# WHAT THIS IS (vs the other smokes — read once to avoid "three smokes" confusion):
#   • tools/consumer/smoke.sh          = QUICK install-sanity probe (does the plugin load + resolve refs).
#   • tools/tests/smoke/  (THIS rig)   = richer DOC-DRIVEN FUNCTIONAL smoke: lay a SELECTED set of
#                                        stand-alone prose test docs into a fresh consumer, then let a
#                                        headless ORCHESTRATOR-shaped agent work through them and leave
#                                        structured 3-bucket feedback. It answers the "spiritual" question:
#                                        does the promoted session/task tooling actually WORK when a real
#                                        headless agent uses it via the skills / `npx tpm` verbs — no hooks,
#                                        no spoon-feeding?
#
# FLOW
#   1. scaffold a fresh consumer (--fresh) OR point at an existing one (--target <dir>).
#   2. CONFIGURE the consumer's stores: write .claude/claude-tpm/config.json with a tasksDir + sessionsDir
#      so `npx tpm task/session config --tasks-dir/--sessions-dir` RESOLVE (a bare consumer errors
#      "--tasks-dir <dir> is required" — proven #1126.G; every task/session verb needs the dir on the CLI).
#   3. lay down ONLY the --tests-selected docs/test-*.md into <consumer>/smoke/  (workflow / resume docs
#      are NEVER laid down by a session/task run — selective lay-down is the point).
#   4. spawn an ORCHESTRATOR-shaped headless `claude -p` (permission mode per --mode) whose prompt says:
#      "work through each smoke/*.md in order; do exactly what each says using the claude-tpm skills /
#       `npx tpm <suite> <verb>` verbs; append your results + the 3-bucket feedback to smoke/feedback-<doc>.md."
#   5. leave the consumer + feedback files on disk for inspection.
#
# SCAFFOLD REUSE:  the --fresh path PORTS the proven claude-tpm-dev/tools/hooktest/scaffold-consumer.sh
#   logic inline (npm init -y + `npx tpm install <dir> --force --quiet` FROM the bundle + a ~/.claude.json
#   folder-trust seed). Ported (not called) on purpose: this rig SHIPS inside the bundle and must be
#   self-contained — it cannot reach back into the claude-tpm-dev workspace, which is absent for a consumer.
#
# SWEEP:  prior smoketest-* runs under the scratch root are moved aside to <scratch>/safe-to-delete via
#   `mv` (this rig NEVER `rm`s).
#
# USAGE
#   bash run-smoke.sh --help
#   bash run-smoke.sh --fresh --mode auto --tests test-session-smoke,test-task-smoke
#   bash run-smoke.sh --target /path/to/consumer --tests test-task-smoke --no-agent
#
# FLAGS
#   --tests <comma-list>   which docs to lay down (e.g. test-session-smoke,test-task-smoke). The "test-"
#                          prefix and ".md" suffix are optional. Default: test-session-smoke,test-task-smoke.
#   --mode auto|dangerous  permission mode for the spawned agent. Default auto =
#                            --permission-mode acceptEdits  (+ --allowedTools "Bash,Read,Write,Edit,Glob,Grep").
#                          dangerous = --dangerously-skip-permissions (OPT-IN; not needed for the first run).
#   --fresh                scaffold a NEW consumer under <scratch>/smoketest-<slug> (default if no --target).
#   --target <dir>         use an EXISTING consumer dir instead of scaffolding.
#   --no-agent             do everything EXCEPT spawn the agent (scaffold + configure + lay down), then print
#                          the exact `claude -p` command it WOULD have run. For CI / lay-down / flag checks.
#   --timeout <secs>       wall-clock cap for the spawned agent (default 600).
#   --help                 this message.
#
# ENV
#   SMOKE_TMP   override the scratch root (default: the bundle's sibling workspace tmp if present, else
#               <bundle>/tmp). Scaffolded consumers + the safe-to-delete graveyard live under it.
#
# EXIT   0 ok · 2 usage error · 1 a step failed.

set -uo pipefail

# ── self-location (no hardcoded absolutes) ───────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"          # <bundle>/tools/tests/smoke
BUNDLE="$(cd "$HERE/../../.." && pwd)"          # smoke -> tests -> tools -> <bundle>
DOCS_DIR="$HERE/docs"
WS="$(cd "$BUNDLE/.." && pwd)"                  # the workspace that holds the bundle (dev-side) — may not
                                               # exist meaningfully consumer-side; only used for the tmp default.
SCRATCH_ROOT="${SMOKE_TMP:-$WS/tmp}"
SAFE="$SCRATCH_ROOT/safe-to-delete"

# ── defaults ─────────────────────────────────────────────────────────────────────────────────────────
TESTS="test-session-smoke,test-task-smoke"
MODE="auto"
FRESH=0
TARGET=""
NO_AGENT=0
TIMEOUT=600

die()   { echo "run-smoke: $*" >&2; exit 1; }
usage_err() { echo "run-smoke: $*" >&2; echo "run 'bash run-smoke.sh --help' for usage." >&2; exit 2; }

print_help() { sed -n '2,/^# EXIT /p' "$0" | sed 's/^# \{0,1\}//'; }

# ── parse args ───────────────────────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --tests)    TESTS="${2:-}"; shift 2 || usage_err "--tests needs a comma-list";;
    --mode)     MODE="${2:-}";  shift 2 || usage_err "--mode needs auto|dangerous";;
    --fresh)    FRESH=1; shift;;
    --target)   TARGET="${2:-}"; shift 2 || usage_err "--target needs a dir";;
    --no-agent) NO_AGENT=1; shift;;
    --timeout)  TIMEOUT="${2:-}"; shift 2 || usage_err "--timeout needs seconds";;
    --help|-h)  print_help; exit 0;;
    *)          usage_err "unknown flag: $1";;
  esac
done

case "$MODE" in auto|dangerous) ;; *) usage_err "--mode must be auto|dangerous (got '$MODE')";; esac
[ -n "$TESTS" ] || usage_err "--tests must not be empty"
if [ -n "$TARGET" ] && [ "$FRESH" = "1" ]; then usage_err "--fresh and --target are mutually exclusive"; fi
if [ -z "$TARGET" ]; then FRESH=1; fi   # no target ⇒ fresh

command -v node >/dev/null 2>&1 || die "node not on PATH"
[ -d "$BUNDLE/.claude-plugin" ] || die "no plugin bundle at $BUNDLE (self-location failed?)"

# ── resolve the requested test docs to files (fail loud on an unknown name) ──────────────────────────
# Normalizes "session-smoke", "test-session-smoke", "test-session-smoke.md" → docs/test-session-smoke.md.
declare -a DOC_FILES=()
declare -a DOC_NAMES=()
IFS=',' read -r -a _req <<< "$TESTS"
for raw in "${_req[@]}"; do
  name="$(echo "$raw" | tr -d '[:space:]')"
  [ -n "$name" ] || continue
  name="${name%.md}"
  case "$name" in test-*) ;; *) name="test-$name";; esac
  f="$DOCS_DIR/$name.md"
  [ -f "$f" ] || die "unknown test doc '$raw' → expected $f (available: $(cd "$DOCS_DIR" && ls test-*.md 2>/dev/null | tr '\n' ' '))"
  DOC_FILES+=("$f")
  DOC_NAMES+=("$name")
done
[ "${#DOC_FILES[@]}" -gt 0 ] || die "no valid test docs resolved from --tests '$TESTS'"

# ── scaffold (ported from hooktest/scaffold-consumer.sh) OR point at an existing consumer ─────────────
sweep_prior() {
  mkdir -p "$SAFE"
  for d in "$SCRATCH_ROOT"/smoketest-*; do
    [ -d "$d" ] || continue
    echo "→ sweeping prior run aside: $d  →  $SAFE/"
    mv "$d" "$SAFE/$(basename "$d").swept-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  done
}

scaffold_fresh() {
  command -v npm >/dev/null 2>&1 || die "npm not on PATH (needed for --fresh)"
  sweep_prior
  local slug; slug="$(printf '%06d' $(( (RANDOM*RANDOM) % 1000000 )))"
  local dir="$SCRATCH_ROOT/smoketest-$slug"
  mkdir -p "$dir" || die "mkdir failed: $dir"
  local abs; abs="$(cd "$dir" && pwd)"
  echo "→ scaffolding fresh consumer: $abs"
  ( cd "$abs" && npm init -y >/dev/null 2>&1 ) || die "npm init failed in $abs"
  # install the plugin FROM the bundle, non-interactive (--quiet = assume-yes off-TTY), --force busts the
  # #1104 stale-plugin-cache blind spot so the loaded skills/hooks match this bundle's source.
  ( cd "$BUNDLE" && npx tpm install "$abs" --force --quiet ) \
    || die "'npx tpm install $abs --force --quiet' failed (from $BUNDLE)"
  # seed folder-trust in ~/.claude.json so a headless `claude` launch there does not stall on the
  # folder-trust dialog (--dangerously-skip-permissions does NOT skip that dialog). Back up first.
  local bk="$SAFE/claude-json-backups"; mkdir -p "$bk"
  cp "$HOME/.claude.json" "$bk/claude.json.$(date +%Y%m%d-%H%M%S).$$" 2>/dev/null || true
  node -e '
    const fs=require("fs"), os=require("os");
    const p=os.homedir()+"/.claude.json", dir=process.argv[1];
    let j={}; try { j=JSON.parse(fs.readFileSync(p,"utf8")); } catch(e){}
    j.projects = j.projects || {};
    j.projects[dir] = Object.assign({}, j.projects[dir], { hasTrustDialogAccepted:true });
    fs.writeFileSync(p, JSON.stringify(j,null,2));
  ' "$abs" || die "folder-trust seed failed for $abs"
  echo "$abs"
}

if [ "$FRESH" = "1" ]; then
  CONSUMER="$(scaffold_fresh)" || exit 1
  CONSUMER="$(echo "$CONSUMER" | tail -1)"
else
  [ -d "$TARGET" ] || die "--target dir does not exist: $TARGET"
  CONSUMER="$(cd "$TARGET" && pwd)"
  echo "→ using existing consumer: $CONSUMER"
fi

# ── configure the consumer's stores (#1126.G) ────────────────────────────────────────────────────────
CFG="$CONSUMER/.claude/claude-tpm/config.json"
mkdir -p "$(dirname "$CFG")"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<'JSON'
{
  "version": 1,
  "session": { "notes": { "sessionsDir": ".claude/claude-tpm/sessions" } },
  "tasks":   { "tasksDir":   ".claude/claude-tpm/tasks" }
}
JSON
  echo "→ wrote store config: $CFG"
else
  echo "→ store config already present: $CFG (left as-is)"
fi
# Resolve + report the stores the agent will use (proves the config resolves; fail loud if it does not).
TASKS_DIR="$( cd "$CONSUMER" && node "$BUNDLE/tools/tpm.js" task config --tasks-dir 2>/dev/null )" \
  || die "task config --tasks-dir failed to resolve in $CONSUMER"
SESSIONS_DIR="$( cd "$CONSUMER" && node "$BUNDLE/tools/tpm.js" session config --sessions-dir 2>/dev/null )" \
  || die "session config --sessions-dir failed to resolve in $CONSUMER"
echo "   tasks-dir    → $TASKS_DIR"
echo "   sessions-dir → $SESSIONS_DIR"

# ── lay down ONLY the selected docs (+ the migrate fixture when details is selected) ─────────────────
SMOKE="$CONSUMER/smoke"
mkdir -p "$SMOKE"
echo "→ laying down ${#DOC_FILES[@]} test doc(s) into $SMOKE/"
laid=()
for i in "${!DOC_FILES[@]}"; do
  cp "${DOC_FILES[$i]}" "$SMOKE/${DOC_NAMES[$i]}.md"
  laid+=("${DOC_NAMES[$i]}.md")
  echo "   • ${DOC_NAMES[$i]}.md"
  # test-session-details drives a `session migrate` on an old marked 3-file store → lay its fixture too.
  if [ "${DOC_NAMES[$i]}" = "test-session-details" ]; then
    if [ -d "$DOCS_DIR/fixtures/old-session" ]; then
      mkdir -p "$SMOKE/fixtures/old-session-0007"
      cp "$DOCS_DIR"/fixtures/old-session/* "$SMOKE/fixtures/old-session-0007/" 2>/dev/null || true
      echo "     ↳ fixture: smoke/fixtures/old-session-0007/ (for the migrate step)"
    fi
  fi
done

# ── compose the orchestrator prompt ──────────────────────────────────────────────────────────────────
read -r -d '' AGENT_PROMPT <<PROMPT
You are a smoke ORCHESTRATOR for the claude-tpm session/task tooling, running headless inside a fresh
consumer project. Your job: work through the prose test docs in ./smoke/ IN ORDER and leave structured
feedback, exactly as each doc instructs.

Rules:
  • This project's task/session stores are already configured. Resolve them ONCE and reuse:
      TASKS_DIR    = \$(npx tpm task config --tasks-dir)
      SESSIONS_DIR = \$(npx tpm session config --sessions-dir)
    Pass --tasks-dir "\$TASKS_DIR" / --sessions-dir "\$SESSIONS_DIR" on every task/session verb (they are
    REQUIRED — the tools never default to a live store).
  • Use ONLY the claude-tpm skills and \`npx tpm <suite> <verb>\` verbs the docs name. Never call a .js path.
  • For EACH doc smoke/<doc>.md: do exactly what it says, then WRITE your results + the doc's required
    3-bucket feedback (What worked / What didn't / What would help to work differently) plus a per-step
    PASS/FAIL summary to smoke/feedback-<doc>.md (e.g. smoke/feedback-test-session-smoke.md).
  • Be honest in the feedback: quote the exact command and what actually happened. A friction point IS the
    signal this smoke exists to capture — do not paper over it.

Docs to work through, in order: ${laid[*]}

When every doc is done, reply with only: SMOKE COMPLETE.
PROMPT

# ── build the claude -p command per --mode ──────────────────────────────────────────────────────────
declare -a CMD=( claude -p "$AGENT_PROMPT" )
if [ "$MODE" = "dangerous" ]; then
  CMD+=( --dangerously-skip-permissions )
else
  CMD+=( --permission-mode acceptEdits --allowedTools "Bash,Read,Write,Edit,Glob,Grep" )
fi

echo
echo "=== consumer ready: $CONSUMER ==="
echo "    mode:  $MODE"
echo "    docs:  ${laid[*]}"
echo "    feedback will land at: $SMOKE/feedback-<doc>.md"

if [ "$NO_AGENT" = "1" ]; then
  echo
  echo "--no-agent: skipping the headless agent spawn. It WOULD have run (from $CONSUMER):"
  printf '    claude -p <orchestrator-prompt>'
  if [ "$MODE" = "dangerous" ]; then printf ' --dangerously-skip-permissions\n'
  else printf ' --permission-mode acceptEdits --allowedTools "Bash,Read,Write,Edit,Glob,Grep"\n'; fi
  echo
  echo "laid-down docs present in $SMOKE/:"
  ( cd "$SMOKE" && ls -1 *.md 2>/dev/null | sed 's/^/    /' )
  exit 0
fi

command -v claude >/dev/null 2>&1 || die "'claude' not on PATH (needed to spawn the agent; use --no-agent to skip)"
echo
echo "=== spawning headless orchestrator (timeout ${TIMEOUT}s) ==="
( cd "$CONSUMER" && perl -e 'alarm shift; exec @ARGV' "$TIMEOUT" "${CMD[@]}" </dev/null )
rc=$?

echo
echo "=== smoke run complete (agent exit $rc) → $CONSUMER ==="
echo "feedback files:"
( cd "$SMOKE" && ls -1 feedback-*.md 2>/dev/null | sed 's/^/    /' ) || echo "    (none written — inspect the session output above)"
exit 0
