#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger location-enrich. Runs every 15 min. Scans recent visits (findme
# enrich) and, only when a stop needs a NEW composed ask, kicks the launchd
# agent ai.claude.location-enrich-compose (2026-10-04): code + one batched
# model call compose and queue the asks (location-ask-queue.json; hum decides
# whether they ship), and the ops agent is dispatched only for the residue —
# see agent/scripts/run-location-enrich-compose.sh. Never auto-resolves.
# If the kick fails (agent not installed) it falls back to dispatching the
# agent directly, as before. Kill switch for the compose path:
# touch data/.location-enrich-compose-off.
#
# Sleep-window gate (01:00-08:00 local): silently exit without dispatching. The
# playbook already skips asks during this window, so dispatching just burns
# an agent turn to do nothing. Mirrors trigger-hum.sh's gate. Saves ~14
# no-op dispatches/night.

export PATH="/opt/homebrew/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"       # JORI_INSTALL_TOOLS, JORI_NODE
source "$(dirname "$0")/lib/instance.sh"   # JORI_TZ (the home zone)

resolve_tier_ports location-enrich   # tier-routes WEBHOOK_PORT + HEALTH_PORT (was :9092 Opus)
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/watchdog.log"
PAYLOAD='{"job": "location-enrich"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [location-enrich] $1" >> "$LOGFILE"; }

# Sleep-window gate: skip 01:00-08:00 in the user's local TZ (phone, else home).
USER_TZ_FILE="$JORI_INSTALL_TOOLS/data/user-timezone.json"
USER_TZ="${JORI_TZ:-UTC}"
if [ -f "$USER_TZ_FILE" ]; then
  PARSED_TZ=$(jq -r '.timezone // empty' "$USER_TZ_FILE" 2>/dev/null)
  if [ -n "$PARSED_TZ" ] && TZ="$PARSED_TZ" date +%H >/dev/null 2>&1; then
    USER_TZ="$PARSED_TZ"
  fi
fi
HOUR_LOCAL=$(TZ="$USER_TZ" date +%H)
if [ "$HOUR_LOCAL" -ge 1 ] && [ "$HOUR_LOCAL" -lt 8 ]; then
  exit 0
fi

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null)
  if [ $? -ne 0 ]; then return 1; fi
  local alive
  alive=$(echo "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);console.log(s.childAlive?"yes":"no")}catch{console.log("no")}})' 2>/dev/null)
  [ "$alive" = "yes" ]
}

dispatch() {
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" > /dev/null 2>&1
}

# ── Dispatch gate (2026-06-07): only ping the agent when there's actually a stop it would
# ASK about. The thoughtful hypothesis-composition (the valuable part meant to read human, not
# mechanical) STAYS on the agent — this only skips the dispatches where the agent would spin
# up, scan, and find nothing it can act on. The count mirrors the agent's Step-2 askable
# condition EXACTLY (jobs/location-enrich.md): an entry is askable iff
#   asked == false  AND  ready_at <= now  AND  the visit ended within the last 12h
#   AND it is not already sitting in location-ask-queue.json with unchanged signals
#   (2026-10-04: `asked` only flips on SEND, so a queued ask that kept losing its hum
#   tick re-woke a no-op agent turn every 15 min — 165 dispatches / ~$61 in 3 days).
# The 12h freshness bound (added 2026-06-07) is the key tightening: an unasked stop that ages
# past 12h becomes a "zombie" — the agent will NEVER ask it (nobody recalls a >12h-old
# stop), but it stays ready+unasked in the pending file (findme only prunes resolved/sub-floor/
# orphan entries, not aged-out unasked ones). Without this bound the gate dispatched every 15
# min forever for such zombies and the agent declined each time. Now the gate is silent unless
# a genuinely askable stop exists. FAIL-OPEN: if the scan or the check errors, fall through and
# dispatch (current behavior). Kill switch: touch data/.location-enrich-gate-off.
ENRICH_GATE_OFF="$JORI_INSTALL_TOOLS/data/.location-enrich-gate-off"
if [ ! -f "$ENRICH_GATE_OFF" ]; then
  if "$JORI_INSTALL_TOOLS/bin/findme" enrich --lookback 2 --json >/dev/null 2>&1; then
    # Askable AND not already composed-and-waiting in location-ask-queue.json
    # with unchanged signals (2026-10-04) — see lib/location-enrich-gate.mjs.
    READY=$("$JORI_INSTALL_TOOLS/bin/location-enrich-gate" 2>/dev/null)
    if [ "$READY" = "0" ]; then
      # An empty queue has two very different causes and they used to log the
      # same line. Genuinely nothing to ask is the normal case. But a blocked
      # Places budget makes `findme enrich` drop EVERY unnamed stop before it
      # can be queued, so the queue can never fill and this gate goes silent
      # for the rest of the month. That is what happened 2026-08-15 to 08-18:
      # the $20 cap tripped and location-enrich, the largest job on the ledger,
      # ran zero times for three days while this line said "no askable stop"
      # 288 times. Name the cause here so the log says which one it is.
      BLOCK_REASON=$(python3 -c '
import sys
sys.path.insert(0, "'"$JORI_INSTALL_TOOLS"'/lib")
try:
    from places_guard import places_block_reason
    r = places_block_reason()
    sys.stdout.write((r or "").splitlines()[0] if r else "")
except Exception:
    sys.stdout.write("")
' 2>/dev/null)
      if [ -n "$BLOCK_REASON" ]; then
        log "no askable stop — but Places is BLOCKED, so no stop can enter the queue: $BLOCK_REASON"
      else
        log "no askable stop (ready+unasked+<12h, not already queued) — skip dispatch (gate)"
      fi
      exit 0
    fi
  fi
fi

COMPOSE_OFF="$JORI_INSTALL_TOOLS/data/.location-enrich-compose-off"
if [ ! -f "$COMPOSE_OFF" ]; then
  source "$(dirname "$0")/lib/launchd-kick.sh"
  if launchd_kick ai.claude.location-enrich-compose location-enrich; then
    exit 0
  fi
  log "compose kick failed — falling back to a direct agent dispatch"
fi

if is_healthy; then
  dispatch
  log "Dispatched location-enrich"
  exit 0
fi

sleep 60
if is_healthy; then
  dispatch
  log "Dispatched location-enrich (retry)"
  exit 0
fi

log "location-enrich failed: supervisor unhealthy after retry"
