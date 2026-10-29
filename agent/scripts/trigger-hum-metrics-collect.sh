#!/bin/bash
# trigger-hum-metrics-collect.sh — daily hum metrics collection + decay detection.
# Runs hum-metrics-collect, then conditionally dispatches improvement-ideation
# if a decay event landed today AND a qualitative answer has been recorded.
#
# Canonical design: data/hum-improvement-loop.md
# Playbook: agent/ops-agent/jobs/hum-metrics-collect.md
#
# Scheduled: early morning daily (system/tasks.json), after the prior local day fully closes

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "$0")/lib/root.sh"       # JORI_INSTALL_TOOLS
source "$(dirname "$0")/lib/instance.sh"   # JORI_TZ (the home zone)
JORI="$JORI_INSTALL_TOOLS"
LOG="$JORI/data/logs/hum-metrics.log"
mkdir -p "$(dirname "$LOG")"

STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$STAMP] hum-metrics-collect starting" >> "$LOG"

# 1. Run the collector. --measure also runs intervention attribution
#    for any interventions whose measure_at has passed.
"$JORI/bin/hum-metrics-collect" --measure >> "$LOG" 2>&1
EXIT=$?

if [ "$EXIT" -ne 0 ]; then
  echo "[$STAMP] hum-metrics-collect FAILED with exit $EXIT" >> "$LOG"
  # Single phone ping (infra alert; skip precheck since we're reporting on
  # something the precheck depends on).
  "$JORI/bin/jori-send-curl" \
    --intent hum-metrics-collect-error \
    --agent infra \
    --channel system \
    --skip-precheck \
    --no-push \
    "hum-metrics-collect failed (exit $EXIT) — see data/logs/hum-metrics.log" \
    >> "$LOG" 2>&1
  exit "$EXIT"
fi

# 2. Conditionally dispatch improvement-ideation if a decay event landed today
#    AND the user already answered the qualitative question.
TODAY="$(TZ="${JORI_TZ:-UTC}" date +%Y-%m-%d)"
STATE="$JORI/data/hum-metrics-state.json"
LEARNINGS="$JORI/data/hum-learnings.jsonl"

if [ ! -f "$STATE" ]; then
  echo "[$STAMP] no state file yet — skipping ideation dispatch" >> "$LOG"
  exit 0
fi

# Find most-recent decay event from today.
LAST_DECAY="$(jq -c --arg today "$TODAY" \
  '[.decay_events // [] | .[] | select(.ts | startswith($today))] | last' \
  "$STATE" 2>/dev/null)"

if [ "$LAST_DECAY" = "null" ] || [ -z "$LAST_DECAY" ]; then
  echo "[$STAMP] no decay events today; collect-only complete" >> "$LOG"
  exit 0
fi

LANE="$(echo "$LAST_DECAY" | jq -r '.lane // "global"')"
DECAY_TYPE="$(echo "$LAST_DECAY" | jq -r '.type')"

# Has the user answered the qualitative question for this lane?
if [ ! -f "$LEARNINGS" ]; then
  echo "[$STAMP] decay $DECAY_TYPE [$LANE] but no learnings file yet — awaiting answer" >> "$LOG"
  exit 0
fi
ANSWER="$(jq -s --arg subject "hum $LANE decay" \
  '[.[] | select(.subject == $subject)] | last' "$LEARNINGS" 2>/dev/null)"

if [ "$ANSWER" = "null" ] || [ -z "$ANSWER" ]; then
  echo "[$STAMP] decay $DECAY_TYPE [$LANE] — qualitative question still pending answer" >> "$LOG"
  exit 0
fi

# 2.5. Skip the dispatch if this lane's most recent answered diagnosis
#    already has an open (status: proposed) idea on file citing it — a
#    prior decay-triggered ideation run already root-caused this exact
#    answer and proposed a fix that hasn't landed (or been declined) yet.
#    Re-dispatching a full xhigh-effort ops-agent turn to re-derive an
#    identical conclusion is pure cost with zero new signal (hum-i-
#    20260711-02: the `ideas` lane dispatched 4 byte-for-byte redundant
#    ideation turns on 7/7, 7/9, 7/10, 7/11 for the same qual-ideas-20260707
#    answer). `--dedup-check` bumps a recurrence counter on the blocking
#    idea instead of dispatching, so the redundancy stays visible/auditable
#    without costing a turn. Fails OPEN on any error in the check itself —
#    a bug here can only cost an extra (wasteful but harmless) dispatch,
#    never silently suppress a genuinely new decay signal.
DEDUP="$("$JORI/bin/hum-metrics-collect" --dedup-check --lane "$LANE" 2>>"$LOG")"
BLOCKED="$(echo "$DEDUP" | jq -r '.blocked // false' 2>/dev/null)"
if [ "$BLOCKED" = "true" ]; then
  BLOCKING_ID="$(echo "$DEDUP" | jq -r '.idea_id // "?"' 2>/dev/null)"
  RECURRENCE="$(echo "$DEDUP" | jq -r '.recurrence_count // "?"' 2>/dev/null)"
  echo "[$STAMP] decay $DECAY_TYPE [$LANE] — redundant vs open idea $BLOCKING_ID (recurrence_count=$RECURRENCE) — skipping ideation dispatch" >> "$LOG"
  exit 0
fi

# Answer present, not a redundant re-derivation → dispatch decay-triggered ideation.
# Tier-routed (job-routing.json "hum-improvement-ideation") with the
# degrade-upward chain — it used to hardcode :9092.
set +u  # webhook-auth expands a possibly-empty array (bash 3.2 + -u)
source "$JORI/agent/scripts/lib/webhook-auth.sh"
if ! dispatch_or_skip "{\"task\":\"HUM IMPROVEMENT IDEATION: decay $LANE\",\"source\":\"cron-hum-metrics\"}" hum-improvement-ideation; then
  echo "[$STAMP] no healthy supervisor for HUM IMPROVEMENT IDEATION: decay $LANE" >> "$LOG"
  exit 0
fi
echo "[$STAMP] dispatched HUM IMPROVEMENT IDEATION: decay $LANE" >> "$LOG"
