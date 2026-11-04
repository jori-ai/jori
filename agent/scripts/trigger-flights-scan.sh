#!/usr/bin/env bash
set -euo pipefail

# Daily 7 AM cron — the SAFETY-NET trigger for flights-scan. It owns brand-new
# bookings and catches anything the event-driven path missed. Travel
# change/cancellation emails ALSO dispatch flights-scan immediately via the
# ops-agent triage "Travel-change fast-path" (source=travel-change); this cron
# is the daily backstop, not the only path. Both run the same idempotent scan.

# Sleep window — skip 1am-7am in the user's LOCAL zone (phone-reported →
# data/user-timezone.json, falling back to the home zone, lib/instance.cjs tz)
# so it follows the user when travelling. Mirrors trigger-hum.sh. Force
# base-10: `date +%H` yields zero-padded hours ("08"/"09") that bash
# arithmetic parses as octal → "value too great for base" and (under set -e) a
# crashed trigger that never dispatches the scan.
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
if (( HOUR >= 1 && HOUR < 7 )); then
  exit 0
fi

# Scripted: bin/flights-scan-run runs in the GUI session
# via launchd (its extraction step is a tool-less claude -p on Max, which cron
# cannot authenticate). The triage travel-change fast-path reaches the same
# launchd agent. Playbook: ops-agent/jobs/flights-scan.md
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.flights-scan flights-scan
