#!/bin/bash
# trip-reservoir-autoscan — nightly: research a travel guide for every upcoming
# NON-HOME location that doesn't have one yet.
#
# LAUNCHED BY launchd, NOT cron (since 2026-10-04):
# agent/launch-agents/ai.claude.trip-reservoir-autoscan.plist, 02:00 local.
# trip-reservoir-build forks a Sonnet `claude -p`, which needs the keychain-held
# Max credentials; a launchd user agent lives in the GUI session and can reach
# them, cron cannot ("Not logged in", exit 0). Until 2026-10-04 this script
# worked around that by dispatching an ops-agent turn whose only work was
# `--list` + a loop of `job-run`s — a full agent floor read for a for-loop.
# Now the loop runs here, sequentially (5 concurrent Sonnet forks exhausted the
# Max pool on 2026-07-09). Each build posts its own `⚠️ trip-reservoir-build:`
# system alert on failure; this script adds nothing on top.
source "$(dirname "$0")/lib/root.sh"
# launchd's PATH has no node; put the resolved one first.
[ -n "$JORI_NODE" ] && export PATH="$(dirname "$JORI_NODE"):$PATH"

BIN="$JORI_INSTALL_TOOLS/bin"
LOG="$JORI_INSTALL_TOOLS/agent/logs/trip-reservoir-autoscan.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# Pause file — exit silently if present.
[ -f "$JORI_INSTALL_TOOLS/data/trip-reservoir-autoscan-pause.json" ] && exit 0

if ! command -v node > /dev/null 2>&1; then
  log "FAILED: node not found on PATH"
  exit 1
fi

# --check exits 0 iff at least one upcoming non-home location lacks a guide.
if ! "$BIN/trip-reservoir-autoscan" --check; then
  log "nothing to research (all upcoming non-home stays have guides)"
  exit 0
fi

LIST=$("$BIN/trip-reservoir-autoscan" --list 2>/dev/null)
log "researching: $LIST"
# One line per entry: key<TAB>label<TAB>from<TAB>to
echo "$LIST" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{for(const e of JSON.parse(d||"[]"))console.log([e.key,e.label,e.from||"",e.to||""].join("\t"))})' 2>/dev/null |
while IFS=$'\t' read -r KEY LABEL FROM TO; do
  [ -z "$KEY" ] && continue
  ARGS=(--area "$KEY" --label "$LABEL")
  [ -n "$FROM" ] && ARGS+=(--from "$FROM")
  [ -n "$TO" ] && ARGS+=(--to "$TO")
  "$BIN/trip-reservoir-build" "${ARGS[@]}" >> "$LOG" 2>&1
  log "build $KEY ($LABEL) exited $?"
done
