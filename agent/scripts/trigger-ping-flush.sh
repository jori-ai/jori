#!/bin/bash
# Ping flush: deliver the non-urgent alerts the motion gate parked while the
# user was walking or driving. Direct local script — no webhook, no agent, no
# Anthropic API (deterministic, cheap, safe on a 5-minute cron).
#
# The gate lives in lib/apns-push.mjs; the queue in lib/ping-hold.mjs.
# Only the ALERT is deferred — every message is already in jori_messages and
# readable in the app, so a flush that never happens loses no content.
#
# Exits immediately when the queue is empty (the overwhelming majority of runs),
# so the 5-minute cadence costs almost nothing.
#
# Kill switch: data/.ping-flush-off — with it present, held pings simply
# age out of the queue and their messages stay in the app unannounced.
source "$(dirname "$0")/lib/root.sh"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/ping-flush.log"

if [ -f "$JORI_INSTALL_TOOLS/data/.ping-flush-off" ]; then
  exit 0
fi

# Silent unless it actually did something — a 5-minute cron that logs every tick
# buries the one line that matters.
OUT=$("${JORI_NODE:-node}" "$JORI_TOOLS/bin/ping-flush" 2>&1)
if [ -n "$OUT" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [ping-flush] $OUT" >> "$LOGFILE"
fi
