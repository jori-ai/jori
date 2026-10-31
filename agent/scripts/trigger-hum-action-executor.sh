#!/usr/bin/env bash
# hum-action-executor — daily 10:15 local (the instance time zone). See jobs/hum-action-executor.md.
#
# Step 1's row selection is done HERE, in code (2026-10-04): the candidate
# filter is a few field comparisons and a sort (lib/hum-ideas.mjs routeFor), and an empty backlog used to
# cost a full agent turn (~$3) just to discover there was nothing to do. The
# selected ids are written to hum-action-executor-workset.json, which the
# playbook's Step 1 reads; zero candidates → no dispatch at all.
#
# Routing goes through dispatch_or_skip (job-routing.json tier + degrade-upward
# chain) instead of the hardcoded :9092 it used to POST to.
set -euo pipefail
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "$0")/lib/root.sh"
source "$(dirname "$0")/lib/instance.sh"
G="$JORI_INSTALL"
DATA="$G/data"
LOGFILE="$G/agent/logs/watchdog.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum-action-executor] $1" >> "$LOGFILE"; }

# Sleep window (instance time zone, else the host's). 10# forces base-10 so
# 08/09 aren't parsed as octal.
if [[ -n "${JORI_TZ:-}" ]]; then HOUR=$(TZ="$JORI_TZ" date +%H); else HOUR=$(date +%H); fi
if (( 10#$HOUR >= 1 && 10#$HOUR < 8 )); then exit 0; fi

# Kill switch
[[ -f "$DATA/hum-action-executor-pause.json" ]] && exit 0

# Lock check — skip if a prior run is still in flight
LOCK="$DATA/hum-action-executor.lock"
if [[ -f "$LOCK" ]]; then
  PID=$(cat "$LOCK" 2>/dev/null || echo "")
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then exit 0; fi
fi

# Step 0 — reconcile the ledger with the Improvements cards first (2026-10-07), so
# an idea whose card expired unsigned re-enters the work set today, and one whose
# card was signed stops looking like open work. Best effort: a failure must not
# block the run.
"$G/bin/hum-ideas-reconcile" >/dev/null 2>&1 || log "hum-ideas-reconcile failed — continuing"

# Step 1 — select the work set in code.
COUNT=$("$G/bin/hum-action-workset" --write "$DATA/hum-action-executor-workset.json") || {
  log "workset selection failed — not dispatching"; exit 0; }
if [[ "$COUNT" == "0" ]]; then
  log "no eligible ideas — skip dispatch"
  exit 0
fi

# webhook-auth expands "${CURL_AUTH[@]}", which bash 3.2 treats as unbound
# when the array is empty — relax -u for the shared helpers.
set +u
source "$(dirname "$0")/lib/webhook-auth.sh"
if dispatch_or_skip '{"job": "hum-action-executor", "source": "cron-hum-action-executor"}' hum-action-executor; then
  log "Dispatched hum-action-executor ($COUNT candidate(s))"
fi
