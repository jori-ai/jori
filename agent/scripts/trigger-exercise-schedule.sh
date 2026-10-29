#!/bin/bash
# Trigger exercise-schedule — runs the standalone script DIRECTLY, no agent dispatch.
#
# Why not the webhook: dispatching {"job":"exercise-schedule"} sent the work into
# an ops-agent turn, which executes bin/exercise-schedule through a SANDBOXED Bash
# child. In that sandbox two independent runtimes lose the network: the workout
# tracker read failed ("fetch failed" — Node's resolver), and gog died inside
# macOS trust evaluation (x509 OSStatus -26276, a Security-framework internal
# error, not a bad certificate). Net effect: NO calendar exercise block was
# created on any scheduled day for weeks. The identical script run outside a
# sandboxed turn works. cron-run, which already wraps this trigger, is not
# sandboxed — so running the script here is the fix. The script is standalone by
# design (rest-day logic, session count, slot finding, event creation, phone
# notification all live inside it); the agent turn contributed no reasoning,
# only the broken context.
#
# Off when agent/local/config/exercise.json does not enable the habit (the
# script itself exits 0 saying so).
#
# Args are passed through, so `trigger-exercise-schedule.sh --dry-run` is testable.

set -uo pipefail
source "$(dirname "$0")/lib/root.sh"
# cron's bare PATH has no node: put node's directory first (bin/exercise-schedule
# finds gog on its own).
[ -n "$JORI_NODE" ] && export PATH="$(dirname "$JORI_NODE"):$PATH"

REPO="$JORI_INSTALL"
mkdir -p "$JORI_INSTALL_TOOLS/data/logs"
LOGFILE="$JORI_INSTALL_TOOLS/data/logs/exercise-schedule.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [exercise-schedule] $1" >> "$LOGFILE"; }

# gog unlocks its file keyring from .env (same pattern as the other gog callers)
if [ -z "${GOG_KEYRING_PASSWORD:-}" ] && [ -f "$REPO/.env" ]; then
  export GOG_KEYRING_PASSWORD="$(grep -E '^GOG_KEYRING_PASSWORD=' "$REPO/.env" | head -1 | cut -d= -f2-)"
fi

# One switch for the whole exercise habit: when the `exercise` hum lane is paused
# in hum-interests.json, the daily gym block stops too — a block with no nudges
# around it is just noise on the calendar. Re-enabling the lane resumes both.
# Only a clean `false` pauses; an unreadable file keeps the old behaviour.
LANE_ENABLED="$(jq -r '.topics[] | select(.name == "exercise") | .enabled' "$JORI_INSTALL_TOOLS/data/hum-interests.json" 2>/dev/null)"
if [ "$LANE_ENABLED" = "false" ]; then
  log "exercise lane paused in hum-interests.json — no calendar block today"
  exit 0
fi

log "Running exercise-schedule directly (no agent dispatch)"
# We capture the script's stderr into $LOGFILE below, so tell it not to append
# there itself — otherwise every line lands twice and any occurrence count read
# off this log is doubled (exercise-log-double-write). The redirect is the
# surviving writer, not the script's own append, because it also catches
# uncaught-exception stack traces that never reach the script's log().
export EXERCISE_SCHEDULE_STDERR_TO_LOG=1
"$JORI_INSTALL_TOOLS/bin/exercise-schedule" "$@" >> "$LOGFILE" 2>&1
rc=$?
[ "$rc" -ne 0 ] && log "exercise-schedule exited $rc — the failure is in the lines just above"
exit 0
