#!/usr/bin/env bash
# tpm-child-watch.sh <pid> <screen-name> <child-cwd>
# Waits until the interactive child registers a ~/.claude/sessions/<pid>.json
# (happens once a Remote Control client attaches), resolves its sessionId ->
# transcript path, then waits for the first real user message and reports it.
set -uo pipefail
PID="$1"; NAME="$2"; CWD="$3"
ESC="$(printf '%s' "$CWD" | LC_ALL=C sed -E 's/[^a-zA-Z0-9]/-/g')"
SJSON="$HOME/.claude/sessions/${PID}.json"
echo "watching pid=$PID name=$NAME"
for i in $(seq 1 300); do   # ~40 min at 8s
  # NOTE: `screen -ls` exits non-zero even on success; piping it under pipefail
  # made this misfire. Capture to a var and substring-match instead.
  LS_OUT="$(screen -ls 2>/dev/null || true)"
  case "$LS_OUT" in *"$NAME"*) : ;; *) echo "CHILD DIED (screen gone) at poll $i"; exit 0 ;; esac
  if [ -f "$SJSON" ]; then
    SID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sessionId",""))' "$SJSON" 2>/dev/null || true)"
    if [ -n "$SID" ]; then
      TP="$HOME/.claude/projects/${ESC}/${SID}.jsonl"
      if [ -f "$TP" ] && grep -q '"type":"user"' "$TP"; then
        echo "RESOLVED sessionId=$SID"
        echo "TRANSCRIPT=$TP"
        echo "USER_MESSAGE_PRESENT at poll $i ($(date -u +%H:%M:%SZ))"
        exit 0
      fi
    fi
  fi
  sleep 8
done
echo "TIMEOUT — no user message within window"
