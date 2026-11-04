#!/bin/bash
# watchlist-intro-email-run — builds and sends the "new on your watchlist" email.
# Launched by the ops agent via `job-run` (jobs/watchlist-intro-email.md), never
# straight from cron: the bin forks `claude -p`, which can only authenticate from
# inside the Max-authenticated session. The bin owns delivery and its own
# failure pointer; this wrapper only logs.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS
TOOLS="$JORI_INSTALL_TOOLS"
node "$TOOLS/bin/watchlist-intro-email" >> "$TOOLS/agent/logs/watchlist-intro-email.log" 2>&1
