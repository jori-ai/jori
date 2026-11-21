#!/bin/bash
# trigger-segment-ask — ask about a stop while the user can still remember it.
#
# Runs `segment-ask`, which is only a wire: day-segments --write gives each
# stop a row (including ones CLVisit never recorded), stop-identify decides
# whether a question is warranted at all (>80% certain → silence), and choice
# sends the tappable options.
#
# THREE BRAKES, and they are not decoration. The choice fast path spent an
# afternoon re-answering two taps every couple of minutes because nothing
# bounded it, so anything that writes to the user's chat on a timer gets
# an off switch, a cap, and a quiet window.
set -euo pipefail

export PATH=/opt/homebrew/bin:$PATH
source "$(dirname "$0")/lib/root.sh"       # JORI_INSTALL_TOOLS, JORI_NODE
source "$(dirname "$0")/lib/instance.sh"   # JORI_TZ (the home zone)
REPO="$JORI_INSTALL_TOOLS"
cd "$REPO"

# 1. Kill switch — same convention as the choice sweep.
if [ -f "$REPO/data/.segment-ask-off" ]; then
  echo "[segment-ask] disabled by kill switch"
  exit 0
fi

# 2. Not while the user is asleep: decided from sleep data and the phone's
#    lock/unlock rows (bin/sleep-night --gate), never the clock; awake means an
#    ask at any hour. 23:00-09:00 is only the fallback for an installation with
#    no sleep sensing, in the zone the phone last reported (else the home zone
#    rather than UTC, which could put it in the middle of the afternoon).
TZNAME=$(TZ_FILE="$REPO/data/user-timezone.json" HOME_TZ="${JORI_TZ:-UTC}" python3 - <<'PY'
import json, os
try:
    with open(os.environ["TZ_FILE"]) as fh:
        print(json.load(fh).get("timezone") or os.environ["HOME_TZ"])
except Exception:
    print(os.environ["HOME_TZ"])
PY
)
if SLEEP_GATE=$("${JORI_NODE:-node}" "$(dirname "$0")/../../bin/sleep-night" --gate --fallback 23-9 --tz "$TZNAME" 2>/dev/null); then
  echo "[segment-ask] asleep ($SLEEP_GATE) — not asking"
  exit 0
fi

# 3. The cap lives in segment-ask itself (--max), which reports what it skipped.
exec "$REPO/bin/segment-ask" --tz "$TZNAME" --apply --max 2
