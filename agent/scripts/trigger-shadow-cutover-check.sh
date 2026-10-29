#!/bin/bash
# shadow-cutover-check — daily: flip triage-decide from shadow to live once it
# meets its cutover bar (see bin/shadow-cutover-check).
# No model, plain cron.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS, JORI_NODE
LOG="$JORI_INSTALL_TOOLS/data/logs/shadow-cutover.log"
mkdir -p "$(dirname "$LOG")"
"${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/shadow-cutover-check" >> "$LOG" 2>&1
