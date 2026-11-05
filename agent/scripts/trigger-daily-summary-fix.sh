#!/bin/bash
# trigger-daily-summary-fix.sh — run the daily-summary FIX LOOP for one day on
# ephemeral Opus (jobs/daily-summary-fix.md).
#
# Launched by launchd (ai.claude.daily-summary-fix), whose QueueDirectories key
# is data/daily-summary-fix/queue: `daily-summary-fix request <date>` drops
# a marker there (the daily-summary fork when the review did not confirm the day,
# the chat agent with the user's answer to a fixer question, the hourly sweep).
# Each run takes the OLDEST marker, removes it before anything slow (a marker
# left behind would relaunch forever), and runs the fixer for that date. launchd
# runs one instance per label, so fix runs are serial.
#
# Not cron: a cron-launched `claude -p` cannot unlock the Max keychain (see
# lib/run-ephemeral-opus.sh). The agent itself sends nothing except through
# `daily-summary-fix ask` and the playbook's own publish step.
#
# The `release-held` marker is not a date: the hourly sweep drops it
# when questions held through the user's quiet hours are due to be asked. The sweep
# runs from cron and must not send them itself: every question passes the outbound
# check and the truth gate, whose model steps need `claude -p` and fail from cron,
# so they would go out unchecked. This runner sends them first, and only after the
# same Max sign-in check the fork runner makes; signed out, they stay held and the
# next sweep queues them again.
#
# The `send-due` marker is not a date either: a corrected summary a fix run staged
# (`daily-summary-fix stage`) is due, past its quiet window. Its wake or the hourly
# sweep drops it; `daily-summary-fix send-due` sends it (code, no model, so no Max
# check). The same command runs after every fix run, for what that run staged or settled.

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPTS/lib/root.sh"   # JORI_INSTALL_TOOLS
ROOT="$JORI_INSTALL_TOOLS"
Q="$ROOT/data/daily-summary-fix/queue"
JOB_MD="$ROOT/agent/ops-agent/jobs/daily-summary-fix.md"
LOG="$ROOT/agent/logs/daily-summary-fix.log"
FIX="$ROOT/bin/daily-summary-fix"
CLAUDE="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
RELEASE="release-held"
SEND_DUE="send-due"
TIMEOUT_MIN=120

# Helpers on Sonnet: the repair loop's cost is kept down with lower-effort
# helper agents and Sonnet for triage, Opus for the actual fix, same schedule. The fixer itself stays Opus at xhigh (run-ephemeral-opus.sh); every
# Agent it spawns defaults to Sonnet unless the playbook names a model (the
# critic asks for Opus). Effort is set per spawn by the playbook (Claude Code
# 2.1.292+ Agent `effort`). Ids come from models.env, never a literal here.
MODELS_ENV="$ROOT/agent/config/models.env"
# shellcheck source=../config/models.env
[ -f "$MODELS_ENV" ] && source "$MODELS_ENV"
[ -n "${JORI_MODEL_SONNET:-}" ] && export CLAUDE_CODE_SUBAGENT_MODEL="$JORI_MODEL_SONNET"

mkdir -p "$Q" "$(dirname "$LOG")"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [daily-summary-fix] $1" >> "$LOG"; }

if [ -e "$Q/$RELEASE" ]; then
  rm -f "$Q/$RELEASE"   # before anything slow: a marker left behind would relaunch forever
  # shellcheck source=lib/max-auth-guard.sh
  source "$SCRIPTS/lib/max-auth-guard.sh"
  max_auth_scrub
  if max_auth_check "$CLAUDE"; then
    log "release-held: start"
    "$FIX" release-held >> "$LOG" 2>&1
    log "release-held: exit $?"
  else
    log "release-held: not run, the Max sign-in check failed ($MAX_AUTH_SUMMARY); the questions stay held and the next sweep queues them again"
  fi
fi

if [ -e "$Q/$SEND_DUE" ]; then
  rm -f "$Q/$SEND_DUE"   # before anything slow, as above
  "$FIX" send-due >> "$LOG" 2>&1
  log "send-due: exit $?"
fi

