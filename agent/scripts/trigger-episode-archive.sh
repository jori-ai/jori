#!/bin/bash
# episode-archive — pure cron script, NO agent turn (since 2026-10-04).
#
# Commits yesterday's `daily_summaries` row to the wiki as `day_YYYY-MM-DD`
# (bin/wiki-day-write), ingests the weekly/monthly rollup page on
# Monday / the 1st, backfills embeddings, verifies, and reports failure on the
# system channel. Playbook (documentation): ops-agent/jobs/episode-archive.md.
#
# Why no agent: the playbook itself says there is "no language judgment
# anywhere in this job" (Rule #0b). On 2026-08-01 the dispatched turn ended with
# zero tool calls and day_2026-07-31 was lost; the day write moved here then.
# Since 2026-10-04 the rest (rollups, embed, verify, failure report) is here too.
#
# "Yesterday" is the user's LOCAL yesterday (bin/local-day), not the home zone's — the
# same fix daily-summary got on 2026-10-03. daily-summary names its day on the
# local clock, so the page we look for must be named the same way.
export PATH="/opt/homebrew/bin:$PATH"
source "$(dirname "$0")/lib/trigger-helpers.sh"
source "$(dirname "$0")/lib/root.sh"
source "$(dirname "$0")/lib/instance.sh"
HOME_TZ="${JORI_TZ:-UTC}"

TRIGGER_JOB="episode-archive"
BIN="$JORI_TOOLS/bin"
alert() { "$BIN/jori-send-curl" --channel system --skip-precheck "$1" >/dev/null 2>&1 || true; }
run_capped() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }

YESTERDAY=$("$BIN/local-day" yesterday 2>/dev/null) || YESTERDAY=$(TZ="$HOME_TZ" date -v-1d +%Y-%m-%d)
TODAY=$("$BIN/local-day" today 2>/dev/null) || TODAY=$(TZ="$HOME_TZ" date +%Y-%m-%d)

# --- Step 1: day page ---------------------------------------------------------
# NOTE on the schedule: this job is pinned at a fixed 25 7 home time, but
# daily-summary is clock-anchored to the user's local time and rewritten into
# home time nightly by cron-tz-sync. West of home daily-summary would fire
# AFTER this job and the row
# would not exist yet; the verification below makes that visible.
#
# Read-then-write: wiki-day-write appends two identical page_revisions rows per
# invocation, so only write when the page is missing.
if ! "$BIN/wiki" read "day_$YESTERDAY" >/dev/null 2>&1; then
  EA_OUT=$(run_capped 300 node "$BIN/wiki-day-write" "$YESTERDAY" 2>&1)
  EA_RC=$?
  # Verify the OUTCOME, not the exit code: wiki-day-write exits 0 when the
  # daily_summaries row is missing ("skipped").
  if "$BIN/wiki" read "day_$YESTERDAY" >/dev/null 2>&1; then
    trigger_log "wiki-day-write $YESTERDAY ok (rc=$EA_RC): ${EA_OUT:-(no output)}"
  else
    trigger_log "wiki-day-write $YESTERDAY FAILED — day_$YESTERDAY still missing (rc=$EA_RC): ${EA_OUT:-(no output)}"
    alert "episode-archive: day_$YESTERDAY is missing from the wiki — $(echo "${EA_OUT:-no output}" | tail -1 | cut -c1-200). Usually means daily-summary did not produce a row for that day."
  fi
else
  trigger_log "day_$YESTERDAY already present"
fi

# --- Step 1a: rollups on Monday / 1st (local calendar) ------------------------
DOW=$(node -e 'console.log(new Date(process.argv[1]+"T12:00:00Z").getUTCDay())' "$TODAY")   # 1 = Monday
DOM=${TODAY:8:2}
if [ "$DOW" = "1" ]; then
  out=$("$BIN/wiki-week-write" "$YESTERDAY" 2>&1) && trigger_log "wiki-week-write ok: $(echo "$out" | tail -1)" \
    || trigger_log "wiki-week-write FAILED (non-fatal): $(echo "$out" | tail -1 | cut -c1-200)"
fi
if [ "$DOM" = "01" ]; then
  LAST_MONTH=${YESTERDAY:0:7}
  out=$("$BIN/wiki-month-write" "$LAST_MONTH" 2>&1) && trigger_log "wiki-month-write $LAST_MONTH ok: $(echo "$out" | tail -1)" \
    || trigger_log "wiki-month-write $LAST_MONTH FAILED (non-fatal): $(echo "$out" | tail -1 | cut -c1-200)"
fi

# --- Step 1b: embed new daily_summaries rows (local Ollama) ------------------
out=$("$BIN/embed-daily-summaries" 2>&1) && trigger_log "embed ok: $(echo "$out" | tail -1 | cut -c1-160)" \
  || trigger_log "embed FAILED (non-fatal, next run retries): $(echo "$out" | tail -1 | cut -c1-200)"

# --- Step 2: verify the page has a body --------------------------------------
if "$BIN/wiki" read "day_$YESTERDAY" >/dev/null 2>&1; then
  LINES=$("$BIN/episode" "$YESTERDAY" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${LINES:-0}" -lt 8 ]; then
    trigger_log "day_$YESTERDAY body looks empty ($LINES lines)"
    alert "episode-archive: day_$YESTERDAY exists but its body is nearly empty ($LINES lines) — daily_summaries.narrative may be null or a stub. Left for manual inspection."
  fi
fi
exit 0
