#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger location-confirm via cron every 10 min.
#
# Flow:
#   1. Run `bin/location-current-stop` → JSON with current dwell + candidates.
#   2. Skip if not is_stop, or if needs_confirm=false (already_known / high_conf / photo).
#   3. Quiet-window check (sleep 00-09 local + active calendar event):
#        - In quiet window  → write ask to pending-asks queue, exit 0 (no dispatch)
#        - Out of quiet     → drain queued + resolve each via the hybrid path
#   4. Hybrid per-ask resolution:
#        a. Programmatic precheck (location-confirm-precheck.mjs) — calendar
#           overlap match → auto-confirm without asking.
#        b. Otherwise run location-confirm-resolve.mjs — LOCAL-first
#           deterministic memory + calendar +
#           message matching over a pre-fetched bundle, decides auto-confirm
#           vs ask with NO model call. A forked `claude -p --model sonnet
#           --effort low` classifier remains only as a kill-switch fallback
#           (.location-local-off).
#        c. Precheck "ask" / resolver "ask" / any failure → fall through to the
#           original direct path: local-Gemma phrase + jori-send.
#   5. Anti-spam: each (date, round centroid) only fires once per day.
#
# 2026-04-25: introduced as the live confirmation system.
# 2026-05-11: added the hybrid precheck + Sonnet-resolve path so calendar /
#             conversation / memory context can resolve the dwell before we
#             interrupt the user. See agent/ops-agent/jobs/
#             location-confirm-ask.md for the system reference. Sonnet (not
#             the Opus ops-agent) by design — this is a classify-from-bundle
#             task, the canonical use case for the inline subagent pattern.

export PATH="/opt/homebrew/bin:$PATH"
source "$(dirname "$0")/lib/root.sh"       # JORI_INSTALL_TOOLS, JORI_NODE
source "$(dirname "$0")/lib/instance.sh"   # JORI_TZ (the home zone)

REPO="$JORI_INSTALL_TOOLS"
TOOL="$REPO/bin/location-current-stop"
PENDING_FILE="$REPO/data/location-confirm-pending.json"
RECENT_FILE="$REPO/data/location-confirm-recent.json"
LOGFILE="$REPO/agent/logs/watchdog.log"
USER_TZ_FILE="$REPO/data/user-timezone.json"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [location-confirm] $1" >> "$LOGFILE"; }

# --- Prune stale pending + recent asks (pending >6h, recent >24h). Cheap;
# also guarantees recent.json exists for the chat-agent reply rule.
"$REPO/bin/location-confirm" prune >/dev/null 2>&1 || true

# --- TZ ---
USER_TZ="${JORI_TZ:-UTC}"
if [ -f "$USER_TZ_FILE" ]; then
  PARSED_TZ=$(jq -r '.timezone // empty' "$USER_TZ_FILE" 2>/dev/null)
  [ -n "$PARSED_TZ" ] && USER_TZ="$PARSED_TZ"
fi

HOUR_LOCAL=$(TZ="$USER_TZ" date +%H)

# --- Quiet-window detection (returns 0 if QUIET, 1 if open) ---
in_quiet_window() {
  # Sleep window 00-08 local
  if [ "$HOUR_LOCAL" -lt 9 ]; then
    log "quiet:sleep_window hour=$HOUR_LOCAL"
    return 0
  fi
  # Active calendar event (busy)
  GOG="${GOG_BIN:-$(command -v gog || echo /opt/homebrew/bin/gog)}"
  if [ -x "$GOG" ]; then
    NOW_ISO=$(TZ="$USER_TZ" date -Iseconds)
    FOUR_AGO=$(TZ="$USER_TZ" date -v-4H -Iseconds)
    BUSY=$("$GOG" calendar list --json --results-only --from "$FOUR_AGO" --to "$NOW_ISO" --all 2>/dev/null | \
      jq -r --arg now "$NOW_ISO" \
        '[.[] | select(.start.dateTime != null and .end.dateTime != null and .end.dateTime > $now and (.transparency // "opaque") != "transparent")] | length' 2>/dev/null)
    if [ "${BUSY:-0}" -gt 0 ]; then
      log "quiet:in_meeting count=$BUSY"
      return 0
    fi
  fi
  return 1
}

# --- Detect current dwell ---
DETECTOR_OUT=$("$TOOL" 2>/dev/null) || { log "detector_failed"; exit 0; }
IS_STOP=$(echo "$DETECTOR_OUT" | jq -r '.is_stop // false')
NEEDS=$(echo "$DETECTOR_OUT" | jq -r '.needs_confirm // false')
SKIP=$(echo "$DETECTOR_OUT" | jq -r '.skip_reason // ""')

