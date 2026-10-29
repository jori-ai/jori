#!/bin/bash
set -uo pipefail
# Trigger the daily occasion-ideas email (jobs/occasion-ideas.md).
#
# For each configured occasion (an anniversary, a birthday), one email a day
# from `window_days` before the date through the day itself, every year:
# restaurant suggestions, events and shows for where the user will be that day,
# written by Opus.
#
# Date-gated here, logic in the playbook. Fires daily (slot from
# jori-cron-slots) whenever today, in the instance time zone, is within
# `window_days` of an occasion in agent/local/occasion-ideas/occasions.json:
#   { "window_days": 21, "occasions": [{ "id", "label", "month_day": "MM-DD",
#     "since": <start year>, "kind": "anniversary"|"birthday" }] }
# Silent (no model spend at all) on the other days, and always with no file.
#
# EPHEMERAL OPUS, LAUNCHED BY LAUNCHD (ai.claude.occasion-ideas), not cron
# and not a webhook dispatch: `"model": "opus"` in job-routing.json is only a
# tier label, and a cron-launched `claude -p` can't unlock the keychain holding
# the Max credentials. Same shape as trigger-cost-efficiency-review.sh.
#
# Flags:
#   --force   run even if today's email already went out (manual re-run)

source "$(dirname "$0")/lib/root.sh"      # JORI_INSTALL_TOOLS, JORI_NODE
source "$(dirname "$0")/lib/instance.sh"  # JORI_TZ
export PATH="/opt/homebrew/bin:$PATH:$JORI_INSTALL_TOOLS/bin"
ROOT="$JORI_INSTALL_TOOLS"
DATA="$ROOT/data"
CONFIG="${OCCASION_IDEAS_CONFIG:-$ROOT/agent/local/occasion-ideas/occasions.json}"
JOB_MD="$ROOT/agent/ops-agent/jobs/occasion-ideas.md"
LOG="$DATA/logs/occasion-ideas.log"
MARKER="$DATA/.occasion-ideas-last-run"
ZONE="${JORI_TZ:-UTC}"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

mkdir -p "$DATA/logs"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [occasion-ideas] $1" >> "$LOG"; }

if [ -f "$DATA/.occasion-ideas-pause" ]; then
  log "paused (data/.occasion-ideas-pause present) — skip"
  exit 0
fi

[ -f "$CONFIG" ] || exit 0

TODAY=$(TZ="$ZONE" date +%F)

# Which occasions are in their window today? Pure calendar arithmetic on local
# dates — one line per active occasion: id|label|date|days_out|nth|kind
ACTIVE=$("${JORI_NODE:-node}" -e '
const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const today = process.argv[2];
const [ty, tm, td] = today.split("-").map(Number);
const t0 = Date.UTC(ty, tm - 1, td);
for (const o of cfg.occasions) {
  const [m, d] = o.month_day.split("-").map(Number);
  for (const y of [ty, ty + 1]) {
    const days = Math.round((Date.UTC(y, m - 1, d) - t0) / 86400000);
    if (days >= 0 && days <= cfg.window_days) {
      const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      console.log([o.id, o.label, date, days, y - o.since, o.kind].join("|"));
      break;
    }
  }
}' "$CONFIG" "$TODAY" 2>>"$LOG")

if [ -z "$ACTIVE" ]; then
  exit 0
fi

if [ "$FORCE" -eq 0 ] && [ "$(cat "$MARKER" 2>/dev/null)" = "$TODAY" ]; then
  log "already ran for $TODAY — skip (use --force to re-run)"
  exit 0
fi

TASK="OCCASION IDEAS (daily, run date $TODAY, $ZONE). Active occasion(s) today — one per line, fields id|label|date|days_out|nth (anniversary number or age turning)|kind:
$ACTIVE
Follow the playbook below end-to-end for EACH active occasion, including sending the email. Read data/occasion-ideas-state.json first so today's email adds what yesterday's did not."

log "dispatching: $(echo "$ACTIVE" | tr '\n' ';')"
"$ROOT/agent/scripts/lib/run-ephemeral-opus.sh" occasion-ideas "$JOB_MD" --task "$TASK" --timeout-min 50
RC=$?
if [ "$RC" -eq 0 ]; then
  echo "$TODAY" > "$MARKER"
fi
log "exit $RC"
exit $RC
