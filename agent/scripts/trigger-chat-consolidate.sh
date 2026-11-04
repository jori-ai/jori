#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger the nightly chat-consolidate job via webhook → ops-light agent.
#
# Folds durable facts the user states in ORDINARY CHAT (jori_messages, role=user)
# into the general wiki — the write-side counterpart to unified recall, so a fact
# they typed in conversation graduates from short-term into permanent memory.
# Complements hum-consolidate (hum replies) and daily-summary (venues visited).
# Runs in the sleep window — it's memory maintenance, not a ping. See
# jobs/chat-consolidate.md.
#
# The trigger (un-sandboxed cron) does the Supabase FETCH and writes the pending
# batch to a LOCAL file, so the agent turn stays fully local (read file → local
# wiki writes) and never needs network/keychain inside its sandboxed Bash — the
# same reason the hum harvest fetch can't run inside the agent's sandbox.
#
# Gate: skip the dispatch entirely when there are no un-consolidated user
# messages since the watermark (and nothing left over from a failed save).
#
# The WATERMARK is owned by this script, not the agent (2026-10-04). Once the
# supervisor accepts the dispatch (its queue is persisted, so acceptance is
# durable), the watermark advances to the newest fetched message. A message the
# agent could not save is written by the agent to chat-consolidate-retry.json,
# and the next run folds those rows back into its batch — so a failure is
# retried explicitly instead of depending on the model holding the watermark
# back correctly.

export PATH="/opt/homebrew/bin:$PATH"

resolve_tier_ports chat-consolidate   # job-routing.json → ops-light (:9082)
source "$(dirname "$0")/lib/root.sh"
ROOT="$JORI_TOOLS"
DATA="$ROOT/data"
LOGFILE="$ROOT/agent/logs/watchdog.log"
PAYLOAD='{"job": "chat-consolidate"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [chat-consolidate] $1" >> "$LOGFILE"; }

# --- fetch pending user messages since the watermark, merge leftover retries,
#     write the local batch; print "<count> <newest-fetched-created_at|->" ---
FETCH=$(cd "$ROOT" && CC_DATA="$DATA" node -e '
const {fetchJson}=require("./lib/supabase-rest.js");
const fs=require("fs"),os=require("os"),path=require("path");
const D=process.env.CC_DATA;
let last="1970-01-01T00:00:00Z";
try{const s=JSON.parse(fs.readFileSync(path.join(D,"chat-consolidate-state.json"),"utf8"));if(s.last_consolidated_at)last=s.last_consolidated_at;}catch{}
let retry=[];
try{const r=JSON.parse(fs.readFileSync(path.join(D,"chat-consolidate-retry.json"),"utf8"));if(Array.isArray(r))retry=r.filter(x=>x&&x.id&&typeof x.content==="string");}catch{}
const q="/rest/v1/jori_messages?select=id,content,created_at&role=eq.user&created_at=gt."+encodeURIComponent(last)+"&order=created_at.asc&limit=300";
fetchJson(q,{timeoutMs:8000}).then(rows=>{
  rows=Array.isArray(rows)?rows.filter(r=>r&&typeof r.content==="string"&&r.content.trim()):[];
  const newest=rows.length?rows[rows.length-1].created_at:"-";
  const seen=new Set(rows.map(r=>r.id));
  const batch=[...retry.filter(r=>!seen.has(r.id)),...rows].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  try{fs.writeFileSync(path.join(D,"chat-consolidate-pending.json"),JSON.stringify(batch,null,2));}catch{}
  process.stdout.write(batch.length+" "+newest);
}).catch(()=>process.stdout.write("0 -"));
' 2>/dev/null || echo "0 -")

PENDING="${FETCH%% *}"
NEWEST="${FETCH##* }"

if [ "${PENDING:-0}" -eq 0 ]; then
  log "skip: no un-consolidated chat messages"
  exit 0
fi

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  echo "$health" | grep -q '"childAlive":true'
}

# Succeeds only when the supervisor accepted the dispatch (2xx).
dispatch() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" 2>/dev/null)
  [ "${code:0:1}" = "2" ]
}

# The batch is handed off: advance the watermark past every fetched message and
# clear the retry list (its rows are in this batch; the agent re-adds any that
# fail again).
advance_watermark() {
  if [ "$NEWEST" != "-" ]; then
    node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({last_consolidated_at: process.argv[2]}, null, 2)+"\n");
' "$DATA/chat-consolidate-state.json" "$NEWEST"
  fi
  rm -f "$DATA/chat-consolidate-retry.json"
}

if is_healthy && dispatch; then
  advance_watermark
  log "Dispatched chat-consolidate ($PENDING pending; watermark → $NEWEST)"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy && dispatch; then
  advance_watermark
  log "Dispatched chat-consolidate (retry, $PENDING pending; watermark → $NEWEST)"
  exit 0
fi

log "Consolidate failed: supervisor unhealthy after retry (watermark not advanced)"
exit 1
