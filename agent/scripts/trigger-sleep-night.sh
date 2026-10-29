#!/bin/bash
# sleep-night: combine the phone's last lock / first unlock with the Apple
# Watch's sleep stages into sleep_nights, and refresh
# data/sleep-night-state.json for `jori activity` (hum's quiet-hours
# gate). Saves the current night and the one before it, because the Watch's
# batch can land hours after waking. Direct local script — no agent, no API.
# Design: lib/sleep-night.js. Kill switch: data/.sleep-night-off.
source "$(dirname "$0")/lib/root.sh"
LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/sleep-night.log"

if [ -f "$JORI_INSTALL_TOOLS/data/.sleep-night-off" ]; then
  exit 0
fi
if [ -z "$JORI_NODE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [sleep-night] no node binary found" >> "$LOGFILE"
  exit 1
fi

out=$("$JORI_NODE" "$JORI_TOOLS/bin/sleep-night" --save --json 2>&1)
rc=$?
if [ $rc -ne 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [sleep-night] exit $rc: $(echo "$out" | tail -3 | tr '\n' ' ')" >> "$LOGFILE"
fi
exit $rc
