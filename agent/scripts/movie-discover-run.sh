#!/bin/bash
# movie-discover-run — the weekly back-catalog film pass. Launched by the ops agent via
# job-run (jobs/movie-discover.md). Silent: anything added is introduced by the next
# morning's watchlist-intro-email.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS
TOOLS="$JORI_INSTALL_TOOLS"
LOGFILE="$TOOLS/agent/logs/movie-discover.log"
OUT=$(node "$TOOLS/bin/movie-discover" 2>>"$LOGFILE")
STATUS=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') [movie-discover] exit=$STATUS $(echo "$OUT" | tr -d '\n' | cut -c1-1500)" >> "$LOGFILE"
exit $STATUS
