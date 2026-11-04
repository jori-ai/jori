#!/usr/bin/env bash
set -uo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPTS/lib/webhook-auth.sh"
source "$SCRIPTS/lib/root.sh"
source "$SCRIPTS/lib/instance.sh"

export PATH="/opt/homebrew/bin:$PATH"
ROOT="$JORI_INSTALL_TOOLS"
DATA="$ROOT/data"

# Location Ambient — trigger script
# Pre-dispatch gates: sleep window, pause file, lock file, then the dispatch gate
# (cool-downs + daily cap + "is the user at a fresh stop").
#
# Dispatch tier: routes to the supervisor named in job-routing.json
# for `location-ambient` (= haiku → ops-haiku :9072, degrade-upward
# haiku→sonnet→opus via dispatch_or_skip). This lane was the single biggest Opus
# cost line (~$41/day on Opus at 30-min cadence) despite being classified haiku;
# the trigger had hardcoded :9092 (Opus) and bypassed tier routing. Cadence was
# also halved 30→60 min in crontab the same day.

LOG="$DATA/logs/location-ambient.log"
log() { mkdir -p "$(dirname "$LOG")" 2>/dev/null; echo "$(date '+%Y-%m-%d %H:%M:%S') [location-ambient] $1" >> "$LOG"; }

# 1. Sleep window check — abort if in the user's sleep hours (01:00–08:00 LOCAL).
# Resolve the user's current tz (phone-reported → user-timezone.json, home-zone
# fallback) so this gate follows the user when travelling. Mirrors
# trigger-hum.sh / trigger-location-enrich.sh. Base-10 normalize to avoid octal
# parse of "08"/"09".
USER_TZ_FILE="$DATA/user-timezone.json"
USER_TZ="${JORI_TZ:-UTC}"
if [[ -f "$USER_TZ_FILE" ]]; then
  PARSED_TZ=$(jq -r '.timezone // empty' "$USER_TZ_FILE" 2>/dev/null)
  if [[ -n "$PARSED_TZ" ]] && TZ="$PARSED_TZ" date +%H >/dev/null 2>&1; then
    USER_TZ="$PARSED_TZ"
  fi
