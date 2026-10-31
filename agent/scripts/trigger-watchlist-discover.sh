#!/bin/bash
# Monthly watchlist discovery trigger (cron, 1st @ 10:17). Hands off to the ops
# agent, which launches agent/scripts/watchlist-discover-run.sh via
# job-run — the run forks `claude -p`, and that only authenticates from inside
# the Max-authenticated supervisor session, not from cron.
#
# History: until 2026-10-04 this dispatched a long single-quoted prompt; an
# apostrophe added to it on 2026-08-11 made the script a bash syntax error, so
# the Sept and Oct scans never ran. The prompt is now the jobs/ playbook.
export PATH="/opt/homebrew/bin:$PATH"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS
source "$(dirname "$0")/lib/webhook-auth.sh"
# Tier from job-routing.json (sonnet → ops-light :9082, degrading upward if unhealthy).
dispatch_or_skip '{"job": "watchlist-discover", "source": "cron-watchlist-discover"}' watchlist-discover
echo "$(date '+%Y-%m-%d %H:%M:%S') [watchlist-discover] dispatched" >> "$JORI_INSTALL_TOOLS/agent/logs/watchlist-discover.log"
