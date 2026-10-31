#!/bin/bash
# Weekly back-catalog movie harvester trigger (cron, Saturdays 08:27). Hands off to
# the ops agent, which launches agent/scripts/movie-discover-run.sh via job-run:
# the fit gate's Sonnet shadow/fallback forks `claude -p`, which only authenticates
# from inside the Max-authenticated supervisor session.
export PATH="/opt/homebrew/bin:$PATH"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS
source "$(dirname "$0")/lib/webhook-auth.sh"
dispatch_or_skip '{"job": "movie-discover", "source": "cron-movie-discover"}' movie-discover
echo "$(date '+%Y-%m-%d %H:%M:%S') [movie-discover] dispatched" >> "$JORI_INSTALL_TOOLS/agent/logs/movie-discover.log"
