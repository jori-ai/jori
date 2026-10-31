#!/bin/bash
# watchlist-discover-run — the monthly wide (60-day) pass of the same pipeline
# the daily `screen` hum lane runs, plus a phone pointer if anything was added.
# watch-discover owns candidate search + every add-time rule (see its header);
# new seasons are found separately by watchlist-season-check.
#
# Launched by the ops agent via `job-run` (jobs/watchlist-discover.md), never
# straight from cron: watch-discover forks `claude -p`, which can only
# authenticate from inside the Max-authenticated session.

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS
TOOLS="$JORI_INSTALL_TOOLS"
LOGFILE="$TOOLS/agent/logs/watchlist-discover.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [watchlist-discover] $1" >> "$LOGFILE"; }

OUT=$("$TOOLS/bin/watch-discover" --window-days 60 --max 12 --source monthly-discover --effort medium 2>>"$LOGFILE")
STATUS=$?
log "exit=$STATUS $(echo "$OUT" | tr -d '\n' | cut -c1-600)"
[ $STATUS -ne 0 ] && exit $STATUS

SUMMARY=$(echo "$OUT" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  try{const r=JSON.parse(d);const a=r.added||[];if(!a.length)return;
  console.log(`Monthly watch scan added ${a.length}: ${a.map(x=>x.name).join(", ")}. They will be in the weekly review for a yes/no.`)}catch{}})')

if [ -n "$SUMMARY" ]; then
  "$TOOLS/bin/jori-send-curl" --suppress-hook --intent watchlist-discover "$SUMMARY"
fi
exit 0
