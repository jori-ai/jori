#!/bin/bash
# companion-presence — every 10 min, one Find My reading per person who shares
# their location with the user, then compare the readings with the user's own GPS
# trail and add whoever was with the user to the user's visit rows
# (location_history.companions). See jobs/companion-presence.md.
#
# Checked periodically so the daily summary does not have to ask whether a
# companion was there.
#
# A DIRECT script, no webhook and no agent turn: it is geometry with no judgment
# in it (Rule #0b), and Find My reads need only .env (ICLOUD_PASS), so cron
# is fine. Runs around the clock: an overnight stay needs its readings too.
#
# Silent: one summary line per run in data/logs/companion-presence.log. The
# CLI posts one silent system row itself after an hour of failed Find My reads.
# Kill switch: data/.companion-presence-off.

source "$(dirname "$0")/lib/root.sh"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
G="$JORI_INSTALL"
[ -f "$G/data/.companion-presence-off" ] && exit 0
mkdir -p "$G/data/logs"
echo "$(date '+%Y-%m-%d %H:%M:%S') $("$JORI_INSTALL_TOOLS/bin/companion-presence" tick 2>&1 | tail -1 | cut -c1-400)" \
  >> "$G/data/logs/companion-presence.log"
exit 0
