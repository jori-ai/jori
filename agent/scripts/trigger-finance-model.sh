#!/bin/bash
# Nightly build of the finance model (subscriptions, income streams, merchant
# stats, category baselines, recurring obligations) → data/finance-model.json,
# which the `finance` hum harvester reasons against. Direct local script — no
# webhook, no agent, no Anthropic API. READ-ONLY over plaid_*.
# Kill switch: data/.finance-model-off.
#
# The installation's own nightly finance work that should follow the model
# (reconciliations of its own books, say) rides this tick through the optional
# hook _ext/finance-model-after.sh; none in a plain install. It runs after the
# model, its output goes to the same log, and its failure never fails the model.
source "$(dirname "$0")/lib/root.sh"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/finance-model.log"
mkdir -p "$(dirname "$LOGFILE")"

if [ -f "$JORI_INSTALL_TOOLS/data/.finance-model-off" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [finance-model] kill switch present, skipping" >> "$LOGFILE"
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [finance-model] start" >> "$LOGFILE"
"$JORI_NODE" "$JORI_TOOLS/bin/finance-model" >> "$LOGFILE" 2>&1
RC=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') [finance-model] exit $RC" >> "$LOGFILE"

AFTER_EXT="$(dirname "$0")/_ext/finance-model-after.sh"
if [ -x "$AFTER_EXT" ]; then
  "$AFTER_EXT" >> "$LOGFILE" 2>&1 || true
fi

exit $RC
