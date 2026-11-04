#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger memory-consolidation via webhook → ops agent.
# Cron: 0 10 * * 0  (Sundays at 10:00 local)
#
# Weekly content-level audit of the WIKI (`pages` table in memory-index.db) —
# auto-applies merges/supersedes/retires/expands via the `wiki` CLI, then emails
# a report. The hygiene counterpart to the wiki's writers (daily-summary,
# hum-consolidate, chat-consolidate). See jobs/memory-consolidation.md.
#
# 2026-04-17: new weekly job per s-20260417 review item #15.
# 2026-07-19: repointed from the legacy .md files (a no-op under DB-as-truth —
#   render-all clobbered .md edits within 30 min) to the authoritative wiki DB.

export PATH="/opt/homebrew/bin:$PATH"

resolve_tier_ports memory-consolidation   # tier-routes WEBHOOK_PORT + HEALTH_PORT (was :9092 Opus)
source "$(dirname "$0")/lib/root.sh"
LOGFILE="$JORI_TOOLS/agent/logs/watchdog.log"
PAYLOAD='{"job": "memory-consolidation"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [memory-consolidation] $1" >> "$LOGFILE"; }

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  echo "$health" | grep -q '"childAlive":true' || return 1
  return 0
}

dispatch() {
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" > /dev/null 2>&1
}

if is_healthy; then
  dispatch
  log "Dispatched memory-consolidation"
  exit 0
fi

sleep 60
if is_healthy; then
  dispatch
  log "Dispatched memory-consolidation (retry)"
  exit 0
fi

log "memory-consolidation failed: supervisor unhealthy after retry"
exit 1
