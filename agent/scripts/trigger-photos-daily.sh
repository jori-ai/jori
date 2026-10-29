#!/bin/bash
# photos-daily — pure cron script, NO agent turn (since 2026-10-04).
# Clock-anchored at 03:00 in the user's local time, wherever the user physically
# is (registered in clock-jobs.json; cron-tz-sync rewrites the crontab fields
# nightly, so there is no fixed home-zone time). A fixed home-zone time drifts
# to odd local hours while travelling; 3am local is a consistent
# overnight-processing anchor regardless of location.
# Runs before photos-backfill-thumbs (03:15 local) and daily-summary (04:00
# local) so the `photos` table is populated before either reads it.
# Indexes yesterday's Apple Photos into Supabase (see jobs/photos-daily.md).
#
# THE SYNC RUNS HERE, IN CRON — NOT IN AN AGENT TURN. `osxphotos`
# drives Photos.app over Apple events, which the Claude Code Bash sandbox blocks;
# inside an agent turn it fails 100% of the time with `applescript.ScriptError:
# Expected "," but found class name. (-2741)`. cron has no sandbox.
#
# Steps 2-4 (outcome check, companions backfill, stop synthesis, stale-render
# repair) used to be an agent turn; none of them involves language judgment, so
# they run here too. Stale-render repair escalation lives in
# lib/photos-rerender-ledger.mjs (normal → SILENT → give up once with a
# system alert), replacing an agent's `ls data/jobs | grep` check that
# re-sent one date three nights running. The ONE thing still dispatched is the
# re-render itself (Step 4b): it forks `claude -p`, which needs the login
# keychain cron cannot reach — see the long note above repair_stale().
# Failures go to the system channel; success is silent.

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"   # osxphotos lives in ~/.local/bin (pipx)

# dispatch_or_skip() + CURL_AUTH, for the stale-render repair in Step 4b below
# (the only part of this job that cannot run in cron — see the note there).
source "$(dirname "$0")/lib/root.sh"
source "$(dirname "$0")/lib/webhook-auth.sh"

LOGFILE="$JORI_INSTALL_TOOLS/agent/logs/watchdog.log"
BIN="$JORI_INSTALL_TOOLS/bin"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [photos-daily] $1" >> "$LOGFILE"; }
alert() { "$BIN/jori-send-curl" --channel system --skip-precheck "$1" >/dev/null 2>&1 || true; }

DAY=""
STALE_DATES=""

# Step 1 + 1b. Both cap their own osxphotos calls (600s / 900s), so neither can
# hang cron indefinitely. Failures are logged and alerted, never fatal.
run_sync() {
  local out errf
  # Sync the day daily-summary will compile: yesterday in the user's LOCAL tz
  # (bin/local-day). `photos sync`'s own default is yesterday in the home zone,
  # which at 03:00 local far east of home is two local days ago.
  DAY=$("$BIN/local-day" yesterday 2>/dev/null) || DAY=""
  errf=$(mktemp)
  out=$("$BIN/photos" sync ${DAY:+--date "$DAY"} 2>"$errf")
  if [ $? -eq 0 ]; then
    log "sync ok: $(echo "$out" | tr -d '\n ' | tail -c 120)"
    # Step 2: >25% unmatched means photo GPS or location tracking drifted.
    local um
    um=$(echo "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);const n=s.count||0,u=(s.stats||{}).unmatched||0;if(n>0&&u/n>0.25)console.log(u+" of "+n)}catch{}})' 2>/dev/null)
    [ -n "$um" ] && alert "Photos sync ${DAY}: $um unmatched to a location segment — photo GPS or location tracking may have drifted"
  else
    local err
    err=$(tail -1 "$errf" | cut -c1-200)
    log "sync FAILED: $err"
    alert "⚠️ photos sync failed for ${DAY:-yesterday}: $err"
  fi
  rm -f "$errf"

  out=$("$BIN/photos-sync-gaps" --days 8 --max 2 --json 2>&1)
  local sweep
  sweep=$(echo "$out" | tail -1)
  # The summary is bounded — one entry per day in the 45-day render window at
  # the very worst — so the findings ride in it untruncated-ish.
  log "gap sweep: $(echo "$sweep" | cut -c1-2000)"

  # Days whose photos are in the database but never made it onto the day page.
  # Its own line, and named, because this is the half nothing else reports:
  # the rows are present, so every other check reads the date as healthy.
  local stale
  stale=$(echo "$sweep" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);const r=s.stale_render||[];if(r.length)console.log(r.map(x=>`${x.date} (${x.photo_rows} photos, ${x.stops} stops)`).join(", "))}catch{}})' 2>/dev/null)
  if [ -n "$stale" ]; then
    log "stale render: photos landed but the day record shows none — $stale"
  fi
  STALE_DATES=$(echo "$sweep" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);console.log((s.stale_render||[]).map(x=>x.date).join(" "))}catch{}})' 2>/dev/null)
}

