#!/bin/bash
# Rental check-in/check-out calendar: reconcile the portfolio's Google calendar
# against the channel manager (confirmed stays) + the books' Firestore (signed
# leases). Direct local script — no webhook, no agent, no Anthropic API.
#
# This cron is the SAFETY NET. The fast path is POST /stay-sync on the
# supervisor, pinged by the hub's channel-manager webhook and the Firestore
# trigger on leases/tenants, which runs the same CLI within seconds of a change.
# Design: docs/stay-calendar.md. Config: agent/local/config/rentals.json
# `stay_calendar` (none = the CLI exits doing nothing).
#
# Wrapped in a trigger script (not a bare CLI cron line) so jori-cron-slots
# audit can see it. Secrets: the channel manager's API token + GOG_KEYRING_PASSWORD
# from .env (loaded by the CLI). Kill switch: data/.stay-calendar-off.
source "$(dirname "$0")/lib/root.sh"
export PATH="/opt/homebrew/bin:$PATH"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/stay-calendar.log"

if [ -f "$JORI_INSTALL_TOOLS/data/.stay-calendar-off" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [stay-calendar] kill switch present, skipping" >> "$LOGFILE"
  exit 0
fi

"${JORI_NODE:-node}" "$JORI_INSTALL_TOOLS/bin/stay-calendar" >> "$LOGFILE" 2>&1
rc=$?
[ $rc -ne 0 ] && echo "$(date '+%Y-%m-%d %H:%M:%S') [stay-calendar] cron run exit $rc" >> "$LOGFILE"
exit $rc
