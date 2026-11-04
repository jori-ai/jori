#!/usr/bin/env bash
set -euo pipefail

# Sleep window — skip 1am-8am in the user's LOCAL zone (phone-reported →
# data/user-timezone.json, falling back to the home zone, lib/instance.cjs tz)
# so it follows the user when travelling. Mirrors trigger-hum.sh. Base-10
# normalize to avoid octal parse of "08"/"09".
source "$(dirname "$0")/lib/root.sh"
source "$(dirname "$0")/lib/instance.sh"
USER_TZ_FILE="$JORI_INSTALL_TOOLS/data/user-timezone.json"
USER_TZ="${JORI_TZ:-UTC}"
if [[ -f "$USER_TZ_FILE" ]]; then
  PARSED_TZ=$(jq -r '.timezone // empty' "$USER_TZ_FILE" 2>/dev/null)
  if [[ -n "$PARSED_TZ" ]] && TZ="$PARSED_TZ" date +%H >/dev/null 2>&1; then
    USER_TZ="$PARSED_TZ"
  fi
fi
HOUR=$((10#$(TZ="$USER_TZ" date +%H)))
if (( HOUR >= 1 && HOUR < 8 )); then
  exit 0
fi

# Pause file — exit silently if present
if [[ -f "$JORI_INSTALL_TOOLS/data/cruise-watch-pause.json" ]]; then
  exit 0
fi

# Tier-routed (job-routing.json decides the tier). Its Chrome work goes through
# cdp-runner from Bash, which works from any supervisor, so it is not in
# config/chrome-jobs.json.
source "$(dirname "$0")/lib/webhook-auth.sh"
dispatch_or_skip '{"task": "CRUISE WATCH", "source": "cron-cruise-watch"}' cruise-watch || true
