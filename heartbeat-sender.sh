#!/bin/bash
# Heartbeat sender — posts system health to Firebase RTDB every 2 min
# Runs as a LaunchAgent (the services registry entry whose script is this file).
#
# Where it posts: agent/local/config/heartbeat.json {"firebase_url":
# "https://<db>.firebaseio.com"} (JORI_HEARTBEAT_FIREBASE_URL overrides). No URL
# configured = no off-box heartbeat; the script exits 0.
#
# Self-looping daemon (fixed 2026-07-08): this script used to be single-shot,
# re-invoked every 120s by launchd's StartInterval. StartInterval keeps
# repeatedly failing to re-arm in practice (stalled 4+ times in one day,
# sometimes for 40+ min with zero runs and no crash signature) — it's an
# unreliable timer, not a crash. The fix moves the repeat interval INTO the
# script (a `while true` loop with its own `sleep`) and switches the plist to
# KeepAlive, so launchd's job is just "keep this process alive" — if the
# process ever does die, KeepAlive respawns it immediately, and as long as it
# lives the internal loop is the only thing responsible for pacing, no longer
# dependent on launchd re-arming a timer.

source "$(cd "$(dirname "$0")" && pwd)/agent/scripts/lib/root.sh"
FIREBASE_URL="${JORI_HEARTBEAT_FIREBASE_URL:-$("${JORI_NODE:-node}" -e 'process.stdout.write(String(require(process.argv[1]).localConfig("heartbeat",{firebase_url:""}).firebase_url||""))' "$JORI_TOOLS/lib/instance.cjs" 2>/dev/null)}"
GCLOUD="$(command -v gcloud 2>/dev/null || echo /opt/homebrew/bin/gcloud)"
TOKEN_CACHE="$JORI_INSTALL/data/.firebase-token-cache"

# Get access token (cache for 50 min to avoid calling gcloud every 2 min)
get_token() {
  if [ -f "$TOKEN_CACHE" ]; then
    local age=$(( $(date +%s) - $(stat -f%m "$TOKEN_CACHE") ))
    if [ "$age" -lt 3000 ]; then
      cat "$TOKEN_CACHE"
      return
    fi
  fi
  local token=$($GCLOUD auth print-access-token 2>/dev/null)
  if [ -n "$token" ]; then
    echo "$token" > "$TOKEN_CACHE"
    echo "$token"
  fi
}

# ── Failure-time network diagnostics (added 2026-07-07) ──────────────────────
# When connectivity is down, drop a local forensic snapshot so the NEXT outage
# leaves a breadcrumb on disk (the 2026-07-07 wedge left none — the unified log
# was unrecoverable). Runs BEFORE the gcloud token gate below, because an outage
# fails the token fetch and would otherwise exit early. Rate-limited; fail-open
# (must never break the heartbeat). Manual capture: `heartbeat-sender.sh --diag-test`.
NETDIAG_LOG="$JORI_INSTALL/logs/net-diag.log"
NETDIAG_MARK="$JORI_INSTALL/data/.net-diag-last"
NETDIAG_MIN_GAP=300   # min seconds between captures during a sustained outage
TS_BIN="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"

