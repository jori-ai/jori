#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/root.sh"   # JORI_INSTALL_TOOLS, JORI_NODE
# Trigger birthday-brainstorm job via webhook channel → ops agent.
# Date-gated: dispatches only on a configured stage day before someone's
# birthday (by default T-2 months, T-1 month, T-7 days and the day itself).
# Silent on all other days, and always silent with no people configured.
#
# People and stages: agent/local/birthday-brainstorm/people.json
#   { "stages": [{"months": 2}, {"months": 1}, {"days": 7}, {"days": 0}],
#     "people": [{"name": "<first name>", "month_day": "MM-DD"}, ...] }
# A month stage keeps the day of month (clamped to the month's last day), so
# 03-29 has stages 01-29, 02-28, 03-22 and 03-29. The playbook
# (jobs/birthday-brainstorm.md) works out who is due itself; the payload only
# names the job.

export PATH="/opt/homebrew/bin:$PATH"

resolve_tier_ports birthday-brainstorm
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/watchdog.log"
PEOPLE="${BIRTHDAY_BRAINSTORM_PEOPLE:-$JORI_INSTALL_TOOLS/agent/local/birthday-brainstorm/people.json}"
PAYLOAD='{"job": "birthday-brainstorm"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [birthday-brainstorm] $1" >> "$LOGFILE"; }

TODAY=$(date +%m-%d)
# Pure calendar arithmetic: prints the names due today, one per line.
DUE=$("${JORI_NODE:-node}" -e '
const fs = require("fs");
let cfg;
try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
const stages = Array.isArray(cfg.stages) && cfg.stages.length ? cfg.stages : [{ months: 2 }, { months: 1 }, { days: 7 }, { days: 0 }];
const [tm, td] = process.argv[2].split("-").map(Number);
const year = new Date().getFullYear();
for (const p of cfg.people || []) {
  const [m, d] = String(p.month_day || "").split("-").map(Number);
  if (!m || !d) continue;
  for (const st of stages) {
    let mm = m, dd = d;
    if (st.months) {
      mm = ((m - 1 - st.months) % 12 + 12) % 12 + 1;
      const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
      dd = Math.min(d, last);
    } else if (st.days) {
      const t = new Date(Date.UTC(year, m - 1, d) - st.days * 86400000);
      mm = t.getUTCMonth() + 1; dd = t.getUTCDate();
    }
    if (mm === tm && dd === td) { console.log(p.name); break; }
  }
}' "$PEOPLE" "$TODAY" 2>/dev/null)

[ -z "$DUE" ] && exit 0

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
  log "Dispatched birthday-brainstorm for $TODAY ($(echo "$DUE" | tr "\n" " "))"
  exit 0
fi

log "First attempt failed, retrying in 60s ($TODAY)"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched birthday-brainstorm for $TODAY (retry)"
  exit 0
fi

log "Birthday-brainstorm failed: supervisor unhealthy after retry ($TODAY)"
