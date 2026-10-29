#!/usr/bin/env bash
set -euo pipefail

# Monthly per-property real-estate review — the rental ledger's own report
# (bin/finance-property-review-data, lib/rental-ledger.js): P&L by Schedule-E
# category per property, month-over-month and year-over-year, reconciliation
# health, rent-roll collection, reserves, deposits and yield.
#
# This is the MONTHLY half of a deliberate split with the weekly finance
# review, which stays on liquidity/accuracy/anomalies. Read-only,
# jori-model-only.

source "$(dirname "$0")/lib/root.sh"

# The ledger is the whole report, so there is nothing to dispatch without it
# (no rental books configured, or the books unreachable). Checking here rather
# than in the playbook means a dead ledger costs no agent turn at all.
if ! "$JORI_NODE" "$JORI_TOOLS/bin/finance-property-review-data" --json >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) finance-property-review: packet build failed or no rental books — skipping dispatch" >&2
  exit 0
fi

source "$(dirname "$0")/lib/webhook-auth.sh"
dispatch_or_skip '{"task": "FINANCE PROPERTY REVIEW", "source": "cron-finance-property-review"}' finance-property-review || true
