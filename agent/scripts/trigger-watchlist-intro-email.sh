#!/bin/bash
# Daily watchlist intro email trigger (cron). Gate in code first — most days
# nothing new was added and no agent turn should be spent — then hand off to the
# ops agent, which launches agent/scripts/watchlist-intro-email-run.sh via
# job-run: the run forks `claude -p` for the writeups, and that only
# authenticates from inside the Max-authenticated supervisor session.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/watchlist-intro-email.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [watchlist-intro-email] $1" >> "$LOGFILE"; }

OUT=$(node "$JORI_INSTALL_TOOLS/bin/watchlist-intro-email" --check 2>&1)
STATUS=$?
if [ $STATUS -eq 3 ]; then exit 0; fi          # nothing new — silent
if [ $STATUS -ne 0 ]; then log "check failed (exit $STATUS): $OUT"; exit 0; fi

source "$(dirname "$0")/lib/webhook-auth.sh"
dispatch_or_skip '{"job": "watchlist-intro-email", "source": "cron-watchlist-intro-email"}' watchlist-intro-email
log "dispatched ($OUT)"