run_step() {
  local name="$1"; shift
  local out; out=$("$@" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ]; then
    log "$name ok: $(echo "$out" | tr -d '\n' | tail -c 120)"
  else
    log "$name FAILED ($rc): $(echo "$out" | tail -1 | cut -c1-200)"
    alert "photos-daily $name failed: $(echo "$out" | tail -1 | cut -c1-200)"
  fi
  return $rc
}

# Step 4b — stale-render repair; escalation decided by photos-rerender-plan.
#
# THE RE-RENDER IS DISPATCHED, NOT FORKED HERE. `daily-summary-run`
# forks a `claude -p` session, and a fork launched straight from cron has no
# route to the Max credential in the login keychain: it dies in under ten
# seconds with "Failed to authenticate: OAuth session expired and could not be
# refreshed". This is a written invariant, not a surprise — agent/CLAUDE.md
# § Long-Running Jobs says job-run "must be launched from an agent turn
# (inherits Max keychain auth), not straight from cron", and § Effort Policy says
# the same of ephemeral forks ("launchd, never cron — cron can't unlock the
# keychain"). Every cron-launched repair fork failed that way within 10s, while
# the 04:00-local daily-summary run an hour later — same binary, reached through
# the supervisor — succeeded every night; the failures paged the system channel
# as an auth outage, wrongly implying a re-login was the remedy.
#
# So the repair goes to the ops supervisor, which runs inside the user's GUI
# session and therefore has the keychain. Its whole turn is "launch job-run, end
# the turn" — exactly what jobs/daily-summary.md already specifies for the
# receiving agent. Nothing else in photos-daily dispatches; the sync, the
# companions backfill and the stop synthesis all still run here in cron.
#
# dispatch_rerender <date> <"" | " SILENT">
dispatch_rerender() {
  local date="$1" silent="$2"
  # The date comes from photos-rerender-plan, which only emits YYYY-MM-DD, but
  # it is interpolated into JSON below — so refuse anything else rather than
  # build a malformed payload. (Machine-generated structure, not language.)
  case "$date" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) log "stale render: refusing to dispatch malformed date '$date'"; return 1 ;;
  esac
  local cmd="$BIN/job-run --name day-rerender -- $BIN/daily-summary-run $date$silent"
  local task="PHOTOS STALE-RENDER REPAIR for $date. Photos for that date reached the database after its day page was built, so the page still shows none. Launch the re-render and end your turn with a one-line ack. It returns a job id immediately and the forked session does the whole re-render, so do not build anything inline, do not compose or send any message, and do not investigate further. Run exactly this one command, nothing else, nothing appended: $cmd"
  dispatch_or_skip "{\"task\": \"$task\", \"source\": \"photos-daily-rerender\"}" "daily-summary"
}

repair_stale() {
  [ -z "$STALE_DATES" ] && return 0
  local date mode
  # shellcheck disable=SC2086
  while read -r date mode; do
    [ -z "$date" ] && continue
    case "$mode" in
      normal)
        if dispatch_rerender "$date" ""; then
          log "stale render $date: re-render dispatched to the ops supervisor"
        else
          log "stale render $date: re-render NOT dispatched (no healthy supervisor); the ladder still counted this attempt"
        fi ;;
      silent)
        if dispatch_rerender "$date" " SILENT"; then
          log "stale render $date: prior repair did not stick — SILENT re-render dispatched to the ops supervisor"
        else
          log "stale render $date: SILENT re-render NOT dispatched (no healthy supervisor); the ladder still counted this attempt"
        fi ;;
      give-up)
        log "stale render $date: two repairs failed — giving up, alerting"
        alert "photos-daily: $date still shows photos_count=0 after two re-renders though photo rows exist. daily-summary-build render/publish needs a code-level look for this date; no further automatic attempts for 7 days." ;;
      skip)
        log "stale render $date: already escalated — skipping" ;;
    esac
  done < <("$BIN/photos-rerender-plan" $STALE_DATES 2>/dev/null)
}

run_sync
# Step 3 — companions from face tags (Find My misses companions who walked off).
run_step companions "$BIN/findme" backfill-companions --lookback 48 --json
# Step 4 — synthesize stops iOS missed, for the same local day the sync used.
[ -z "$DAY" ] && DAY=$("$BIN/local-day" yesterday 2>/dev/null)
run_step synthesize env DROP=1 "$BIN/photos-synthesize-stops" "$DAY"
repair_stale
exit 0
