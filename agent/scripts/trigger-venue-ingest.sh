#!/bin/bash
# venue-ingest — daily fetch of every configured venue calendar into
# data/venue-events-state.json. No model, so plain cron is fine.
# Must run before the venue-watch lanes (they read the store it writes).
source "$(dirname "$0")/lib/root.sh"
LOG="$JORI_INSTALL/logs/venue-ingest.log"
mkdir -p "$(dirname "$LOG")"
"${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/venue-ingest" >> "$LOG" 2>&1
