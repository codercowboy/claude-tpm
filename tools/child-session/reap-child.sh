#!/usr/bin/env bash
# reap-child.sh <session-dir> — finalize an interactive child session once it has
# exited (you quit it from the phone). Detects exit via the screen session being
# gone OR the .child-exited sentinel, stamps session.json (ended_at/status/exit),
# and archives a copy of the child transcript into the session folder so the log
# survives any later sweep of the child project. Non-destructive: does not delete
# the vendored folder (do that explicitly once you're sure).
set -euo pipefail
SESS_DIR="${1:-}"
[ -n "$SESS_DIR" ] && [ -f "$SESS_DIR/session.json" ] || { echo "usage: reap-child.sh <session-dir-with-session.json>" >&2; exit 2; }

python3 - "$SESS_DIR" <<'PY'
import json, os, sys, subprocess, shutil, datetime
sess_dir = sys.argv[1]
sj_path = os.path.join(sess_dir, "session.json")
d = json.load(open(sj_path))
name = d["session_name"]

def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

ls = subprocess.run(["screen", "-ls"], capture_output=True, text=True).stdout
screen_alive = name in ls
sentinel = os.path.join(sess_dir, ".child-exited")
exited = os.path.exists(sentinel)

if screen_alive and not exited:
    print(f"still running: screen '{name}' is alive and no exit sentinel yet. Not reaping.")
    sys.exit(0)

# finalize
exit_note = open(sentinel).read().strip() if exited else "(screen gone; no sentinel)"
code = 0
if exited and "exit=" in exit_note:
    try: code = int(exit_note.split("exit=")[1].split()[0])
    except Exception: code = 0
d["status"] = "completed" if code == 0 else "failed"
d["ended_at"] = now()
d["exit_note"] = exit_note

# archive the child transcript into the session folder
tp = d.get("child_transcript_path", "")
archived = None
if tp and os.path.exists(tp):
    archived = os.path.join(sess_dir, "child-transcript.jsonl")
    shutil.copy2(tp, archived)
    d["archived_transcript"] = archived
d["transcript_present"] = bool(tp and os.path.exists(tp))

json.dump(d, open(sj_path, "w"), indent=2)
print(f"reaped '{name}': status={d['status']} ended_at={d['ended_at']} {exit_note}")
print(f"  transcript archived: {archived or '(not found / not yet written)'}")
PY
