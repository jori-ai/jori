#!/bin/bash
# jev-budget-check — daily Jev spend vs the TypeSafe prepaid budget; pages the
# system channel once per crossed threshold. No model, plain cron.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # JORI_INSTALL_TOOLS, JORI_NODE
LOG="$JORI_INSTALL_TOOLS/data/logs/jev-budget.log"
mkdir -p "$(dirname "$LOG")"
"${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/jev-budget-check" >> "$LOG" 2>&1
