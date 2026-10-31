#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/root.sh"
# Dispatch for purchase-signin (keeps the shop Chrome signed in, jobs/purchase-signin.md).
# Weekly cron (daytime: 2FA codes go to the user's phone) or on demand.
# Retries once after 60s if the supervisor is unhealthy.

export PATH="/opt/homebrew/bin:$PATH"

HEALTH_PORT=9093
WEBHOOK_PORT=9092
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/watchdog.log"
PAYLOAD='{"job": "purchase-signin"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [purchase-signin] $1" >> "$LOGFILE"; }

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null)
  if [ $? -ne 0 ]; then
    log "Health check failed: supervisor unreachable on :$HEALTH_PORT"
    return 1
  fi
  local alive
  alive=$(echo "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);console.log(s.childAlive?"yes":"no")}catch{console.log("no")}})' 2>/dev/null)
  if [ "$alive" != "yes" ]; then
    log "Health check failed: childAlive=$alive — health=$health"
    return 1
  fi
  return 0
}

dispatch() {
  curl -s -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" > /dev/null 2>&1
}

if is_healthy; then
  dispatch
  log "Dispatched purchase-signin"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched purchase-signin (retry)"
  exit 0
fi

log "purchase-signin failed: supervisor unhealthy after retry"
exit 1
