#!/usr/bin/env bash
# Launch watch — free calendar holds for announced launches matching
# agent/local/config/launch-watch.json `search` (bin/launch-watch-run).
# Runs the script DIRECTLY — no agent dispatch, no model.
#
# Usage: trigger-launch-watch.sh [job-name]   (job-name names the log and the
# pause file; default launch-watch — an installation that scheduled this
# capability under an older name passes that name).
set -euo pipefail
JOB="${1:-launch-watch}"

source "$(dirname "$0")/lib/root.sh"      # JORI_INSTALL_TOOLS, JORI_NODE
source "$(dirname "$0")/lib/instance.sh"  # JORI_TZ

# Sleep window — skip 01:00-08:00 in the user's CURRENT zone (phone-reported
# data/user-timezone.json, else the home zone), so it follows them when they travel.
USER_TZ_FILE="$JORI_INSTALL_TOOLS/data/user-timezone.json"
USER_TZ="${JORI_TZ:-UTC}"
if [[ -f "$USER_TZ_FILE" ]]; then
  PARSED_TZ=$(jq -r '.timezone // empty' "$USER_TZ_FILE" 2>/dev/null || true)
  if [[ -n "$PARSED_TZ" ]] && TZ="$PARSED_TZ" date +%H >/dev/null 2>&1; then
    USER_TZ="$PARSED_TZ"
  fi
fi
HOUR=$(TZ="$USER_TZ" date +%H)
if (( 10#$HOUR >= 1 && 10#$HOUR < 8 )); then
  exit 0
fi

# Pause file — exit silently if present
[[ -f "$JORI_INSTALL_TOOLS/data/$JOB-pause.json" ]] && exit 0

# Cadence gate: run if any known launch is within 7d, or the last check is ≥7d
# old / never (lib/launch-watch.mjs shouldRun). Unconfigured → the script says
# so and the gate is "0".
SHOULD=$("$JORI_NODE" "$JORI_INSTALL_TOOLS/bin/launch-watch-run" --gate 2>/dev/null | tail -c 1 || true)
[[ "$SHOULD" == "1" ]] || exit 0

source "$(dirname "$0")/lib/script-job-env.sh"
run_script_job "$JOB" "$JORI_REPO/bin/launch-watch-run"
exit 0
