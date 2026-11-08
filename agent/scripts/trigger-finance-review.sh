#!/usr/bin/env bash
set -uo pipefail

# Weekly financial review across every connected account (banks, cards,
# brokerage). This is an LLM job — it synthesizes the deterministic
# finance-review-data packet into a prioritized "what's of note" email.
# Read-only, jori-model-only.

source "$(dirname "$0")/lib/root.sh"

# Skip if no accounts are connected yet (nothing to review).
if ! "${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/plaid-connect" status 2>/dev/null | grep -q "item_id:"; then
  exit 0
fi

source "$(dirname "$0")/lib/webhook-auth.sh"
# FINANCE_REVIEW_SOURCE: cron-finance-review (Sunday) or cron-finance-review-sweep
# (bin/finance-review-gate sweep, resuming a review held for the user's answers).
dispatch_or_skip "{\"task\": \"FINANCE REVIEW\", \"source\": \"${FINANCE_REVIEW_SOURCE:-cron-finance-review}\"}" finance-review || true
