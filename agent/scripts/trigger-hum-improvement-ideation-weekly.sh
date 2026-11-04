#!/bin/bash
# trigger-hum-improvement-ideation-weekly.sh — Sunday weekly hum-improvement ideation.
# Decay-triggered ideation is dispatched from trigger-hum-metrics-collect.sh;
# this script is the standalone Sunday-09:25 path.
#
# Canonical design: data/hum-improvement-loop.md
# Playbook: agent/ops-agent/jobs/hum-improvement-ideation.md

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "$0")/lib/root.sh"
JORI="$JORI_INSTALL"
LOG="$JORI/data/logs/hum-improvement-ideation.log"
mkdir -p "$(dirname "$LOG")"

STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$STAMP] dispatching HUM IMPROVEMENT IDEATION: weekly" >> "$LOG"

# Tier-routed (job-routing.json "hum-improvement-ideation") with the
# degrade-upward chain — it used to hardcode :9092.
set +u  # webhook-auth expands a possibly-empty array (bash 3.2 + -u)
source "$JORI/agent/scripts/lib/webhook-auth.sh"
dispatch_or_skip '{"task":"HUM IMPROVEMENT IDEATION: weekly","source":"cron-hum-improvement-ideation-weekly"}' hum-improvement-ideation
EXIT=$?
echo "[$STAMP] dispatch exit=$EXIT" >> "$LOG"
exit "$EXIT"
