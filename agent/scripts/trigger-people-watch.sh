#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger people-watch via webhook → ops-light.
#
#   trigger-people-watch.sh nightly   after 01:30 (web searches): apply the
#                                     user's taps, enqueue due questions, and
#                                     dispatch for own-words answers + research
#   trigger-people-watch.sh day       hourly 09–21: apply taps, dispatch only
#                                     for own-words answers + drafts
#
# The code half runs here with no agent turn: `people-watch apply` (a tapped
# option takes effect) and `propose` (the questions the hum `decisions` lane
# asks). The batch for the turn goes to data/people-watch-pending.json.
# See jobs/people-watch.md.

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"   # JORI_INSTALL_TOOLS

MODE="${1:-nightly}"
resolve_tier_ports people-watch   # job-routing.json → ops-light
ROOT="$JORI_INSTALL_TOOLS"
BIN="$ROOT/bin/people-watch"
DATA="$ROOT/data"
LOGFILE="$ROOT/agent/logs/watchdog.log"
JOBLOG="$ROOT/agent/logs/people-watch.log"
PAYLOAD='{"job": "people-watch"}'
RESEARCH_LIMIT=8

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [people-watch:$MODE] $1" | tee -a "$JOBLOG" >> "$LOGFILE"; }

APPLY=$("$BIN" apply 2>>"$JOBLOG") || { log "apply failed"; exit 1; }
WORDS=$("$BIN" words 2>>"$JOBLOG") || WORDS='[]'
if [ "$MODE" = "nightly" ]; then
  PROPOSED=$("$BIN" propose 2>>"$JOBLOG") || log "propose failed"
  [ -n "$PROPOSED" ] && log "proposed: $(echo "$PROPOSED" | tr -d '\n ')"
  RESEARCH=$("$BIN" due-research --limit "$RESEARCH_LIMIT" 2>>"$JOBLOG") || RESEARCH='[]'
  DRAFTS='[]'
else
  RESEARCH='[]'
  DRAFTS=$("$BIN" drafts 2>>"$JOBLOG") || DRAFTS='[]'
fi

COUNTS=$(MODE="$MODE" WORDS="$WORDS" DRAFTS="$DRAFTS" RESEARCH="$RESEARCH" node -e '
const p = (k) => { try { return JSON.parse(process.env[k] || "[]"); } catch { return []; } };
const batch = { mode: process.env.MODE, written_at: new Date().toISOString(), words: p("WORDS"), drafts: p("DRAFTS"), research: p("RESEARCH") };
require("fs").writeFileSync(process.argv[1], JSON.stringify(batch, null, 2) + "\n");
console.log(`${batch.words.length} ${batch.drafts.length} ${batch.research.length}`);
' "$DATA/people-watch-pending.json") || { log "could not write the batch"; exit 1; }
read -r NW ND NR <<< "$COUNTS"

if [ "${NW:-0}" -eq 0 ] && [ "${ND:-0}" -eq 0 ] && [ "${NR:-0}" -eq 0 ]; then
  [ "$MODE" = "nightly" ] && log "skip: nothing for a turn (apply: $(echo "$APPLY" | tr -d '\n ' | cut -c1-120))"
  exit 0
fi

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
  log "Dispatched ($NW answers, $ND drafts, $NR to research)"
  exit 0
fi

sleep 60
if is_healthy && dispatch; then
  log "Dispatched (retry; $NW answers, $ND drafts, $NR to research)"
  exit 0
fi

log "failed: supervisor unhealthy after retry"
exit 1
