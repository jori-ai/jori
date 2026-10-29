#!/bin/bash
# trigger-places-saved-refresh.sh — monthly refresh of the Google Maps
# saved-places store from a "Saved" Takeout export delivered to Drive.
#
# Direct script (no webhook, no Anthropic API). Thin wrapper around the worker
# bin/places-saved-refresh, which finds the newest takeout batch in Drive
# via gog, ingests the delta, and trashes older files. Requires gog Google auth
# (Drive scope); the worker logs + exits 0 when auth is absent.
#
# Runs monthly from tasks.json. Output -> agent/logs/places-saved-refresh.log
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"   # JORI_INSTALL_TOOLS
exec /usr/bin/python3 "$JORI_INSTALL_TOOLS/bin/places-saved-refresh"
