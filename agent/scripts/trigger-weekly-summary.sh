#!/bin/bash
# weekly-summary — Mondays, just after midnight (local). Code prepares, a model writes, code publishes.
#
# `period-summary prep weekly` computes the window on the user's
# LOCAL calendar, the exact stats and home/away nights (travel timeline), and
# writes a packet to data/period-summary/. The dispatched agent turn only
# writes {narrative, themes[]} and runs `period-summary publish`, which
# validates, upserts weekly_summaries, stamps the dailies and emails.
# Too little data → prep sends the short email itself and nothing is dispatched.
export PATH="/opt/homebrew/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/trigger-helpers.sh"

TRIGGER_JOB="weekly-summary"
OUT=$("$JORI_INSTALL_TOOLS/bin/period-summary" prep weekly 2>&1)
RC=$?
if [ $RC -eq 3 ]; then
  trigger_log "insufficient data — short email sent, no dispatch: $OUT"
  exit 0
elif [ $RC -ne 0 ]; then
  trigger_log "prep FAILED (rc=$RC): $(echo "$OUT" | tail -1 | cut -c1-200)"
  "$JORI_INSTALL_TOOLS/bin/jori-send-curl" --channel system --skip-precheck \
    "weekly-summary prep failed: $(echo "$OUT" | tail -1 | cut -c1-200)" >/dev/null 2>&1 || true
  exit 0
fi
trigger_log "packet ready: $OUT"
trigger_job "weekly-summary"
