#!/bin/bash
# photos-intraday — index *today's* Apple Photos every 30 min (crontab
# 15,45 * * * *, offset from photos-daily's :00 slot), so same-day stops and
# companions surface before the 03:00 photos-daily pass. See
# jobs/photos-intraday.md.
#
# A DIRECT script, no webhook and no agent turn: every step is a fixed command
# — sync, backfill companions, synthesize stops — with no judgment in between.
# As a webhook job it would spend 48 ops turns a day typing three commands (a
# script needs no agent in front of it).
#
# The sync must run from cron anyway: osxphotos drives Photos.app over Apple
# events, which the agent's Bash sandbox blocks (ScriptError -2741).
#
# Silent: everything goes to watchdog.log. Kill switch: data/.photos-intraday-off.

source "$(dirname "$0")/lib/root.sh"
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"   # osxphotos lives in ~/.local/bin (pipx)
G="$JORI_INSTALL_TOOLS"
LOGFILE="$G/agent/logs/watchdog.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [photos-intraday] $1" >> "$LOGFILE"; }

[ -f "$G/data/.photos-intraday-off" ] && exit 0

# Each step's failure is logged, never fatal — the next steps still have work,
# and the next tick is 30 min away.
run_step() {
  local name="$1"; shift
  local out; out=$("$@" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ]; then log "$name ok: $(echo "$out" | tr -d '\n' | tail -c 120)"
  else log "$name FAILED ($rc): $(echo "$out" | tail -1 | cut -c1-200)"; fi
  return $rc
}

FAILED=0
# `photos` caps its own osxphotos call at 600s, well inside the 30-min tick.
run_step sync "$G/bin/photos" sync --date today || FAILED=1
run_step companions "$G/bin/findme" backfill-companions --lookback 2 --json || FAILED=1
# Today in the user's local zone, the day `photos sync --date today` indexed.
DATE=$("$G/bin/local-day" today 2>/dev/null) || DATE=$(date '+%Y-%m-%d')
run_step synthesize env DROP=1 "$G/bin/photos-synthesize-stops" "$DATE" || FAILED=1
exit $FAILED