if [ "$IS_STOP" != "true" ]; then
  log "skip:not_a_stop"
  exit 0
fi
if [ "$NEEDS" != "true" ]; then
  log "skip:$SKIP"
  exit 0
fi

# --- Anti-spam: build a stable ask_id from date + rounded centroid ---
DATE_LOCAL=$(TZ="$USER_TZ" date +%Y%m%d)
TIME_LOCAL=$(TZ="$USER_TZ" date +%H%M)
LAT_R=$(echo "$DETECTOR_OUT" | jq -r '.centroid.lat | (. * 1000 | floor / 1000)')
LON_R=$(echo "$DETECTOR_OUT" | jq -r '.centroid.lon | (. * 1000 | floor / 1000)')
ASK_ID="lc-${DATE_LOCAL}-${TIME_LOCAL}-${LAT_R}-${LON_R}"
ASK_KEY="${DATE_LOCAL}-${LAT_R}-${LON_R}"

# Has this (date, centroid) already been asked today?
if [ -f "$RECENT_FILE" ]; then
  ALREADY=$(jq --arg k "$ASK_KEY" '[.[] | select(.ask_key == $k)] | length' "$RECENT_FILE" 2>/dev/null)
  if [ "${ALREADY:-0}" -gt 0 ]; then
    log "skip:already_asked_today key=$ASK_KEY"
    exit 0
  fi
fi

# Build the ask object (detector output + ask_id)
ASK_JSON=$(echo "$DETECTOR_OUT" | jq --arg id "$ASK_ID" --arg key "$ASK_KEY" \
  '. + {ask_id: $id, ask_key: $key}')

# Record this ask in recent.json IMMEDIATELY (before any send attempt) so the
# chat-agent's reply rule can match incoming venue replies even if delivery
# fails or the ask was queued during a quiet window. Dedupe by ask_id, keep
# last 200; prune cron above already drops anything older than 24h.
python3 - "$RECENT_FILE" "$ASK_JSON" <<'PY'
import json, os, sys
path, new = sys.argv[1], json.loads(sys.argv[2])
existing = []
if os.path.exists(path):
    try: existing = json.load(open(path))
    except Exception: existing = []
existing = [e for e in existing if e.get("ask_id") != new.get("ask_id")]
existing.append(new)
existing = existing[-200:]
tmp = path + ".tmp"
json.dump(existing, open(tmp, "w"), indent=2)
os.replace(tmp, path)
PY

# --- Quiet-window: defer dispatch ---
if in_quiet_window; then
  # Append to pending; drain on the next non-quiet tick.
  python3 - "$PENDING_FILE" "$ASK_JSON" <<'PY'
import json, os, sys
path = sys.argv[1]
new_entry = json.loads(sys.argv[2])
existing = []
if os.path.exists(path):
    try: existing = json.load(open(path))
    except Exception: existing = []
# dedupe by ask_key
existing = [e for e in existing if e.get("ask_key") != new_entry.get("ask_key")]
existing.append(new_entry)
tmp = path + ".tmp"
json.dump(existing, open(tmp, "w"), indent=2)
os.replace(tmp, path)
PY
  log "deferred:queued ask_id=$ASK_ID (quiet window)"
  exit 0
fi

# --- Out of quiet: drain pending + send current ---
DRAIN_JSON="[]"
if [ -f "$PENDING_FILE" ]; then
  DRAIN_JSON=$(cat "$PENDING_FILE")
  echo "[]" > "$PENDING_FILE"
  # Too late to ask (2026-10-06): a dwell queued overnight or behind a long
  # meeting is not asked about hours later as though the user were still there.
  # Same bound as every other ask path — askTiming in
  # lib/location-ask-queue.mjs (> 4h since the user left, or an earlier local
  # day → dropped; the daily summary's Corrections block carries it instead).
  # Fail-open: a broken filter keeps the backlog as it was.
  FILTERED=$(printf '%s' "$DRAIN_JSON" | "$JORI_NODE" "$REPO/bin/location-ask-queue" timing-filter --tz "$USER_TZ" 2>>"$LOGFILE")
  if [ -n "$FILTERED" ] && echo "$FILTERED" | jq -e 'type == "array"' >/dev/null 2>&1; then
    DRAIN_JSON="$FILTERED"
  fi
fi

# Combine pending + current into one batch (each entry sent as its own message
# so each gets its own natural-language phrasing).
BATCH=$(jq -n --argjson pending "$DRAIN_JSON" --argjson current "$ASK_JSON" \
  '$pending + [$current]')
N_BATCH=$(echo "$BATCH" | jq length)

