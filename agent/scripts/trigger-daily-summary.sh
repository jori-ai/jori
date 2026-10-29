#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger daily-summary via webhook → ops agent
# Clock-anchored at 04:00 in the user's local time (registered in
# clock-jobs.json; cron-tz-sync rewrites the crontab fields nightly, so there
# is no fixed home-zone time), so the whole photos/summary pipeline anchors to
# the small hours local wherever the user is and iCloud photos have propagated.
# Runs after photos-daily (03:00 local) and the thumb pre-warm (03:15 local),
# with iCloud settled overnight. Compiles the day-that-just-ended into a
# narrative email (locations, photos inline, work, conversations, events).
# Persists a structured row in daily_summaries for weekly/monthly compaction.
# Retries once after 60s if supervisor is unhealthy.
#
# THE DISPATCH IS A SHORT LAUNCH COMMAND, NOT THE PLAYBOOK. It used to send
# {"job":"daily-summary"}, which makes the supervisor inline all of
# jobs/daily-summary.md (~140 KB, ~50k tokens) so the ops agent could run ONE
# job-run command; the fork daily-summary-run starts reads that file on its
# own. The payload rode in the ops session for the rest of its life, pushed its
# floor past the compaction cliff, and parked it for hours unable to compact.
# Same shape as trigger-photos-daily.sh's re-render dispatch. Source stays
# "daily-summary" so the 20-minute turn watchdog and the ledger label hold.

source "$(dirname "$0")/lib/root.sh"   # JORI_INSTALL_TOOLS
export PATH="/opt/homebrew/bin:$PATH"

HEALTH_PORT=9093
WEBHOOK_PORT=9092
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/watchdog.log"
TASK="DAILY SUMMARY (scheduled). Launch the build and end your turn with a one-line ack (daily-summary job launched, id <id>). The forked session reads agent/ops-agent/jobs/daily-summary.md itself and does the whole build, email and push, so do not read that file, do not build anything inline, do not compose or send any message, and do not check another job's status first. Run exactly this one command, nothing else, nothing appended: $JORI_INSTALL_TOOLS/bin/job-run --name daily-summary -- $JORI_INSTALL_TOOLS/bin/daily-summary-run"
PAYLOAD="{\"task\": \"$TASK\", \"source\": \"daily-summary\"}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [daily-summary] $1" >> "$LOGFILE"; }

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
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" > /dev/null 2>&1
}

if is_healthy; then
  dispatch
  log "Dispatched daily-summary"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched daily-summary (retry)"
  exit 0
fi

log "Daily-summary failed: supervisor unhealthy after retry"
