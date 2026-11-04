#!/bin/bash
# reservoir-mark-done — nightly pass that strikes out area-guide places the user has
# already been to, so the guides stop suggesting things already done.
# Pure CLI — no webhook, no agent.
#
# Runs AFTER daily-summary (registered in clock-jobs.json at 07:35 local vs the
# summary's 07:05) because the daily summary is its primary evidence: it is
# already vetted against chat + transactions + Places, and it names visits that
# never became a GPS stop. A day's lag is harmless anyway — the tool rescans a
# 60-day window and is idempotent, so a missed night self-corrects.
#
# node is NOT on cron's PATH (root.sh resolves it). Omitting this is
# the bug class that silently killed france-itinerary for six days and the
# daily-summary thumb pre-warm for days (2026-07-17) — a bare interpreter name
# ENOENTs under cron and the failure gets swallowed. Keep the export, and let the
# exit code speak.
source "$(dirname "$0")/lib/root.sh"
[ -n "$JORI_NODE" ] && export PATH="$(dirname "$JORI_NODE"):$PATH"
BIN="$JORI_INSTALL_TOOLS/bin"
LOG="$JORI_INSTALL_TOOLS/agent/logs/reservoir-mark-done.log"

if ! command -v node > /dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') FAILED: node not found on PATH" >> "$LOG"
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting reservoir-mark-done" >> "$LOG"
OUT=$("$BIN/trip-reservoir-mark-done" 2>&1)
RC=$?
echo "$OUT" >> "$LOG"

if [ "$RC" -ne 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') FAILED (exit $RC)" >> "$LOG"
  exit "$RC"
fi

# Fill photos for any entry that still lacks one (idempotent: entries with a
# photo_url are skipped). This keeps a freshly-built or newly-added guide entry
# from sitting photo-less until someone re-runs the backfill by hand. A photo
# failure is not a job failure — the tool skips and reports, never exits non-zero
# for a missing image.
PHOTOS=$("$BIN/trip-reservoir-photos" 2>&1)
# Keep the per-entry misses, not just the summary: the summary alone reported
# "17 failed" for three straight nights with no way to see WHICH 17 or why.
echo "$PHOTOS" | grep -E "^   ." >> "$LOG"
echo "$PHOTOS" | tail -1 >> "$LOG"

# Apply any trip-feedback answers the user has given since the last run — the
# other half of this loop. mark-done above records that the user WENT somewhere;
# this records what they thought of it, so the daily planner can weight the
# reservoir instead of treating every struck entry as equally successful.
# Rides here rather than on its own cron so the two halves stay together.
# A feedback failure is not a job failure — the strike pass above already
# succeeded, and an unapplied answer is retried on the next run (idempotent).
FEEDBACK=$("$BIN/trip-feedback-apply" 2>&1) || true
echo "$FEEDBACK" >> "$LOG"

echo "$(date '+%Y-%m-%d %H:%M:%S') Done (exit 0)" >> "$LOG"