fi
HOUR=$((10#$(TZ="$USER_TZ" date +%H)))
if (( HOUR >= 1 && HOUR < 8 )); then
  exit 0
fi

# 2. Pause file check — abort if paused
if [[ -f "$DATA/location-ambient-pause.json" ]]; then
  log "paused (location-ambient-pause.json) — skip dispatch"
  exit 0
fi

# 3. Lock file check — abort if another pulse job is running
if [[ -f "$DATA/pulse.lock" ]]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$DATA/pulse.lock" 2>/dev/null || echo 0) ))
  if (( LOCK_AGE < 300 )); then
    log "pulse.lock held (${LOCK_AGE}s) — skip dispatch"
    exit 0
  fi
fi

# ── Dispatch gate ─────────────────────────────────────────────────────────────
# Only wake the agent on a tick that could actually SPEAK. Measured over 46
# days of full event coverage: 1,534 ambient dispatches
# produced SIX real pings — 0.4%. The other 1,528 woke a Haiku session, ran the
# deterministic Step-1 check, found "at_home_no_fresh_stop", and exited. That is
# $32.68 model-weighted over 30 days (1,016 runs, $0.032/run, 3.1 turns each) to
# re-derive a boolean the trigger can compute for free.
#
# This gate mirrors the playbook's Preflight 3/4/5 + Step 1a/1b EXACTLY
# (jobs/location-ambient.md) and mirrors nothing else:
#   P3  a Jori message went out < 20 min ago            → skip
#   P4  ping-budget check: 6/day or <45 min since last ping → skip
#       (hum-state.json live counter + hum-feedback ledger)
#   P5  location-ambient-last.json cooldown_until in future → skip
#   1a  newest location_history row is an OPEN VISIT, or a "stationary" fix
#       less than 10 min old — the user must be stopped RIGHT NOW  → else skip
#   1b  arrived_at within the last 20 min — the stop must be FRESH → else skip
#
# Step 1c (wandering-vs-transit, the routine walk at home) moved here too — see
# the location-ambient-geom block below. Per Rule #0b: code owns the geometry
# (is the user stopped, how long ago, did the user wander, how many pings
# today), the model owns the language (which place, whether it is worth saying).
#
# FAIL-OPEN, deliberately: any error, timeout, malformed JSON or missing file
# falls through and dispatches. A wrongly-sent tick costs $0.03; a wrongly-held
# one costs a rec the user would have wanted, silently.
#
# LIVENESS: the dispatch count used to be this lane's liveness control — prior
# cost reviews read "location-ambient dispatched 34 of 48" as proof the cron,
# the supervisor and the wider location pipeline were all alive while diagnosing
# location-enrich's zero-run days. After this gate the dispatch count is ~1-3/day,
# so that control MOVES HERE: every tick writes one line to
# data/logs/location-ambient.log with its reason. Grep this file, not the
# ledger, to ask whether the lane is running.
#
# NAME THE CAUSE, do not just say "no". trigger-location-enrich.sh learned this
# the hard way: a blocked Places budget made its gate log "no
# askable stop" 288 times over three days while the largest job on the ledger sat
# dark. Each branch below says which condition fired.
#
# Kill switch: touch data/.location-ambient-gate-off
AMBIENT_GATE_OFF="$DATA/.location-ambient-gate-off"
if [[ ! -f "$AMBIENT_GATE_OFF" ]]; then
  TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
  ACTIVITY=""
  FINDME="$ROOT/bin/findme"
  if [[ ! -x "$FINDME" ]]; then
    : # no location module installed: activity unavailable, the gate fails open
  elif [[ -n "$TIMEOUT_BIN" ]]; then
    ACTIVITY=$("$TIMEOUT_BIN" 15 "$FINDME" activity --json 2>/dev/null)
  else
    ACTIVITY=$("$FINDME" activity --json 2>/dev/null)
  fi

  GATE=$(ACTIVITY_JSON="$ACTIVITY" JORI_LA_DATA="$DATA/" JORI_LA_BIN="$ROOT/bin/" node -e '
    // Node 25 no longer wraps `-e` source in a CommonJS function, so a top-level
    // `return` is a SyntaxError. The verdict logic lives in a function for that
    // reason -- do not flatten it back out.
    const fs = require("fs");
    const D = process.env.JORI_LA_DATA;
    const now = Date.now();
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(D + p, "utf8")); } catch { return null; } };
    const ms = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
    function verdict() {
      // P3 -- a Jori message went out < 20 min ago.
      const lastMsg = ms((readJson("last-jori-message-at.json") || {}).ts);
      if (lastMsg !== null && now - lastMsg < 20 * 60 * 1000) {
        return "skip:message-cooldown (last send " + Math.round((now - lastMsg) / 60000) + "m ago, floor 20m)";
      }
      // P4 -- the shared daily ping budget (6/day, 45 min apart), read from
      // the live counter in hum-state.json + the hum-feedback ledger via
      // bin/ping-budget (logic: lib/ping-budget.mjs). This once read
      // pulse-state.json, which nothing wrote any more and so always said 0 --
      // the gate could never fire. Exit 1 = over budget; any other failure
      // falls through (fail open).
      const pb = require("child_process").spawnSync(process.env.JORI_LA_BIN + "ping-budget", ["check", "--json"], { encoding: "utf8", timeout: 10000 });
      if (pb.status === 1) {
        let b = {}; try { b = JSON.parse(pb.stdout); } catch {}
        return "skip:ping-budget (" + (b.gate || "over") + ": " + (b.detail || "budget spent") + ")";
      }
      // P5 -- this walking session already spoke.
      const cooldown = ms((readJson("location-ambient-last.json") || {}).cooldown_until);
      if (cooldown !== null && cooldown > now) {
        return "skip:session-cooldown (until " + new Date(cooldown).toISOString() + ")";
      }
      // 1a/1b -- the user must be STOPPED right now, and the stop must be FRESH.
      const raw = process.env.ACTIVITY_JSON || "";
      if (!raw.trim()) return "dispatch:activity-unavailable (findme returned nothing - fail open)";
      const a = JSON.parse(raw);
      const openVisit = a.segment_type === "visit" && !a.departed_at;
      const createdMs = ms(a.created_at) !== null ? ms(a.created_at) : ms(a.arrived_at);
      const freshStationary = a.activity === "stationary" && createdMs !== null && now - createdMs < 10 * 60 * 1000;
      if (!openVisit && !freshStationary) {
        return "skip:not-stopped (segment_type=" + a.segment_type + " activity=" + a.activity + " departed_at=" + (a.departed_at || "null") + ")";
      }
      const arrived = ms(a.arrived_at);
      if (arrived === null) return "dispatch:no-arrived-at (fail open)";
      const ageMin = Math.round((now - arrived) / 60000);
      if (ageMin > 20) {
        return "skip:stop-not-fresh (arrived " + ageMin + "m ago, window 20m - settled, location-enrich territory)";
      }
      return "dispatch:fresh-stop (arrived " + ageMin + "m ago at " + (a.place_name || a.neighborhood || "unnamed") + ")";
    }
    try { process.stdout.write(verdict()); }
    catch (e) { process.stdout.write("dispatch:gate-error " + (e && e.message ? e.message : "unknown") + " (fail open)"); }
  ' 2>/dev/null)

  if [[ -z "$GATE" ]]; then
    log "gate produced no verdict — fail open, dispatching"
  elif [[ "$GATE" == skip:* ]]; then
    log "${GATE#skip:} — skip dispatch (gate)"
    exit 0
  else
    log "${GATE#dispatch:} — passed stop gate"
  fi

  # Step 1c in code: routine-walk-at-home, then wandering-vs-transit
  # over the 40 min of fixes before the stop (lib/ambient-geometry.mjs).
  # Only on a fresh-stop verdict — the fail-open branches above have no stop to
  # measure from. The verdict is written to location-ambient-geom.json so the
  # agent reads the classification instead of recomputing it. Fail-open.
  GEOM_FILE="$DATA/location-ambient-geom.json"
  rm -f "$GEOM_FILE"
  if [[ "$GATE" == dispatch:fresh-stop* ]]; then
    read -r S_LAT S_LON S_ARR < <(ACTIVITY_JSON="$ACTIVITY" node -e 'try{const a=JSON.parse(process.env.ACTIVITY_JSON);console.log(a.latitude,a.longitude,a.arrived_at)}catch{console.log("x x x")}' 2>/dev/null)
    GEOM=$("$ROOT/bin/location-ambient-geom" wander --lat "$S_LAT" --lon "$S_LON" --arrived "$S_ARR" 2>/dev/null)
    [[ -n "$GEOM" ]] && echo "$GEOM" > "$GEOM_FILE"
    GVERDICT=$(echo "$GEOM" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const g=JSON.parse(d);console.log(g.verdict+":"+g.reason)}catch{console.log("dispatch:geom-unparseable (fail open)")}})' 2>/dev/null)
    if [[ "$GVERDICT" == skip:* ]]; then
      log "${GVERDICT#skip:} — skip dispatch (step 1c gate)"
      exit 0
    fi
    log "step 1c: ${GVERDICT#dispatch:} — dispatching"
  fi
fi

# 4. Dispatch to the job's tier supervisor (haiku), degrade-upward on unhealthy.
dispatch_or_skip '{"task": "LOCATION AMBIENT", "source": "cron-location-ambient"}' location-ambient || true
