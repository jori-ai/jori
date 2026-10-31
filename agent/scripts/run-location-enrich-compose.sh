#!/bin/bash
# run-location-enrich-compose — what the launchd agent ai.claude.location-enrich-compose
# runs when trigger-location-enrich.sh kicks it (2026-10-04).
#
# 1. bin/location-enrich-compose composes every askable stop in code + one
#    batched model call (local Gemma, then Sonnet low on the Max session — which
#    is why this runs in the GUI session, not cron) and queues the asks.
# 2. Only if it left RESIDUE (a stop with a calendar event in its window, or one
#    no rung could phrase validly) is the location-enrich agent dispatched, and
#    that turn handles only the visits listed in location-enrich-residue.json.
#
# Fail-open: if compose itself breaks, it lists every stop as residue, so the
# agent still gets the work it used to get every time.
source "$(dirname "$0")/lib/webhook-auth.sh"
export PATH="/opt/homebrew/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"       # JORI_INSTALL_TOOLS, JORI_NODE
source "$(dirname "$0")/lib/instance.sh"   # JORI_TZ (the home zone)

resolve_tier_ports location-enrich
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/watchdog.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [location-enrich] $1" >> "$LOGFILE"; }

OUT=$("$JORI_INSTALL_TOOLS/bin/location-enrich-compose" --json 2>>"$JORI_INSTALL_TOOLS/data/logs/location-enrich-compose.err")
N_COMPOSED=$(echo "$OUT" | jq -r '(.composed // []) | length' 2>/dev/null || echo "?")
N_RESIDUE=$(echo "$OUT" | jq -r '.residue // 0' 2>/dev/null || echo 0)
log "compose: queued=$N_COMPOSED residue=$N_RESIDUE"

if [ "$N_RESIDUE" = "0" ]; then
  exit 0
fi

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  [ "$(echo "$health" | jq -r '.childAlive // false' 2>/dev/null)" = "true" ]
}

if is_healthy; then
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d '{"job": "location-enrich"}' > /dev/null 2>&1
  log "Dispatched location-enrich for $N_RESIDUE residue stop(s)"
else
  log "location-enrich residue ($N_RESIDUE) not dispatched: supervisor unhealthy — next tick retries"
fi
