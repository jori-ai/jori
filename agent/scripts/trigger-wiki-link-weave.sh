#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger wiki-link-weave via webhook → ops-light.
#
# Weekly, Monday night — after Sunday's memory-consolidation, so merges and
# retires have landed before this links to them. Precomputes the person-graph
# audit and this week's changed pages into data so the turn starts with
# them. See jobs/wiki-link-weave.md.
#
# Why weekly and model-driven: links between concepts that a name list can't
# catch (a relational phrase like "her sons" → each son's page).

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"

resolve_tier_ports wiki-link-weave   # job-routing.json → ops-light
source "$(dirname "$0")/lib/root.sh"
ROOT="$JORI_TOOLS"
DATA="$ROOT/data"
LOGFILE="$ROOT/agent/logs/watchdog.log"
PAYLOAD='{"job": "wiki-link-weave"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [wiki-link-weave] $1" >> "$LOGFILE"; }

"$ROOT/bin/wiki-people" audit --json > "$DATA/wiki-link-weave-audit.json" 2>/dev/null \
  || log "audit precompute failed (the turn reruns it)"
"$ROOT/bin/wiki" recent --days 7 --json > "$DATA/wiki-link-weave-recent.json" 2>/dev/null \
  || log "recent precompute failed (the turn reruns it)"

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  echo "$health" | grep -q '"childAlive":true'
}

dispatch() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" 2>/dev/null)
  [ "${code:0:1}" = "2" ]
}

if is_healthy && dispatch; then
  log "Dispatched wiki-link-weave"
  exit 0
fi

sleep 60
if is_healthy && dispatch; then
  log "Dispatched wiki-link-weave (retry)"
  exit 0
fi

log "wiki-link-weave failed: supervisor unhealthy after retry"
exit 1
