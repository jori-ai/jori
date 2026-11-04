#!/bin/bash
# Plaid bank sync: pull balances + transactions for every connected Item into
# Supabase and push threshold alerts. Direct local script — no agent, no
# Anthropic API (deterministic; cheap; safe on a tight cron). The LLM-driven
# spending narrative is the SEPARATE weekly finance review job.
#
# BACKSTOP, NOT THE PRIMARY TRIGGER. Plaid's SYNC_UPDATES_AVAILABLE webhook
# drives the sync per-Item the moment the bank's data lands
# (agent/supervisor/plaid-webhook.mjs). These runs exist to catch events missed
# while the host or the ops supervisor was down, and to feed the nightly
# finance model. A missed webhook costs latency, never data: /transactions/sync
# is cursor-based, so the next run resumes where it left off.
#
# READ-ONLY: bin/plaid-sync only reads balances + transactions; it has no
# code path that moves money (see agent/CLAUDE.md § Financial Operations).
#
# Secrets: PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV come from .env
# (loaded by the CLI). Kill switch: data/.plaid-sync-off. No connected Items
# (a fresh install) → plaid-sync says so and exits 0.
source "$(dirname "$0")/lib/root.sh"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/plaid-sync.log"
mkdir -p "$(dirname "$LOGFILE")"

if [ -f "$JORI_INSTALL_TOOLS/data/.plaid-sync-off" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [plaid-sync] kill switch present, skipping" >> "$LOGFILE"
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [plaid-sync] start" >> "$LOGFILE"
"$JORI_NODE" "$JORI_TOOLS/bin/plaid-sync" >> "$LOGFILE" 2>&1
RC=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') [plaid-sync] exit $RC" >> "$LOGFILE"
exit $RC
