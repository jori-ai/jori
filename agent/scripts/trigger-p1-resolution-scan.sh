#!/bin/bash
# P1 resolution sweeps — every 30 min (system/tasks.json), pure code, no
# agent turn. Playbook: agent/ops-agent/jobs/p1-resolve.md.
#
#   1. p1-reply-sweep  (Signal D, 2026-09-11): a starred P1 whose thread's newest
#      message the user SENT is downgraded and its Google Task closed.
#   2. p1-unstar-sweep (Signal A, 2026-10-04): a P1 the user UNSTARRED — proven by
#      a STARRED-removed event in Gmail history that Jori's own gmail-action
#      did not make — is downgraded via unstar-scan-run (p1-downgrade +
#      p1-alert-gate). This replaced the ops-haiku "UNSTAR SCAN P1" dispatch and
#      its p1-scan-gate / jev-p1-gate pre-gates: the one judgment that turn made
#      ("was this unstarred P1 ever starred?") is answered by history.
#
# Silent by design — no phone ping; failures page only through p1-alert-gate.
# Kill switches: data/.p1-reply-sweep-off, data/.p1-unstar-sweep-off.

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS

DATA="$JORI_INSTALL_TOOLS/data"
BIN="$JORI_INSTALL_TOOLS/bin"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/p1-resolution-scan.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [p1-resolution-scan] $1" >> "$LOGFILE"; }

if [ ! -f "$DATA/.p1-reply-sweep-off" ]; then
  "$BIN/p1-reply-sweep" >>"$LOGFILE" 2>&1 || log "p1-reply-sweep exited $? (non-fatal)"
fi

if [ ! -f "$DATA/.p1-unstar-sweep-off" ]; then
  "$BIN/p1-unstar-sweep" >>"$LOGFILE" 2>&1 || log "p1-unstar-sweep exited $? (non-fatal)"
fi

exit 0