# Hybrid resolution per ask:
#   1. Programmatic precheck (calendar overlap) → auto-confirm without asking.
#   2. Sonnet resolve (one-shot `claude -p --model sonnet --effort low`
#      subprocess) — fetches calendar + recent conversation + wiki, asks
#      Sonnet to classify, auto-confirms or falls through.
#   3. Direct path → local-Gemma phrase + jori-send (the original zero-token
#      flow, used when context is silent or the resolve step is unavailable).
# Sonnet (not Opus) by design — this is a classify-from-bundle task, the
# canonical `--model sonnet --effort low` use case per CLAUDE.md § Effort
# Policy. NO ops-agent webhook dispatch.
# See agent/ops-agent/jobs/location-confirm-ask.md for the full mental
# model.
PRECHECK="$REPO/bin/location-confirm-precheck.mjs"
RESOLVE="$REPO/bin/location-confirm-resolve.mjs"
PHRASER="$REPO/bin/location-confirm-phrase.mjs"
SENDER="$REPO/bin/jori-send.mjs"
CONFIRM_TOOL="$REPO/bin/location-confirm"

ANY_FAIL=0
SENT=0
UNDELIVERED=0
LAST_ERR=""
for i in $(seq 0 $((N_BATCH - 1))); do
  ASK=$(echo "$BATCH" | jq ".[$i]")
  ASK_ID_THIS=$(echo "$ASK" | jq -r '.ask_id')

  # --- Step 1: programmatic precheck (calendar overlap) ---
  PRECHECK_OUT=$(echo "$ASK" | "$JORI_NODE" "$PRECHECK" 2>>"$LOGFILE")
  DECISION=$(echo "$PRECHECK_OUT" | jq -r '.decision // "ask"' 2>/dev/null)
  VENUE=$(echo "$PRECHECK_OUT" | jq -r '.venue // ""' 2>/dev/null)
  REASON=$(echo "$PRECHECK_OUT" | jq -r '.reasoning // ""' 2>/dev/null)

  if [ "$DECISION" = "auto_confirm" ] && [ -n "$VENUE" ]; then
    if "$CONFIRM_TOOL" save "$ASK_ID_THIS" "$VENUE" >/dev/null 2>&1; then
      log "auto_confirm:precheck ask_id=$ASK_ID_THIS venue=\"$VENUE\" reason=$REASON"
      continue
    fi
    log "auto_confirm_save_failed:precheck ask_id=$ASK_ID_THIS venue=\"$VENUE\" — falling through"
    DECISION="ask"
  fi

  # --- Step 2: Sonnet resolve when precheck escalates ---
  if [ "$DECISION" = "escalate" ]; then
    RESOLVE_OUT=$(echo "$ASK" | "$JORI_NODE" "$RESOLVE" 2>>"$LOGFILE")
    R_DECISION=$(echo "$RESOLVE_OUT" | jq -r '.decision // "ask"' 2>/dev/null)
    R_VENUE=$(echo "$RESOLVE_OUT" | jq -r '.venue // ""' 2>/dev/null)
    R_REASON=$(echo "$RESOLVE_OUT" | jq -r '.reasoning // ""' 2>/dev/null)

    if [ "$R_DECISION" = "auto_confirm" ] && [ -n "$R_VENUE" ]; then
      if "$CONFIRM_TOOL" save "$ASK_ID_THIS" "$R_VENUE" >/dev/null 2>&1; then
        log "auto_confirm:sonnet ask_id=$ASK_ID_THIS venue=\"$R_VENUE\" reason=$R_REASON"
        continue
      fi
      log "auto_confirm_save_failed:sonnet ask_id=$ASK_ID_THIS venue=\"$R_VENUE\" — falling through"
    else
      log "sonnet:ask ask_id=$ASK_ID_THIS reason=$R_REASON"
    fi
    # fall through to direct phrase + send
  fi

  # --- Step 3: direct phrase + send (existing zero-token path) ---
  MSG=$(echo "$ASK" | "$PHRASER" 2>>"$LOGFILE")
  if [ -z "$MSG" ]; then
    log "phrasing_failed ask_id=$ASK_ID_THIS — skipping send"
    ANY_FAIL=1
    UNDELIVERED=$((UNDELIVERED + 1))
    LAST_ERR="phrasing_failed"
    continue
  fi

  # --- Queue, don't send (2026-08-04) ---
  #
  # This was a direct `jori-send.mjs` call: phrase it with local Gemma, push
  # it, done — the second of two independent paths that could put a location
  # question on the user's phone without either one knowing about the other.
  # Between them they shipped 46 asks in seven days (~2/3 unanswered) while the
  # `nearby` value lane published zero times, and they asked about the same
  # stop twice inside an hour with the user's answer sitting in chat in between.
  #
  # Both paths now feed one queue and compete for one slot in hum's ranker.
  # The phrasing above is unchanged and still zero-token; only the delivery
  # decision moved. See lib/location-ask-queue.mjs.
  if "$REPO/bin/location-ask-queue" add --visit "$ASK_ID_THIS" --score 0.5 --message "$MSG" >/dev/null 2>&1; then
    SENT=$((SENT + 1))
    log "queued ask_id=$ASK_ID_THIS chars=${#MSG}"
  else
    log "queue_failed ask_id=$ASK_ID_THIS"
    ANY_FAIL=1
    UNDELIVERED=$((UNDELIVERED + 1))
    LAST_ERR="queue_failed"
  fi
