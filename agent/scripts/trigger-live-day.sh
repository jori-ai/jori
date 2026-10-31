#!/bin/bash
# trigger-live-day.sh — every 10 min, refresh data/live-day.json so
# the user's evolving belief structure for the day stays current. Calendar seeds intervals
# at expected times; GPS evidence reinforces or contradicts; user-confirms
# lock; chat + task signals attach as evidence.
#
# No webhook dispatch — this is a pure local refresh. Logs to watchdog.log.
#
# CRON KICKS, LAUNCHD REFRESHES. The photo step's cross-check is `claude -p` on
# Max, which cron cannot reach (hundreds of "Not logged in" transcripts). So
# cron only kicks the agent ai.claude.live-day, which reruns this with --run
# (the same move segment-ask made).
# Not installed yet → the first cron run installs it from the repo plist itself
# (launchd_ensure_installed, lib/launchd-kick.sh; a hand install never came)
# and kicks it; only if that fails does cron
# refresh inline minus that one call, never a skipped refresh or a page. No
# Claude call without a verified Max login.

export PATH="/opt/homebrew/bin:$PATH"

source "$(dirname "$0")/lib/root.sh"
REPO="$JORI_INSTALL_TOOLS"
LOGFILE="$REPO/agent/logs/watchdog.log"
LABEL="ai.claude.live-day"
MODE=""
NO_CLAUDE=""

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [live-day] $1" >> "$LOGFILE"; }

source "$(dirname "$0")/lib/max-auth-guard.sh"   # CLAUDE.md § Auth Model
source "$(dirname "$0")/lib/max-auth-probe.sh"   # hands the check result to watchdog.sh
max_auth_scrub
# Decided below for this run only; never inherit a skip from cron-run's env.
unset JORI_PHOTO_TEXT_NO_CLAUDE

if [ "${1:-}" = "--run" ]; then
  # Under launchd. A failed Max check skips the photo cross-check, not the
  # refresh, and pages nothing: watchdog.sh owns Max-auth outage alerts. It
  # reads this check's result from data/max-auth-probe.json, because cron
  # cannot reach the keychain to ask itself (a false "recovered" otherwise).
  # Not recorded from an SSH shell, which always reads logged out.
  if max_auth_check "${CLAUDE_BIN:-$HOME/.local/bin/claude}"; then
    max_auth_from_ssh || max_auth_probe_record 1 "$MAX_AUTH_SUMMARY" live-day
  else
    NO_CLAUDE="Max login check failed ($MAX_AUTH_SUMMARY)"
    max_auth_from_ssh || max_auth_probe_record 0 "$MAX_AUTH_SUMMARY" live-day
  fi
else
  SERVICE="gui/$(id -u)/$LABEL"
  if launchctl print "$SERVICE" >/dev/null 2>&1; then
    # No -k: a kick while a run is still going is a no-op, not a kill.
    if KICK_OUT=$(launchctl kickstart "$SERVICE" 2>&1); then
      log "kicked launchd agent $LABEL"
      exit 0
    fi
    MODE=" [inline from cron: kickstart $LABEL failed: $(printf '%s' "$KICK_OUT" | head -c 120)]"
  else
    # Added but never installed: install it from the repo and kick it. A copy
    # booted out on purpose, or a failed install, keeps the inline refresh below.
    source "$(dirname "$0")/lib/launchd-kick.sh"   # functions only
    if launchd_ensure_installed "$LABEL" live-day; then
      if KICK_OUT=$(launchctl kickstart "$SERVICE" 2>&1); then
        log "kicked launchd agent $LABEL"
        exit 0
      fi
      MODE=" [inline from cron: kickstart $LABEL failed after installing it: $(printf '%s' "$KICK_OUT" | head -c 120)]"
    else
      MODE=" [inline from cron: $LABEL not installed]"
    fi
  fi
  NO_CLAUDE="no Claude login from cron"
fi
[ -n "$NO_CLAUDE" ] && export JORI_PHOTO_TEXT_NO_CLAUDE="$NO_CLAUDE"   # photo-place-name.js, address-match.mjs
# The one run that asks a model for English names of map labels (place_naming.english_names);
# location-confirm, resolve-point and the MCP tools read what it leaves. Off when NO_CLAUDE is set.
export JORI_PLACE_NAMES_MODEL=1

ERRFILE=$(mktemp -t live-day-refresh); REPORT=$(mktemp -t live-day-photos)
trap 'rm -f "$ERRFILE" "$REPORT"' EXIT
export JORI_PHOTO_TEXT_REPORT="$REPORT"   # one tally line per photo pass
TIMEOUT=()   # normal runs take 5s-3.5min; 20 min is a hang
[ -x /opt/homebrew/bin/timeout ] && TIMEOUT=(/opt/homebrew/bin/timeout --signal=TERM --kill-after=30s 20m)

# One refresh at a time (inline vs launchd): busy → lockf -t 0 exits 75. The
# kernel lock dies with the refresh (macOS shlock never reclaims a dead pid's).
# stderr is kept apart: parsed together, any resolve-day diagnostic turned the
# line into "intervals=? current=? calendar_seeded=?" (133 of 144 runs once).
OUT=$(/usr/bin/lockf -k -s -t 0 "$REPO/agent/logs/live-day-refresh.lock" \
  "${TIMEOUT[@]}" "$REPO/bin/live-day" refresh 2>"$ERRFILE")
RC=$?
if [ $RC -eq 75 ]; then
  log "refresh skipped: the previous refresh is still running$MODE"
  exit 0
elif [ $RC -eq 124 ] || [ $RC -eq 137 ]; then
  log "refresh TIMED OUT after 20m or was killed (rc=$RC)$MODE"
  exit $RC
elif [ $RC -ne 0 ]; then
  log "refresh FAILED rc=$RC$MODE: $(printf '%s\n%s' "$(cat "$ERRFILE")" "$OUT" | head -c 400)"
  exit $RC
fi

LINE=$(printf '%s' "$OUT" | jq -r '"intervals=\(.intervals // 0) current=\(.current_interval_id // "none") calendar_seeded=\(.summary.calendar_seeded // 0)"' 2>/dev/null)
[ -n "$LINE" ] || LINE="(report unreadable: $(printf '%s' "$OUT" | head -c 200))"
PHOTOS=$(jq -rs 'if length == 0 then "photos: none to read" else
  (map(to_entries | map(select(.value | type == "number"))) | add | group_by(.key)
   | map({key: .[0].key, value: (map(.value) | add)}) | from_entries) as $t
  | "photos: stops=\($t.eligible) answered=\($t.answered) named=\($t.named) ceiling=\($t.ceiling) few_words=\($t.few_words) failed=\($t.failed) no_login=\($t.no_login)"
    + (([.[].error | strings] | first) as $e | if $e then " (\($e))" else "" end)
    + (if any(.[]; .pass_failed) then " pass failed" else "" end) end' "$REPORT" 2>/dev/null)
PHOTOS="${PHOTOS:-photos: tally unreadable}"
[ -n "$NO_CLAUDE" ] && PHOTOS="$PHOTOS; photo cross-check skipped: $NO_CLAUDE"
log "refresh ok: $LINE $PHOTOS$MODE"
