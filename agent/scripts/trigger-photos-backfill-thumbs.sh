#!/bin/bash
# Pre-warm yesterday's photo thumbs in Supabase before daily-summary runs.
# Both jobs are clock-anchored in clock-jobs.json (this at 03:15 local,
# daily-summary at 04:00 — a 45-min head start), local to wherever the user
# physically is; cron-tz-sync rewrites the crontab fields nightly, so there is
# no fixed home-zone time. Runs after photos-daily (03:00 local) so the
# `photos` table it reads is already populated for the target date.
# Without this, daily-summary's embed-img step does cold osxphotos exports per UUID
# (~120s timeout each), pushing past the 20-min TURN WATCHDOG.
# Pure CLI — no webhook, no agent.
#
# osxphotos is pipx-installed under ~/.local/bin, which is NOT on cron's PATH.
# Omitting it silently failed every thumb ("No such file or directory: 'osxphotos'")
# and still exited 0, so daily-summary hit cold thumbs and hung. Keep both entries.
source "$(dirname "$0")/lib/root.sh"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
BIN="$JORI_INSTALL_TOOLS/bin"
LOG="$JORI_INSTALL_TOOLS/agent/logs/photos-backfill-thumbs.log"

# The day the NEXT daily-summary run will compile: "yesterday" in the user's
# current LOCAL timezone, via the same bin/local-day daily-summary-run uses. A
# "yesterday in the home zone + lookahead" trick warmed the wrong day whenever
# the user was far east of home. Both jobs fire on the local clock
# (clock-jobs.json), so both name the day on it.
DATE=$("$BIN/local-day" yesterday 2>>"$LOG") || DATE=$(date -v-1d +%Y-%m-%d)

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting backfill-thumbs for $DATE" >> "$LOG"
OUT=$("$BIN/photos" backfill-thumbs --date "$DATE" 2>&1)
RC=$?
echo "$OUT" >> "$LOG"

# A pre-warm that leaves thumbs cold is a silent daily-summary outage. Surface it
# as a non-zero exit so cron-run records the failure in cron-runs.jsonl.
FAILED=$(echo "$OUT" | sed -n 's/.*"failed"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | tail -1)
if [ "$RC" -ne 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') FAILED (exit $RC)" >> "$LOG"
  exit "$RC"
fi
if [ -n "$FAILED" ] && [ "$FAILED" -gt 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') FAILED: $FAILED thumb(s) did not warm for $DATE — daily-summary will hit cold exports" >> "$LOG"
  exit 1
fi
echo "$(date '+%Y-%m-%d %H:%M:%S') Done (exit 0)" >> "$LOG"
