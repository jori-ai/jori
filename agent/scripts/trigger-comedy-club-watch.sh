#!/bin/bash
set -uo pipefail

# Comedy Club Watch trigger — big-name comedians booking small rooms.
# High cadence on purpose: a small-room on-sale can close within hours of the
# announcement, faster than a weekly poller looks. Kept cheap by running the
# venue sweep as code and doing the per-artist (model) sweep only on the daily
# deep pass.
#
# The run itself (bin/comedy-club-watch-run --scheduled) applies this
# installation's quiet hours and pause file (lib/comedy-config.cjs) and is off
# when no rooms are configured. This trigger only keeps two runs from
# overlapping: a slow deep pass must not overlap the next fast pass.

source "$(dirname "$0")/lib/script-job-env.sh"   # JORI_REPO, JORI_INSTALL_TOOLS, run_script_job

STATE_DIR="$JORI_INSTALL_TOOLS/data"
LOCK="$STATE_DIR/comedy-club-watch.lock"
mkdir -p "$STATE_DIR"

if [[ -f "$LOCK" ]]; then
  LOCK_PID=$(cat "$LOCK" 2>/dev/null || echo "")
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    exit 0
  fi
  # Stale lock (holder is gone) — reclaim it.
  rm -f "$LOCK"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Direction B runs as code. It dispatches a Haiku turn itself only when a
# roster hit needs the calendar check, and once a day (deep pass) for
# Direction A's roster-down web search.
run_script_job comedy-club-watch "$JORI_REPO/bin/comedy-club-watch-run" --scheduled "$@"
exit 0
