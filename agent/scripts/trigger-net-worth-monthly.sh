#!/bin/bash
# Monthly net-worth refresh + the "Net worth update" email to its configured
# recipients (bin/net-worth; agent/local/config/investments.json `net_worth`).
# Direct local script: no webhook, no agent, no LLM — every figure is arithmetic
# over rows we already hold, and the email is a rendered table.
#
# Order matters. Property valuations must be refreshed BEFORE the snapshot is
# taken, or the month's headline number silently repeats last month's property
# figure while everything else moves — which would read as "property flat" when
# it simply was not measured.
#
#   1. zestimate        Zillow, via the host's own Chrome (no API exists)
#   2. property-values  RentCast AVM + reconcile against the Zestimates
#   3. net-worth        snapshot + email
#
# Steps 1 and 2 are allowed to fail without stopping the run: a stale property
# number is much better than no net-worth email at all, and reconcile() falls
# back to purchase price when a source goes missing. Step 3 failing is a real
# failure and reports itself.
#
# Kill switch: data/.net-worth-monthly-off
source "$(dirname "$0")/lib/root.sh"
NODE="${JORI_NODE:-node}"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/net-worth-monthly.log"
BIN="$JORI_INSTALL_TOOLS/bin"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

if [ -f "$JORI_INSTALL_TOOLS/data/.net-worth-monthly-off" ]; then
  echo "$(stamp) [net-worth-monthly] kill switch present, skipping" >> "$LOGFILE"
  exit 0
fi

echo "$(stamp) [net-worth-monthly] start" >> "$LOGFILE"

# 1. Zestimates. Paced and self-limiting; stops itself on a bot challenge.
"$NODE" "$BIN/zestimate" >> "$LOGFILE" 2>&1
echo "$(stamp) [net-worth-monthly] zestimate exit $?" >> "$LOGFILE"

# 2. RentCast + reconcile. Metered — refuses to exceed the free tier itself.
"$NODE" "$BIN/property-values" >> "$LOGFILE" 2>&1
echo "$(stamp) [net-worth-monthly] property-values exit $?" >> "$LOGFILE"

# 3. Snapshot + email. This one's failure matters.
"$NODE" "$BIN/net-worth" --email >> "$LOGFILE" 2>&1
RC=$?
echo "$(stamp) [net-worth-monthly] net-worth exit $RC" >> "$LOGFILE"

if [ "$RC" -ne 0 ]; then
  "$BIN/jori-send-curl" --channel system --skip-precheck --intent net-worth \
    "⚠️ The monthly net worth email didn't go out — net-worth exited $RC. Log: agent/logs/net-worth-monthly.log" \
    >> "$LOGFILE" 2>&1
fi

exit $RC
