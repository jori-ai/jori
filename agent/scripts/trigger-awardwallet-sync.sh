#!/bin/bash
# Weekly miles & points snapshot from AwardWallet into Supabase
# (loyalty_accounts / loyalty_balance_history), next to the bank accounts.
# Direct local scripts: no webhook, no agent, no LLM. An on-demand refresh
# ("refresh my points") runs this same script.
#
# READ-ONLY (GET-only client). The API key is IP-whitelisted to the home IP;
# a change there surfaces as an IP_DENIED system-channel alert.
#
# OFF without AWARDWALLET_API_KEY in .env: every step below exits 0 untouched.
#
# Config (optional): agent/local/config/loyalty.json
#   direct_readers — install-relative commands run first, each reading one
#                    program AwardWallet cannot read off the provider's own
#                    site into loyalty_accounts (owner_kind 'direct'); their
#                    health is judged by awardwallet-sync, which reads the rows
#                    back, so a failure here needs no handling of its own.
#   alert_intent   — see bin/awardwallet-sync.
#
# Kill switch: data/.awardwallet-sync-off
source "$(dirname "$0")/lib/script-job-env.sh"   # PATH, JORI_INSTALL_TOOLS, JORI_REPO
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/awardwallet-sync.log"
mkdir -p "$(dirname "$LOGFILE")"
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

if [ -f "$JORI_INSTALL_TOOLS/data/.awardwallet-sync-off" ]; then
  echo "$(stamp) [awardwallet-sync] kill switch present, skipping" >> "$LOGFILE"
  exit 0
fi

CONFIG_JS="const { localConfig } = require(process.argv[1]); const c = localConfig('loyalty', {});"

# Step 0: the direct readers (one per line).
READERS="$(node -e "$CONFIG_JS for (const r of c.direct_readers || []) console.log(r)" "$JORI_REPO/lib/instance.cjs" 2>/dev/null)"
while IFS= read -r reader; do
  [ -z "$reader" ] && continue
  echo "$(stamp) [$reader] start" >> "$LOGFILE"
  node "$JORI_REPO/$reader" >> "$LOGFILE" 2>&1
  echo "$(stamp) [$reader] exit $?" >> "$LOGFILE"
done <<< "$READERS"

# Step 1: make AwardWallet re-read every program first. Many programs only
# update through the AwardWallet extension in the automation Chrome (:9222), so
# without this the API just hands back whatever AwardWallet last saw.
# Exit 2 = signed out of AwardWallet in that Chrome: warn the user once (marker
# file), clear the marker when a refresh succeeds again. Any other refresh
# failure is logged only — the sync below still runs on AwardWallet's last copy,
# and a program that goes stale will trip the 21-day disconnect warning.
SIGNED_OUT_MARK="$JORI_INSTALL_TOOLS/data/.awardwallet-signed-out"
ALERT_INTENT="$(node -e "$CONFIG_JS console.log(c.alert_intent || 'loyalty-alert')" "$JORI_REPO/lib/instance.cjs" 2>/dev/null || echo loyalty-alert)"
echo "$(stamp) [awardwallet-refresh] start" >> "$LOGFILE"
node "$JORI_REPO/bin/awardwallet-refresh" >> "$LOGFILE" 2>&1
RRC=$?
echo "$(stamp) [awardwallet-refresh] exit $RRC" >> "$LOGFILE"
if [ "$RRC" -eq 2 ]; then
  if [ ! -f "$SIGNED_OUT_MARK" ]; then
    touch "$SIGNED_OUT_MARK"
    "$JORI_REPO/bin/jori-send-curl" --skip-precheck --intent "$ALERT_INTENT" --agent ops \
      "🎫 AwardWallet is signed out in the automation Chrome, so this week's points refresh couldn't run. Sign in at awardwallet.com in that Chrome and balances will update next run." >> "$LOGFILE" 2>&1
  fi
elif [ "$RRC" -eq 0 ]; then
  rm -f "$SIGNED_OUT_MARK"
  sleep 20  # let AwardWallet's API catch up with the updates
fi

echo "$(stamp) [awardwallet-sync] start" >> "$LOGFILE"
node "$JORI_REPO/bin/awardwallet-sync" >> "$LOGFILE" 2>&1
RC=$?
echo "$(stamp) [awardwallet-sync] exit $RC" >> "$LOGFILE"
exit $RC