done

# --- Delivery health ---
# Record whether this tick actually got an ask onto the user's phone. Until now the
# only trace of a failed send was a `jori-send_failed` line in watchdog.log and
# a non-zero exit into cron's void — so when jori-send.mjs was rejected by RLS
# on every single call (it carried the anon key; fixed 2026-08-04), the pipeline
# re-queued and retried for over two weeks, ~89 asks, and nothing ever said so.
# From the outside a dead ask channel and a user who simply isn't answering look
# identical. This file is what makes them distinguishable; watchdog.sh reads it and
# pages once the streak is real. Written on EVERY delivering tick — success resets
# the streak, which is what keeps a stale failure from paging forever.
if [ "$SENT" -gt 0 ] || [ "$UNDELIVERED" -gt 0 ]; then
  python3 - "$REPO/data/location-confirm-send-health.json" "$SENT" "$UNDELIVERED" "$LAST_ERR" 2>>"$LOGFILE" <<'PY'
import json, os, sys, time
from datetime import datetime, timezone
path, sent, undelivered, last_err = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]

# This is a read-modify-write and there is no lock around the cron job, so two
# overlapping ticks could otherwise interleave and lose an increment. Guard with
# an O_EXCL lock (stale after 60s). If the lock can't be taken, skip the update
# rather than racing — one missing data point delays detection by one tick, which
# is strictly better than corrupting the streak the watchdog alerts on.
lock = path + ".lock"
fd = None
for _ in range(5):
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY); break
    except FileExistsError:
        try:
            if time.time() - os.path.getmtime(lock) > 60: os.unlink(lock); continue
        except OSError: pass
        time.sleep(0.2)
if fd is None:
    # Say so. This whole change exists because a failure was swallowed silently;
    # swallowing its own is not an option. stderr is appended to watchdog.log.
    print("[location-confirm] send-health update skipped: lock busy", file=sys.stderr)
    sys.exit(0)

try:
    state = {}
    if os.path.exists(path):
        try: state = json.load(open(path))
        except Exception: state = {}
    now = datetime.now(timezone.utc).isoformat()
    if sent > 0:
        # A delivery landed, so the channel is alive: this is the ONLY thing that
        # clears the incident on the watchdog side. A partially-failing batch is
        # not a dead channel, and its per-ask failures are already in watchdog.log.
        state.update({
            "consecutive_failed_ticks": 0,
            "undelivered_since_last_success": 0,
            "last_success_at": now,
            "last_error": None,
        })
    else:
        state.update({
            "consecutive_failed_ticks": int(state.get("consecutive_failed_ticks") or 0) + 1,
            "undelivered_since_last_success": int(state.get("undelivered_since_last_success") or 0) + undelivered,
            "last_failure_at": now,
            "last_error": last_err or "unknown",
        })
    tmp = path + ".tmp"
    json.dump(state, open(tmp, "w"), indent=2)
    os.replace(tmp, path)
finally:
    os.close(fd)
    try: os.unlink(lock)
    except OSError: pass
PY
fi

if [ "$SENT" -gt 0 ]; then
  # Anti-spam: record everything we just sent in the recent-asks store so today's
  # next tick doesn't re-fire for the same dwell.
  python3 - "$RECENT_FILE" "$BATCH" <<'PY'
import json, os, sys
path = sys.argv[1]
batch = json.loads(sys.argv[2])
existing = []
if os.path.exists(path):
    try: existing = json.load(open(path))
    except Exception: existing = []
existing.extend(batch)
existing = existing[-100:]
tmp = path + ".tmp"
json.dump(existing, open(tmp, "w"), indent=2)
os.replace(tmp, path)
PY
fi

if [ "$ANY_FAIL" -ne 0 ] && [ "$SENT" -eq 0 ]; then
  # All sends failed — re-queue the batch so the next tick retries.
  echo "$BATCH" > "$PENDING_FILE"
  exit 1
fi

exit 0
