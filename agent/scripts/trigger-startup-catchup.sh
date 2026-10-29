#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/root.sh"
# trigger-startup-catchup.sh — fire a catch-up triage task after ops-agent restart
#
# Invoked by the launcher and watchdog after (re)starting the ops-agent.
# Waits for the webhook-channel HTTP server (localhost:9092) to be reachable,
# then POSTs a catchup task. This is the reliable path — the gmail-channel's
# mcp.notification-based catchup on startup can be lost if the agent isn't
# yet listening when the 5s timer fires.

LOG="$JORI_INSTALL_TOOLS/agent/logs/webhooks.log"
WEBHOOK_URL="http://localhost:9092"
MAX_WAIT=120  # seconds to wait for webhook-channel to come up

# Wait for webhook-channel HTTP server to accept connections
waited=0
while [ "$waited" -lt "$MAX_WAIT" ]; do
  if curl -s -o /dev/null -w '' --max-time 2 "$WEBHOOK_URL" 2>/dev/null; then
    break
  fi
  sleep 3
  waited=$((waited + 3))
done

if [ "$waited" -ge "$MAX_WAIT" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') STARTUP-CATCHUP: webhook-channel not reachable after ${MAX_WAIT}s — skipping" >> "$LOG"
  exit 1
fi

# Give the agent a few extra seconds past its "Listening" banner before sending
# (ensures the MCP notification loop is actually draining messages)
sleep 10

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
  -d '{"task": "STARTUP CATCHUP: The ops-agent just restarted. Check Gmail for any unread inbox messages, then for each one run email-mem test to see if it was already triaged. Do NOT rely on Gmail read/unread/label state as the source of truth — only email-mem records are authoritative. Triage every unread email not found in email-mem following the Email Triage Rules. FIRST read '"$JORI_INSTALL_TOOLS"'/agent/ops-agent/email-triage-rules.md plus the local additions in '"$JORI_INSTALL_TOOLS"'/agent/local/email-triage-rules.md — together they are the authoritative ruleset and they are NOT in your context by default (loaded on demand)."}')

if [ "$HTTP_CODE" = "200" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') STARTUP-CATCHUP trigger sent (waited ${waited}s for webhook)" >> "$LOG"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') STARTUP-CATCHUP trigger failed (HTTP $HTTP_CODE)" >> "$LOG"
fi
