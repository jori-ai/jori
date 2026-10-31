#!/usr/bin/env bash
# trigger-call-log.sh — log every call the user hosts on Zoom (jobs/call-log.md).
#
# No cron line of its own: an installation runs it from a recurring tick (e.g.
# trigger-context-sync.sh's */30 one, through its _ext/context-sync-tick.sh hook).
#
# From cron (no argument): code only. `call-log pending` reads Zoom's list of
# the user's room(s) and the Zoom summary emails (keys from secrets and .env,
# no Claude). Only when a call waits to be logged does it kick the on-demand
# launchd agent ai.claude.call-log; the first kick installs it from the repo
# plist (lib/launchd-kick.sh). A kick while a sync is running is a no-op.
#
# Under launchd (--run): the model step needs the Max login, which only the GUI
# session can read. No Claude call without a verified Max login (CLAUDE.md §
# Auth Model): a failed check skips the sync, the calls stay waiting for the
# next tick, and nothing pages (watchdog.sh owns Max-auth outage alerts; it
# reads this check's result from data/max-auth-probe.json).
export PATH="/opt/homebrew/bin:$HOME/.local/node/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"   # JORI_INSTALL_TOOLS, JORI_NODE
LOG="$JORI_INSTALL_TOOLS/data/logs/call-log.log"
BIN="$JORI_INSTALL_TOOLS/bin"
TIMEOUT="$(command -v timeout || command -v gtimeout || echo /opt/homebrew/bin/timeout)"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

if [ "${1:-}" = "--run" ]; then
  source "$(dirname "$0")/lib/max-auth-guard.sh"
  source "$(dirname "$0")/lib/max-auth-probe.sh"
  max_auth_scrub
  if ! max_auth_check "${CLAUDE_BIN:-$HOME/.local/bin/claude}"; then
    max_auth_from_ssh || max_auth_probe_record 0 "$MAX_AUTH_SUMMARY" call-log
    log "call-log sync skipped: Max login check failed ($MAX_AUTH_SUMMARY); the calls wait for the next tick"
    exit 0
  fi
  max_auth_from_ssh || max_auth_probe_record 1 "$MAX_AUTH_SUMMARY" call-log
  # Capped well under the sync lock's 30-minute staleness, so a hung Zoom read cannot hold it.
  exec "$TIMEOUT" --kill-after=30s 20m "$JORI_NODE" "$BIN/call-log" sync
fi

source "$(dirname "$0")/lib/launchd-kick.sh"
"$TIMEOUT" --kill-after=10s 90s "$JORI_NODE" "$BIN/call-log" pending --quiet >> "$LOG" 2>&1
rc=$?
case $rc in
  0) launchd_kick ai.claude.call-log call-log ;;
  3) ;;  # nothing waits
  *) log "call-log pending failed (exit $rc); the next tick tries again" ;;
esac
exit 0
