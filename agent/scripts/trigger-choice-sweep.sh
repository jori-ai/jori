#!/bin/bash
# Choice sweep: an expired, unanswered "where was this?" card's default is
# applied as a LOW-CONFIDENCE guess. Direct local script — no webhook, no
# agent, no Anthropic API.
#
# `choice sweep --apply` hands it to `findme guess`, which writes only that
# card's own visit row as place_type='default-applied' (never user-confirmed,
# never confirmed-stops.json, so it cannot name another stop) and refuses a row
# the user already answered. Nothing is posted in the chat; a later tap replaces
# the guess through the normal reply path. Other card kinds are only reported.
#
# Hourly, not every few minutes: prompts carry a 12h expiry by default, so
# nothing is gained by checking often, and a slower cadence keeps a bug from
# writing a lot before anyone notices.
#
# Kill switch: data/.choice-sweep-off — with it present, prompts simply
# stay open and unguessed, which is harmless.
source "$(dirname "$0")/lib/root.sh"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
LOGFILE="$JORI_INSTALL/agent/logs/choice-sweep.log"
mkdir -p "$(dirname "$LOGFILE")"

if [ -f "$JORI_INSTALL/data/.choice-sweep-off" ]; then
  exit 0
fi

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) choice-sweep ==="
  "$JORI_TOOLS/bin/choice" sweep --apply 2>&1
} >> "$LOGFILE" 2>&1