# Run one diagnostic command with a hard timeout, appending to the snapshot.
_diag() {  # _diag <label> <timeout-sec> <shell-command-string>
  echo "--- $1 ---" >> "$NETDIAG_LOG"
  bash -c "$3" >> "$NETDIAG_LOG" 2>&1 &
  local pid=$!
  ( sleep "$2"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watcher=$!
  wait "$pid" 2>/dev/null
  kill -9 "$watcher" 2>/dev/null
}

# Capture a full network snapshot. The layered probes below isolate WHICH layer
# broke: LAN (gateway ping) vs raw internet (8.8.8.8 by IP) vs Tailscale resolver
# reachability vs DNS resolution via Tailscale-MagicDNS vs via a public resolver.
netdiag_capture() {
  touch "$NETDIAG_MARK" 2>/dev/null   # claim the slot first — avoids concurrent double-capture
  mkdir -p "$(dirname "$NETDIAG_LOG")" 2>/dev/null
  if [ -f "$NETDIAG_LOG" ] && [ "$(stat -f%z "$NETDIAG_LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    mv -f "$NETDIAG_LOG" "$NETDIAG_LOG.1" 2>/dev/null   # rotate past ~5 MB
  fi
  local gw
  gw=$(route -n get default 2>/dev/null | awk '/gateway/{print $2}')
  {
    echo "================================================================"
    echo "[net-diag] $(date '+%Y-%m-%d %H:%M:%S %z') — network snapshot (gw=${gw:-?})"
  } >> "$NETDIAG_LOG"
  _diag "interfaces (up)"        3 "ifconfig | grep -E 'flags=|status:|inet '"
  _diag "dns-config"             3 "scutil --dns | grep -E 'nameserver|if_index' | head -20"
  _diag "routes"                 3 "netstat -rn -f inet | head -12"
  _diag "ping gateway (LAN)"     5 "ping -c2 -t3 ${gw:-192.168.1.1}"
  _diag "ping 8.8.8.8 (raw ip)"  5 "ping -c2 -t3 8.8.8.8"
  _diag "ping ts-resolver"       5 "ping -c2 -t3 100.100.100.100"
  _diag "dns via tailscale"      5 "dig +time=2 +tries=1 @100.100.100.100 github.com +short"
  _diag "dns via 8.8.8.8"        5 "dig +time=2 +tries=1 @8.8.8.8 github.com +short"
  _diag "tailscale status"       6 "'$TS_BIN' status"
  _diag "top cpu"                3 "ps -Ao pcpu,pid,comm -r | head -8"
  _diag "vm_stat"                3 "vm_stat | head -6"
  _diag "recent diag reports"    3 "ls -t /Library/Logs/DiagnosticReports 2>/dev/null | head -6"
  echo "[net-diag] capture complete" >> "$NETDIAG_LOG"
}

# Manual/forced test path — capture immediately, skip Firebase entirely.
if [ "${1:-}" = "--diag-test" ]; then
  netdiag_capture
  echo "[net-diag] test capture appended to $NETDIAG_LOG"
  exit 0
fi

# One heartbeat tick — everything from the internet check through the
# Firebase PUT. Called in a loop below so the script paces itself instead of
# relying on launchd's StartInterval to re-invoke it.
heartbeat_tick() {

# Internet check (fast timeout) — reused for the payload below.
INTERNET_OK=false
ping -c 1 -t 3 8.8.8.8 &>/dev/null && INTERNET_OK=true

# On an outage, drop a diagnostic snapshot (rate-limited); clear the marker when
# healthy so the next outage captures immediately. Placed before the token gate.
if [ "$INTERNET_OK" = false ]; then
  _gap_ok=true
  if [ -f "$NETDIAG_MARK" ]; then
    _age=$(( $(date +%s) - $(stat -f%m "$NETDIAG_MARK" 2>/dev/null || echo 0) ))
    [ "$_age" -lt "$NETDIAG_MIN_GAP" ] && _gap_ok=false
  fi
  [ "$_gap_ok" = true ] && netdiag_capture
else
  rm -f "$NETDIAG_MARK" 2>/dev/null
fi

ACCESS_TOKEN=$(get_token)
if [ -z "$ACCESS_TOKEN" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [heartbeat] Failed to get access token" >&2
  exit 1
fi

# Process checks
CLAUDE_CODE_RUNNING=false
pgrep -f "claude" &>/dev/null && CLAUDE_CODE_RUNNING=true

# CHAT_AGENT_RUNNING / OPS_AGENT_RUNNING are derived below from the supervisor
# HTTP health endpoints, not pgrep on a model name — both agents run
# claude-sonnet-5 as of 2026-07-02, so a model-name grep can no longer tell
# them apart (the old "claude.*opus" check for ops silently read false ever
# since that migration, which is what mislabeled this outage as "ops DOWN").
CHAT_AGENT_RUNNING=false
OPS_AGENT_RUNNING=false

# Gmail-push ingress is a Cloudflare Tunnel (→ :9090) under its own launchd agent.
CLOUDFLARED_RUNNING=false
pgrep -f "cloudflared.*tunnel" &>/dev/null && CLOUDFLARED_RUNNING=true

# Agent activity status — from HTTP health endpoints
CHAT_STATUS="unknown"
OPS_STATUS="unknown"
CHAT_LAST_ACTIVITY=""
OPS_LAST_ACTIVITY=""
CHAT_QUEUE_DEPTH=0
OPS_QUEUE_DEPTH=0
PHONE_CHANNEL_HEARTBEAT_AGE=0
PM_UPTIME=0

PM_HEALTH=$(curl -sf --max-time 3 "http://127.0.0.1:9095/health" 2>/dev/null)
if [ -n "$PM_HEALTH" ]; then
  PM_UPTIME=$(echo "$PM_HEALTH" | jq -r '.uptimeMs // 0')
fi

CHAT_HEALTH=$(curl -sf --max-time 3 "http://127.0.0.1:9094/health" 2>/dev/null)
if [ -n "$CHAT_HEALTH" ]; then
  CHAT_AGENT_RUNNING=true
  CHAT_STATUS=$(echo "$CHAT_HEALTH" | jq -r 'if .inFlight then "working" elif .queueDepth > 0 then "queued" else "idle" end')
  CHAT_QUEUE_DEPTH=$(echo "$CHAT_HEALTH" | jq -r '.queueDepth // 0')
  PHONE_CHANNEL_HEARTBEAT_AGE=$(echo "$CHAT_HEALTH" | jq -r '.phoneChannelHeartbeatAgeMs // 0')
  CHAT_LAST_ACTIVITY=$(echo "$CHAT_HEALTH" | jq -r 'if .lastEventTs then (.lastEventTs | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) else 0 end')
fi

OPS_HEALTH=$(curl -sf --max-time 3 "http://127.0.0.1:9093/health" 2>/dev/null)
if [ -n "$OPS_HEALTH" ]; then
  OPS_AGENT_RUNNING=true
  OPS_STATUS=$(echo "$OPS_HEALTH" | jq -r 'if .inFlight then "working" elif .queueDepth > 0 then "queued" else "idle" end')
  OPS_QUEUE_DEPTH=$(echo "$OPS_HEALTH" | jq -r '.queueDepth // 0')
  OPS_LAST_ACTIVITY=$(echo "$OPS_HEALTH" | jq -r 'if .lastEventTs then (.lastEventTs | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) else 0 end')
fi

# Triage stats from triage.log
#
# NOTE (fixed 2026-07-21): these used to end in `|| echo 0`. `grep -c` already
# prints "0" on no match — but it also EXITS 1, so the `||` fired too and the
# substitution captured "0\n0". Every night at 00:00 UTC the log has no lines
# for the new date yet, so both counters became "0 0", the payload below became
# invalid JSON, and Firebase rejected the PUT with HTTP 400 until the day's
# first email landed. The frozen heartbeat then tripped the watchdog into a
# nightly false "Mac Mini UNREACHABLE" alert. Keep these substitutions
# exit-status-clean and digits-only.
TRIAGE_LOG="$JORI_INSTALL/logs/triage.log"
EMAILS_TODAY=0
TRIAGED_TODAY=0
if [ -f "$TRIAGE_LOG" ]; then
  TODAY=$(date -u '+%Y-%m-%d')
  EMAILS_TODAY=$(grep "$TODAY" "$TRIAGE_LOG" 2>/dev/null | grep -c "EMAIL-RECEIVED")
  TRIAGED_TODAY=$(grep "$TODAY" "$TRIAGE_LOG" 2>/dev/null | grep -cE "LABEL|MARK-READ|DRAFT")
  # Belt-and-braces: never let a non-numeric value reach the JSON payload.
  [[ "$EMAILS_TODAY" =~ ^[0-9]+$ ]] || EMAILS_TODAY=0
  [[ "$TRIAGED_TODAY" =~ ^[0-9]+$ ]] || TRIAGED_TODAY=0
fi

TAILSCALE_OK=false
if command -v tailscale &>/dev/null; then
  tailscale status &>/dev/null && TAILSCALE_OK=true
fi

# System metrics
DISK_PCT=$(df -h / | awk 'NR==2{print $5}' | tr -d '%')

CPU_LOAD=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')

PAGE_SIZE=$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)
FREE_PAGES=$(vm_stat 2>/dev/null | awk '/Pages free/{gsub(/\./,""); print $3}')
INACTIVE_PAGES=$(vm_stat 2>/dev/null | awk '/Pages inactive/{gsub(/\./,""); print $3}')
AVAIL_MEM_MB=0
if [ -n "$FREE_PAGES" ] && [ -n "$INACTIVE_PAGES" ]; then
  AVAIL_MEM_MB=$(( (FREE_PAGES + INACTIVE_PAGES) * PAGE_SIZE / 1048576 ))
fi

# kern.boottime prints `{ sec = 1784559910, usec = 556915 } Mon Jul 20 11:05:10 2026`.
# The old `awk -F'[= ,]' '{print $6}'` landed on an empty field (consecutive
# separators produce empties, so the epoch is $5, not $6) — uptime_min had been
# silently reporting 0 forever. Anchor the match at the start of the line: an
# unanchored `.*sec = ` is greedy and captures the *usec* value instead.
UPTIME_SEC=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ *sec *= *\([0-9][0-9]*\).*/\1/p')
NOW_SEC=$(date +%s)
UPTIME_MIN=0
if [ -n "$UPTIME_SEC" ]; then
  UPTIME_MIN=$(( (NOW_SEC - UPTIME_SEC) / 60 ))
fi

# Build JSON payload — PUT overwrites /heartbeat/latest (single document, no growing table)
PAYLOAD=$(cat <<EOF
{
  "internet_ok": $INTERNET_OK,
  "claude_code_running": $CLAUDE_CODE_RUNNING,
  "chat_agent_running": $CHAT_AGENT_RUNNING,
  "ops_agent_running": $OPS_AGENT_RUNNING,
  "cloudflared_running": $CLOUDFLARED_RUNNING,
  "tailscale_ok": $TAILSCALE_OK,
  "disk_pct": ${DISK_PCT:-0},
  "cpu_load": ${CPU_LOAD:-0},
  "avail_mem_mb": ${AVAIL_MEM_MB:-0},
  "uptime_min": ${UPTIME_MIN:-0},
  "chat_status": "$CHAT_STATUS",
  "ops_status": "$OPS_STATUS",
  "chat_last_activity": ${CHAT_LAST_ACTIVITY:-0},
  "ops_last_activity": ${OPS_LAST_ACTIVITY:-0},
  "chat_queue_depth": ${CHAT_QUEUE_DEPTH:-0},
  "ops_queue_depth": ${OPS_QUEUE_DEPTH:-0},
  "phone_channel_heartbeat_age_ms": ${PHONE_CHANNEL_HEARTBEAT_AGE:-0},
  "process_manager_uptime_ms": ${PM_UPTIME:-0},
  "emails_today": $EMAILS_TODAY,
  "triaged_today": $TRIAGED_TODAY,
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
)

# Validate before sending. A malformed payload is rejected by Firebase (HTTP
# 400), which freezes /heartbeat/latest and makes a perfectly healthy machine
# look UNREACHABLE to the watchdog — the worst possible failure mode for a
# liveness signal, and exactly what the "0 0" bug above caused nightly. So a
# payload that won't parse degrades to a minimal-but-valid one: liveness still
# gets through, the metrics for this tick are simply missing, and the bad
# payload is logged so the cause is findable.
if ! printf '%s' "$PAYLOAD" | jq -e . >/dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [heartbeat] payload was not valid JSON, sending minimal fallback. Bad payload: $(printf '%s' "$PAYLOAD" | tr '\n' ' ')" >&2
  PAYLOAD=$(cat <<EOF
{
  "internet_ok": $INTERNET_OK,
  "payload_degraded": true,
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
)
fi

# PUT to Firebase RTDB (overwrites /heartbeat/latest)
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X PUT "${FIREBASE_URL}/heartbeat/latest.json?access_token=${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)

if [ "$HTTP_CODE" = "401" ]; then
  # Token expired — clear cache and retry once
  rm -f "$TOKEN_CACHE"
  ACCESS_TOKEN=$(get_token)
  if [ -n "$ACCESS_TOKEN" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -X PUT "${FIREBASE_URL}/heartbeat/latest.json?access_token=${ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" 2>/dev/null)
  fi
fi

if [ "$HTTP_CODE" = "200" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [heartbeat] OK"
  CONSEC_PUT_FAILS=0
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') [heartbeat] PUT failed (HTTP $HTTP_CODE)" >&2
  CONSEC_PUT_FAILS=$((CONSEC_PUT_FAILS + 1))
  # Self-report added 2026-07-22: for 11 nights (Jul 10-21) this script's own
  # PUT failures went only to stderr, so /heartbeat/latest froze and the
  # watchdog read a perfectly healthy machine as offline (8 false "Mac Mini
  # UNREACHABLE" P1 alerts). The payload bug itself is already fixed;
  # this is the second-order fix — a liveness sender
  # whose own delivery is broken is indistinguishable from a dead machine
  # unless it says so itself. After 3 consecutive failed PUTs (~6 min), tell
  # the system channel directly, rate-limited to once/hour so a sustained
  # outage doesn't spam it. Fail-open and purely additive: any error here
  # must never interrupt the loop below.
  if [ "$CONSEC_PUT_FAILS" -ge 3 ]; then
    NOW_TS=$(date +%s)
    if [ $(( NOW_TS - LAST_SELFREPORT_TS )) -ge 3600 ]; then
      LAST_SELFREPORT_TS=$NOW_TS
      "$JORI_INSTALL_TOOLS/bin/jori-send-curl" --channel system --skip-precheck \
        "⚠️ heartbeat-sender: $CONSEC_PUT_FAILS consecutive Firebase PUT failures (HTTP $HTTP_CODE) — the mini is UP, this is the heartbeat's own delivery breaking, not a dead machine. Any UNREACHABLE alert right now is a false alarm." \
        >/dev/null 2>&1 &
    fi
  fi
fi

}

if [ -z "$FIREBASE_URL" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [heartbeat] no Firebase URL configured (agent/local/config/heartbeat.json firebase_url) — not sending"
  exit 0
fi

# Main loop — one tick every 120s, for as long as launchd (KeepAlive) keeps
# this process running. A failure inside a single tick must never kill the
# loop; heartbeat_tick already fails open internally (bad token, bad PUT, etc.
# just log and fall through), so no extra guarding is needed here.
#
# CONSEC_PUT_FAILS / LAST_SELFREPORT_TS persist across heartbeat_tick calls
# (plain assignment inside a bash function mutates the caller's/global scope
# unless declared `local`) since this loop calls the function repeatedly in
# the same process rather than re-invoking the script.
CONSEC_PUT_FAILS=0
LAST_SELFREPORT_TS=0
while true; do
  heartbeat_tick
  sleep 120
done