# Days the allowance governor held wait in held/ (outside the queue directory
# launchd watches); they go first, and a run that goes ahead hands the rest back.
HELD="$ROOT/data/daily-summary-fix/held"
mkdir -p "$HELD"
M="$(ls -1 "$HELD" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort | head -n1)"
[ -n "$M" ] && mv "$HELD/$M" "$Q/$M"
M="$(ls -1 "$Q" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort | head -n1)"
if [ -z "$M" ]; then
  # Clear stray files, but not a release or send-due marker dropped meanwhile (launchd
  # starts this runner again for it).
  for x in "$Q"/*; do [ -e "$x" ] && [ "$(basename "$x")" != "$RELEASE" ] && [ "$(basename "$x")" != "$SEND_DUE" ] && rm -f "$x"; done
  exit 0
fi
# The allowance governor (bin/allowance-brake via lib/allowance-gate.sh),
# decided before the marker is consumed: the fixer is important, so while the
# week is on pace to run out the user is asked (run now, run cheaper, wait for
# the reset) and every queued day waits in held/ (left in the queue, launchd
# would relaunch this runner in a loop that only holds again).
source "$SCRIPTS/lib/allowance-gate.sh"
allowance_gate daily-summary-fix "$M"
if [ "$BRAKE_RC" -eq 3 ]; then
  for x in "$Q"/*; do b="$(basename "$x")"; [[ "$b" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && mv "$x" "$HELD/$b"; done
  log "$M: held by the allowance governor: $BRAKE_REASON"
  exit 0
fi
# Model tier (the user's choice, 2026-11-03): Sonnet first, Opus once a Sonnet
# run for this date got stuck (`daily-summary-fix tier`, pickTier). The
# allowance governor's "cheaper model" answer overrides an Opus tier.
TIER_JSON="$("$FIX" tier "$M" 2>/dev/null)"
TIER="$(printf '%s' "$TIER_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tier||"opus")}catch{process.stdout.write("opus")}})' 2>/dev/null)"
[ -n "$TIER" ] || TIER="opus"
RUN_ARGS=()
if [ "$TIER" = "sonnet" ] && [ -n "${JORI_MODEL_SONNET:-}" ]; then
  RUN_ARGS=(--model "$JORI_MODEL_SONNET" --effort xhigh)
else
  TIER="opus"
fi
log "$M: tier $TIER ($TIER_JSON)"
if [ "$BRAKE_RC" -eq 4 ]; then
  RUN_ARGS=(--model "$BRAKE_MODEL" ${BRAKE_EFFORT:+--effort "$BRAKE_EFFORT"})
  TIER="sonnet"
  log "$M: cheaper model for this fix ($BRAKE_MODEL${BRAKE_EFFORT:+, $BRAKE_EFFORT}): $BRAKE_REASON"
fi
export JORI_BRAKE_DECIDED=1

rm -f "$Q/$M"
DATE="$M"
log "$DATE: start"

STATE="$("$FIX" status "$DATE" 2>/dev/null | head -c 12000)"
TASK="Run the DAILY SUMMARY FIX job for $DATE. The state file for this date (data/daily-summary-fix/$DATE.json) is below; any answers from the user are in it. ultrathink.

----- STATE $DATE -----
$STATE
----- END STATE -----"

"$SCRIPTS/lib/run-ephemeral-opus.sh" daily-summary-fix "$JOB_MD" --task "$TASK" --timeout-min "$TIMEOUT_MIN" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"}
RC=$?
log "$DATE: runner exit $RC"
# What this run left behind decides the next run's tier (a held or refused run
# did nothing, so it is not recorded).
if [ "$RC" -ne 78 ] && [ "$RC" -ne 75 ]; then "$FIX" tier-done "$DATE" "$TIER" >> "$LOG" 2>&1; fi
# A correction this run staged (or one waiting on this run) goes now if its quiet
# window has passed; otherwise this arms its wake.
"$FIX" send-due >> "$LOG" 2>&1
if [ "$RC" -eq 78 ]; then
  # Max-only guard refused (not signed in). Leave the day queued for the next
  # successful sign-in rather than looping now; the sweep re-queues it.
  log "$DATE: Max sign-in missing — not run"
fi
# Days still held waited behind this one: back into the queue for the next run.
for x in "$HELD"/*; do [ -e "$x" ] && mv "$x" "$Q/"; done
exit 0
