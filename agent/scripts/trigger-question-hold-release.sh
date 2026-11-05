#!/bin/bash
# trigger-question-hold-release.sh — send the questions the question hold kept
# while chat was not reading, once it reads again (lib/question-hold.mjs).
#
# Launched by launchd (ai.claude.question-hold-release) every 5 minutes, not
# by cron and not by the watchdog: each released question is re-judged by a
# model and then goes through jori-send-curl's resolve-first gate and outbound
# precheck, which all run `claude -p` on the Max login, and only the GUI
# session can read it. Signed out, nothing is sent and the questions stay held
# for a later run; nobody is paged (watchdog.sh owns Max-outage alerts).
#
# Exits at once when nothing is held (almost every run), so the 5-minute
# cadence costs nothing. Silent unless it did something.
# Off switch: data/.question-hold-off (the gate stops holding; anything already
# held still goes out here).
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS
STORE="$JORI_INSTALL_TOOLS/data/question-hold.json"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/question-hold.log"
mkdir -p "$(dirname "$LOGFILE")"

# Nothing held: an absent file, or an empty JSON array.
[ -s "$STORE" ] || exit 0
[ "$(tr -d '[:space:]' < "$STORE")" = "[]" ] && exit 0

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [question-hold] $1" >> "$LOGFILE"; }

source "$(dirname "$0")/lib/max-auth-guard.sh"   # CLAUDE.md § Auth Model
max_auth_scrub
if ! max_auth_check "${CLAUDE_BIN:-$HOME/.local/bin/claude}"; then
  log "release not run: the Max sign-in check failed ($MAX_AUTH_SUMMARY); the questions stay held"
  exit 0
fi

OUT=$(node "$JORI_INSTALL_TOOLS/bin/question-hold" release 2>&1)
RC=$?
# The summary is one JSON line; log it only when something moved or failed.
case "$OUT" in
  *'"released":0,"dropped":0,"held_back_at_release":0'*'"failed":0'*) ;;
  *) log "release (exit $RC): $OUT" ;;
esac
exit 0
