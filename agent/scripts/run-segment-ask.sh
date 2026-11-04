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

# 2. Quiet window. The user's timezone is whatever the phone last reported;
#    fall back to the home zone rather than guessing UTC, which could put the
#    quiet window in the middle of the afternoon.
TZNAME=$(TZ_FILE="$REPO/data/user-timezone.json" HOME_TZ="${JORI_TZ:-UTC}" python3 - <<'PY'
import json, os
try:
    with open(os.environ["TZ_FILE"]) as fh:
        print(json.load(fh).get("timezone") or os.environ["HOME_TZ"])
except Exception:
    print(os.environ["HOME_TZ"])
PY
)
HOUR=$(TZ="$TZNAME" date +%H)
if [ "$HOUR" -lt 9 ] || [ "$HOUR" -ge 23 ]; then
  echo "[segment-ask] quiet window ($HOUR:00 $TZNAME) — not asking"
  exit 0
fi

# 3. The cap lives in segment-ask itself (--max), which reports what it skipped.
exec "$REPO/bin/segment-ask" --tz "$TZNAME" --apply --max 2
