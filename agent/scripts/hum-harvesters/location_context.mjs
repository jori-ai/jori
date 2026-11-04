#!/usr/bin/env node
// location_context — notice an IN-PROGRESS walk, form an educated guess
// from calendar + habits + nearby places, emit a yes/no question.
//
// Fires on walks that started in the last 15 min and are still ongoing,
// so Jori catches the user in the moment ("Out with <companion> for a
// morning walk?" AS the user is leaving, not after). Retrospective fallback
// kicks in only for walks that ended in the last 20 min and were never asked
// about.
//
// Example questions:
//   "Taking <companion> for a walk?" (morning/evening, short loop near home;
//     the routine walk of agent/local/config/routine-walk.json — none
//     configured, no such guess)
//   "Headed to <calendar event>?" (calendar event at matching time/place)
//
// Chat-agent reads supporting_data.annotate_hint on a YES reply and calls
// location_annotate with the pre-filled companion/note.
//
// Config — agent/local/config/location-context.json (optional):
//   generic_place_names  geocoder names too generic to count as a settled
//                        place (district / borough / city names the phone's
//                        reverse geocoder returns for many POIs)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, emitNoop, stampRun, insideCadence, GOG_ACCOUNT, HOME_TZ, localConfig } from "./_common.mjs";
import { peek as peekAsk, drop as dropAsk, askTiming, timedMessage } from "../../../lib/location-ask-queue.mjs";
import { stashMedia, recallMedia } from "../../../lib/ping-media.mjs";
import { isDriftStop, alreadyAnswered, readLearnings } from "../../../lib/location-ask-filter.mjs";
import { homes as walkHomes, routineWalkConfig } from "../../../lib/ambient-geometry.mjs";

const require = createRequire(import.meta.url);
const { installRoot, installTools } = require("../../../lib/root.cjs");
const { supabaseUrl } = require("../../../lib/instance.cjs");

const { situation: sit, moment } = await readStdinJson(); void sit;
const TOPIC = "location_context";
const BIN = installTools("bin");
const STOP_MAP = path.join(BIN, "stop-map");
// gog: $GOG_BIN, else a package-manager install (launchd's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => fs.existsSync(p)) || "gog";
const CAL_CMD = `${GOG} calendar list${GOG_ACCOUNT ? ` --account ${GOG_ACCOUNT}` : ""} --days 1 --max 40 --json 2>/dev/null`;
// The phone's self-reported zone (data/user-timezone.json), if fresh.
const USER_TZ_FILE = installTools("data", "user-timezone.json");
function readUserTz() {
  try { return JSON.parse(fs.readFileSync(USER_TZ_FILE, "utf8")); } catch { return null; }
}

// The cadence gate below throttles THIS harvester's own GPS-shape guesses
// (walks, edges). It used to run before Step 0 as well, so a composed ask that
// woke hum through the priority lane could still be told "inside cadence" and
// wait another 18 minutes — so the gate sits after Step 0.

// ── Step 0: a composed enrichment ask waiting for a slot ─────────────────
//
// jobs/location-enrich.md builds a real hypothesis about a finished stop
// (calendar + top candidate + movement evidence) and, since 2026-08-04, queues
// it here instead of sending it directly. Offering it as a candidate is the
// whole point: an ask now has to out-rank whatever else hum could say this
// tick, rather than bypassing the contest entirely. See
// lib/location-ask-queue.mjs for the measurements behind that change.
//
// It goes first because it is the more considered question — this harvester's
// own hypotheses below are built from GPS shape alone, with no calendar pass.
// Mirrors bin/findme:1635-1645 — the enrich side's definition of a stop
// that no longer needs asking about. Kept as one predicate so the two paths
// cannot drift apart again.
const SETTLED_PLACE_TYPES = new Set(["named", "user-confirmed", "non-stop"]);
// Apple's on-device geocoder returns generic borough names for many POIs, so a
// `poi` row only counts as settled when its name is genuinely specific.
const GENERIC_PLACE_NAMES = new Set(["", ...(localConfig("location-context", { generic_place_names: [] }).generic_place_names || [])]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSettledPlace(row) {
  if (!row) return false;
  if (SETTLED_PLACE_TYPES.has(row.place_type)) return true;
  const name = String(row.place_name || "").trim();
  return row.place_type === "poi" && !GENERIC_PLACE_NAMES.has(name);
}

{
  let queued = peekAsk();

  // Never ask about a stop that some other path already settled.
  //
  // Two location subsystems write the same truth from different directions:
  // chat-agent's `location_annotate` (when the user says "we had lunch at
  // <restaurant>") patches location_history directly, while the enrich queue
  // sits on its own timer. They did not check each other, so the same stop
  // could be asked about twice — confirmed live, when Jori asked about a
  // restaurant at 12:30, the user answered at 12:52, and it asked about the
  // same restaurant again at 13:16. The 90-minute outbound-precheck saw both
  // and let the re-ask through.
  //
  // This is the bidirectional fix, moved out of chat-agent prose and into the
  // one chokepoint every ask now passes through. For weeks the check had never
  // once suppressed anything, for three separate reasons found together.
  //
  // (1) It selected a column that does not exist. location_history has `notes`,
  //     not `note`, so PostgREST answered 400 / 42703 on EVERY call.
  // (2) shFetch JSON.parses that error body and returns an OBJECT, so
  //     `Array.isArray(rows)` was false, `row` was null, `settled` was falsy —
  //     and the loop broke, emitting the ask. Failing silently OPEN is why six
  //     weeks of this were invisible: a check that never runs and a check that
  //     finds nothing settled look identical from the outside.
  // (3) The predicate itself was too broad to keep even after fixing (1) and
  //     (2). `place_name` is populated by reverse geocoding for essentially
  //     every row, so `row.place_name` would have suppressed the asks most
  //     worth making — live right now, two queued asks sit on rows whose
  //     place_name is a bare street address ("<number> <street>", place_type
  //     "address"), which is precisely the not-knowing the ask exists to fix.
  //     `notes` is no better: the departed_at sweeper writes machine prose
  //     there ("[sweeper] departed_at synthesized from segment ...").
  //
  // So the predicate is now the one bin/findme:1635 already uses to
  // decide the same question on the enrich side — place_type alone, plus the
  // specific-POI case at findme:1641. Two paths, one definition of "settled".
  // The user's timezone for the late-ask lead and the same-day test (LOCAL_TZ
  // further down is a TDZ here; read the same file).
  const askTz = readUserTz()?.timezone || "UTC";
  let timing = null;
  const learnings = readLearnings();
  while (queued) {
    // Geometry/clock/id gates (hum-i-20261018-03), all fail-open on missing
    // fields: a tiny, short cluster is GPS drift, not a stop; and a stop whose
    // id (or explicit window) already has an answered location_ask is settled.
    // The pending row stays asked:false for the daily summary, as with a "drop".
    if (isDriftStop(queued) || alreadyAnswered(queued, learnings)) {
      process.stderr.write(`[location_context] not asking ${queued.visit_id}: drift stop or already answered\n`);
      dropAsk(queued.visit_id);
      queued = peekAsk();
      continue;
    }
    // Too old to interrupt the user about (askTiming in the queue lib: > 4h
    // since the user LEFT, or an earlier local day). Not asked, not lost: the pending row stays
    // asked:false and the next daily summary's Corrections block carries it.
    timing = askTiming(queued, { tz: askTz });
    if (timing.verdict === "drop") {
      process.stderr.write(`[location_context] not asking ${queued.visit_id}: ${timing.reason} — left for the daily summary\n`);
      dropAsk(queued.visit_id);
      queued = peekAsk();
      continue;
    }
    // The location-confirm flow queues synthetic ids ("lc-<date>-<time>-...");
    // location_history.id is a uuid, so asking about one is a guaranteed 400
    // (22P02). There is no row to consult, so leave the ask standing.
    if (!UUID_RE.test(queued.visit_id)) break;
    const rows = shFetch("/rest/v1/location_history", new URLSearchParams({
      "id": `eq.${queued.visit_id}`,
      "select": "id,place_name,place_type",
      "limit": "1",
    }).toString());
    if (!Array.isArray(rows)) {
      // Still fail open — an unanswerable question is better than a silently
      // dropped one — but never again in silence.
      process.stderr.write(
        `[location_context] settled-check could not read location_history for ${queued.visit_id}: ` +
        `${JSON.stringify(rows).slice(0, 200)}\n`
      );
      break;
    }
    const row = rows[0];
    const settled = row && isSettledPlace(row);
    if (!settled) break;
    // Someone answered it. Drop it and see whether anything else is waiting.
    dropAsk(queued.visit_id);
    queued = peekAsk();
  }

  if (queued) {
    stampRun(TOPIC, true);
    const waitedMin = Math.round((Date.now() - Date.parse(queued.composed_at)) / 60000);
    // Deliberately modest for the first 45 min. A retrospective confirmation
    // is worth less than anything that tells the user something not already
    // known — the user was there; the information gap is Jori's, not the
    // user's. The ranker's RETROSPECTIVE-ASK rule (jobs/hum.md Step 3a) makes it
    // lose every tie on top of this cap, so early on it only ships when
    // nothing else is close.
    //
    // SLA ceiling: that combination has no upper bound on how long a stop can
    // wait, which is fine on a quiet day and silently wrong on a busy one — a
    // 59-min stop took ~2.5h to reach the user while hum kept picking
    // nearby/dining/ideation candidates instead. Location questions must be
    // floated while the user is there or shortly after, not hours after the
    // fact. Once a question
    // has waited past 45 min unanswered, it has already lost its "shortly
    // after" window regardless of score, so the handicap lifts — jobs/hum.md's
    // tie-loss rule is scoped to `freshness_min < 45` and the cap here rises
    // with it, so a genuinely stale ask can finally outcompete routine
    // low-value noise instead of losing to it indefinitely. This does not
    // reopen the old problem (46/week, 2/3 unanswered) because the
    // cap only lifts after a real wait, not on every tick — most of these
    // still resolve within the first few ticks at the original modest score.
    const SLA_MIN = 45;
    const stale = waitedMin >= SLA_MIN;
    const baseScore = Number(queued.score_hint) || 0.5;
    // PRIORITY LANE. When this tick was woken FOR this ask — the
    // compose step spooled a `location.ask_ready` event naming this visit (see
    // askReadyEvent in lib/location-enrich-compose.mjs) — the whole point
    // of the turn is to ship it while the user can still answer from memory. Marked
    // so jobs/hum.md rule 3a lets it win instead of losing a tie to a factoid,
    // and scored to clear the 0.45 bar on its own. An ask offered on any OTHER
    // tick keeps the modest treatment below.
    const priorityLane = (moment?.events || []).some((e) =>
      e?.type === "location.ask_ready" && String(e?.data?.visit_id || "") === String(queued.visit_id));
    const urgency = priorityLane
      ? 0.8
      : stale ? Math.min(0.75, Math.max(baseScore, 0.6)) : Math.min(0.6, baseScore);
    // A map of the stop rides with the question (stop-map: trace in, the stop,
    // trace out), so it is easy to see what the question is truly about.
    // Rendered once per visit — the stash is the
    // cache — and optional: a failed render asks without the picture.
    const askKey = `location_ask:${queued.visit_id}`;
    if (!recallMedia(askKey)) {
      // The card (client ChoicePrompt § subject): a PLACE, with the stop's own
      // window, its map, and the question. No buttons — these asks carry their
      // candidates in the sentence and the user answers by typing,
      // exactly as before; the card only makes plain what is being asked.
      let row = null;
      if (UUID_RE.test(queued.visit_id)) {
        const r = shFetch("/rest/v1/location_history", new URLSearchParams({
          "id": `eq.${queued.visit_id}`, "select": "arrived_at,departed_at,latitude,longitude", "limit": "1",
        }).toString());
        row = Array.isArray(r) && r[0] ? r[0] : null;
      }
      let mapUrl = null, trace = null;
      if (row && fs.existsSync(STOP_MAP)) {
        try {
          const mj = JSON.parse(execSync(
            `${STOP_MAP} --visit ${queued.visit_id} --tz ${askTz} --upload --json`,
            { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] }));
          if (String(mj.url || "").startsWith("https://")) { mapUrl = mj.url; trace = mj.trace || null; }
        } catch { /* ask without a map */ }
      }
      const start = row?.arrived_at || queued.stop_started_at || null;
      const end = row?.departed_at || queued.stop_ended_at || null;
      const subject = Object.fromEntries(Object.entries({
        kind: "place", start, end, tz: askTz, map_url: mapUrl, path: trace,
        lat: row?.latitude ?? null, lon: row?.longitude ?? null,
      }).filter(([, v]) => v != null));
      const choice = start ? {
        v: 1, id: `ask-${queued.visit_id}`, kind: "location_ask", ref: queued.visit_id,
        prompt: timedMessage(queued, timing), options: [], subject,
      } : null;
      if (mapUrl || choice) stashMedia(askKey, { map_url: mapUrl, choice });
    }
    emit({
      topic: TOPIC,
      // A late ask (> 45 min since the user left) says so, with the time,
      // instead of reading as though the user were still there — askTiming /
      // timedMessage.
      signal: timedMessage(queued, timing),
      urgency,
      freshness_min: waitedMin,
      dedup_key: `location_ask:${queued.visit_id}`,
      supporting_data: {
        ask_kind: "retrospective_confirmation",
        visit_id: queued.visit_id,
        priority_lane: priorityLane,
        ask_timing: timing ? { verdict: timing.verdict, minutes_since_stop: timing.minutes_since_stop } : null,
        composed_at: queued.composed_at,
        // Composed by the enrich job from a visit that had already ended; the
        // freshness gate re-reads this rather than assuming a 14-day-old claim.
        evidence_as_of: queued.composed_at,
      },
      act_fit: { effort_to_act: "quick_win" },
    });
    process.exit(0);
  }
}

// Short cadence so each 20-min hum tick can catch a fresh walk. Applies only to
// the GPS-shape guesses below; a queued ask (Step 0) is never held by it.
if (insideCadence(TOPIC, 18)) {
  emitNoop("inside cadence"); process.exit(0);
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 8000 }); }
  catch (e) { return e.stdout?.toString() || ""; }
}

// The user travels, so "what time was that walk" has to be answered in the
// timezone the user is standing in. Hard-coding the home zone was already
// fixed once in jobs/location-enrich.md (a 12:58Z stop abroad rendered as
// "around 8:58"); this harvester had the identical bug and asked about walks
// at times that never happened locally. Same source of truth (the phone's
// zone, if fresh), same fallback (the home zone).
const LOCAL_TZ = (() => {
  const raw = readUserTz();
  const updated = Date.parse(raw?.updated_at || "");
  const stale = Number.isFinite(updated) && (Date.now() - updated) > 30 * 24 * 3600_000;
  if (raw?.timezone && !stale) return raw.timezone;
  return HOME_TZ;
})();

function hhmm(iso) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: LOCAL_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function localHourOf(iso) {
  return parseInt(new Date(iso).toLocaleTimeString("en-US", {
    timeZone: LOCAL_TZ, hour: "2-digit", hour12: false,
  }), 10);
}

// ── Step 1a: state-transition detection (arrivals/departures) ─────────
// Visits appear in location_history as segment_type=visit. An arrived_at
// within the last ~10 min is a NEW arrival; a departed_at within the last
// ~10 min means the user just left that place. These edges are the best
// moments to ask — the user is about to act on the decision.
import { execSync as _exec } from "node:child_process";
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();
function shFetch(restPath, qs) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || (() => {
    try {
      const env = fs.readFileSync(path.join(installRoot(), ".env"), "utf8");
      const m = env.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m);
      return m ? m[1].trim() : "";
    } catch { return ""; }
  })();
  if (!key || !SUPABASE_URL) return [];
  const url = `${SUPABASE_URL}${restPath}?${qs}`;
  try {
    const raw = _exec(`curl -s -H "apikey: ${key}" -H "Authorization: Bearer ${key}" "${url}"`, { encoding: "utf8", timeout: 6000 });
    return JSON.parse(raw);
  } catch { return []; }
}

// Widened 10→45 min (matching hum-sensors/location.mjs): a visit row's
// arrived_at/departed_at is often only confirmed well after the actual
// moment, and this harvester also only runs on its own 18-min cadence — a
// 10-min lookback routinely missed real arrivals by the time either check
// ran (an arrival never surfaced at all).
const cutoffIso = new Date(Date.now() - 45 * 60 * 1000).toISOString();
const arrivals = shFetch("/rest/v1/location_history", new URLSearchParams({
  "segment_type": "eq.visit",
  "arrived_at": `gte.${cutoffIso}`,
  "order": "arrived_at.desc",
  "limit": "5",
  "select": "id,arrived_at,departed_at,latitude,longitude,place_name,place_type",
}).toString());
const departures = shFetch("/rest/v1/location_history", new URLSearchParams({
  "segment_type": "eq.visit",
  "departed_at": `gte.${cutoffIso}`,
  "order": "departed_at.desc",
  "limit": "5",
  "select": "id,arrived_at,departed_at,latitude,longitude,place_name,place_type",
}).toString());

// ── Step 1b: find an IN-PROGRESS walk (or just-finished unannotated) ───

let track;
try { track = JSON.parse(sh(`${BIN}/location-track --last 30m`)); }
catch { stampRun(TOPIC, false); emitNull("track fetch failed"); process.exit(0); }

const samples = track.samples || [];

const WALK_ACT = new Set(["walking", "running", "cycling"]);
const runs = [];
let cur = null;
for (const s of samples) {
  const kind = WALK_ACT.has(s.activity) ? "walk" : "other";
  if (!cur || cur.kind !== kind) { if (cur) runs.push(cur); cur = { kind, samples: [s] }; }
  else cur.samples.push(s);
}
if (cur) runs.push(cur);

const now = Date.now();
const walks = [];
for (const run of runs) {
  if (run.kind !== "walk" || run.samples.length < 2) continue;
  const first = run.samples[0], last = run.samples[run.samples.length - 1];
  const startedMinAgo = (now - new Date(first.ts).getTime()) / 60000;
  const endedMinAgo = (now - new Date(last.ts).getTime()) / 60000;
  const durationMin = (new Date(last.ts) - new Date(first.ts)) / 60000;
  // Target: walks that started within last 15 min (in-moment) OR ended
  // within the last 20 min and weren't asked yet (near-real-time retro).
  if (startedMinAgo > 15 && endedMinAgo > 20) continue;
  if (durationMin < 2) continue;
  const inProgress = endedMinAgo < 5;
  walks.push({
    first, last,
    durationMin: Math.round(durationMin),
    startedMinAgo: Math.round(startedMinAgo),
    endedMinAgo: Math.round(endedMinAgo),
    inProgress,
  });
}
// If no walks AND no state changes, nothing to ask
if (walks.length === 0 && arrivals.length === 0 && departures.length === 0) {
  stampRun(TOPIC, false); emitNull("no edges or walks"); process.exit(0);
}

// State-change events carry priority over mid-walk observation.
// Pick the most recent edge event and describe it.
const now2 = Date.now();
function minAgo(iso) { return iso ? (now2 - new Date(iso).getTime()) / 60000 : Infinity; }

let edgeEvent = null; // { kind: "arrived"|"departed", row, minAgo }
const topArrival = arrivals[0];
const topDeparture = departures[0];
const arrAgo = topArrival ? minAgo(topArrival.arrived_at) : Infinity;
const depAgo = topDeparture ? minAgo(topDeparture.departed_at) : Infinity;
if (arrAgo < depAgo && isFinite(arrAgo)) {
  edgeEvent = { kind: "arrived", row: topArrival, minAgo: arrAgo };
} else if (isFinite(depAgo)) {
  edgeEvent = { kind: "departed", row: topDeparture, minAgo: depAgo };
}

// Fall back to walk observation if no edge event
const walk = walks.find(w => w.inProgress) || walks[walks.length - 1] || null;
const startIso = walk ? walk.first.ts : (edgeEvent?.row?.arrived_at || edgeEvent?.row?.departed_at);
const endIso = walk ? walk.last.ts : (edgeEvent?.row?.departed_at || edgeEvent?.row?.arrived_at);
const startHhmm = hhmm(startIso);
const endHhmm = hhmm(endIso);
const hour = localHourOf(endIso);

// ── Step 2: check if companions/notes already tagged ──────────────────
// location-track doesn't return those fields; skip DB recheck for now
// (hum's dedup_key suppresses re-asking the same walk).

// ── Step 3: form a hypothesis ──────────────────────────────────────────

// A. Short loop starting/ending near home → the routine walk (morning/evening),
// from the homes of agent/local/config/routine-walk.json (lib/ambient-geometry.mjs).
const WALK = routineWalkConfig();
const NAMED = walkHomes();
function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371;
  const dl = (la2 - la1) * Math.PI / 180, dn = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dl/2)**2 + Math.cos(la1*Math.PI/180) * Math.cos(la2*Math.PI/180) * Math.sin(dn/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
function nearestNamed(lat, lon, km = 0.15) {
  let best = null;
  for (const n of NAMED) {
    const d = haversineKm(lat, lon, n.lat, n.lon);
    if (d <= km && (!best || d < best.d)) best = { name: n.name, d };
  }
  return best;
}
const startNear = walk ? nearestNamed(walk.first.lat, walk.first.lon, 0.25) : null;
const endNear   = walk ? nearestNamed(walk.last.lat,  walk.last.lon, 0.25) : null;

let hypothesis = null;

// ── Edge hypothesis: just arrived somewhere ────────────────────────────
if (!hypothesis && edgeEvent && edgeEvent.kind === "arrived" && edgeEvent.minAgo <= 45) {
  const row = edgeEvent.row;
  const nearArr = nearestNamed(row.latitude, row.longitude, 0.2);
  const placeGuess = row.place_name || nearArr?.name;
  if (placeGuess) {
    hypothesis = {
      question: `At ${placeGuess}?`,
      annotate: { note: `At ${placeGuess}` },
      edge: "arrived",
    };
  }
  // No place-name match — "just stopped somewhere, where are you?" carries
  // zero hypothesis and just asks the user to do hum's information-gathering
  // for it. Leave hypothesis unset: later tiers (walk / calendar / routine walk) get
  // a chance, and if none fire either, the catch-alls below emit null.
}

// ── Edge hypothesis: just departed somewhere ───────────────────────────
if (!hypothesis && edgeEvent && edgeEvent.kind === "departed" && edgeEvent.minAgo <= 45) {
  // If a calendar event is imminent (<45 min) with a physical location, guess that.
  try {
    const cal = JSON.parse(sh(CAL_CMD));
    const events = cal?.events || cal?.items || cal || [];
    const nowMs = Date.now();
    for (const e of events) {
      const es = new Date(e.start?.dateTime || e.start?.date || 0).getTime();
      if (!es || es < nowMs - 5 * 60 * 1000 || es > nowMs + 45 * 60 * 1000) continue;
      const loc = e.location || "";
      const isPhysical = loc && !/^https?:|zoom\.|meet\.google/i.test(loc);
      if (!isPhysical) continue;
      const summary = (e.summary || "event").trim();
      hypothesis = {
        question: `Heading to ${summary}?`,
        annotate: { note: `${summary}${loc ? ` (${loc.split(",")[0]})` : ""}` },
        edge: "departed",
      };
      break;
    }
  } catch { /* no calendar */ }
  // No calendar match — "where are you off to?" carries zero hypothesis.
  // Leave it unset rather than asking a content-free question (same
  // rationale as the arrived-edge case above); later tiers or the
  // catch-alls below take it from here.
}

// If we don't have a walk and no edge hypothesis, nothing to ask
if (!walk && !hypothesis) {
  stampRun(TOPIC, false); emitNull("no actionable signal"); process.exit(0);
}

// Routine-walk hypothesis: starts near home, typical time-of-day. In-progress
// walks can't confirm end location — we guess based on start + habit. Off
// without a configured companion (routine-walk.json `companion`).
const COMPANION = WALK.companion || null;
const MORNING_UNTIL = Number.isFinite(WALK.ask_morning_until_hour) ? WALK.ask_morning_until_hour : 10;
const [EVE_FROM, EVE_TO] = Array.isArray(WALK.ask_evening_hours) ? WALK.ask_evening_hours : [17, 21];
const walkHour = (h) => h <= MORNING_UNTIL || (h >= EVE_FROM && h <= EVE_TO);
const startHour = walk ? localHourOf(startIso) : null;
const looksLikeRoutineWalkStart = COMPANION && walk && startNear && walk.durationMin <= 30 && walkHour(startHour);
const looksLikeRoutineWalkFull = COMPANION && walk && startNear && endNear && startNear.name === endNear.name &&
    walk.durationMin <= 25 && walkHour(hour);

if (!hypothesis && walk && walk.inProgress && looksLikeRoutineWalkStart) {
  const tod = startHour <= MORNING_UNTIL ? "morning" : "evening";
  hypothesis = {
    question: `Out with ${COMPANION} for a ${tod} walk?`,
    annotate: { companions: [COMPANION], note: `${tod[0].toUpperCase()+tod.slice(1)} walk with ${COMPANION}` },
    scan_similar: true,
  };
} else if (!hypothesis && looksLikeRoutineWalkFull) {
  const tod = hour <= MORNING_UNTIL ? "morning" : "evening";
  hypothesis = {
    question: `Taking ${COMPANION} for a ${tod} walk?`,
    annotate: { companions: [COMPANION], note: `${tod[0].toUpperCase()+tod.slice(1)} walk with ${COMPANION}` },
    scan_similar: true,
  };
}

// B. Calendar event overlap (time + location) — ask by event name
if (!hypothesis && walk) {
  try {
    const cal = JSON.parse(sh(CAL_CMD));
    const events = cal?.events || cal?.items || cal || [];
    const walkMid = (new Date(startIso).getTime() + new Date(endIso).getTime()) / 2;
    // Accept events whose window overlaps the walk or that start within 45 min
    // after the walk end (suggesting the walk was the journey to the event)
    for (const e of events) {
      const es = new Date(e.start?.dateTime || e.start?.date || 0).getTime();
      const ee = new Date(e.end?.dateTime || e.end?.date || 0).getTime();
      if (!es) continue;
      const overlapsWalk = es <= new Date(endIso).getTime() && ee >= new Date(startIso).getTime();
      const startsSoonAfterWalk = es > new Date(endIso).getTime() && es - new Date(endIso).getTime() < 45 * 60 * 1000;
      if (!overlapsWalk && !startsSoonAfterWalk) continue;
      const loc = e.location || "";
      const isPhysical = loc && !/^https?:|zoom\.|meet\.google/i.test(loc);
      if (!isPhysical) continue;
      const summary = (e.summary || "event").trim();
      const verb = walk.inProgress ? "Heading to" : "Headed to";
      hypothesis = {
        question: `${verb} ${summary}?`,
        annotate: { note: `${summary}${loc ? ` (${loc.split(",")[0]})` : ""}` },
      };
      break;
    }
  } catch { /* calendar unavailable — fall through */ }
}

// C. (Removed: this used to be a catch-all open question —
// "just noticed you walking, where are you off to?" — with zero hypothesis
// attached. It fired on every unmatched walk and asked the user to do hum's
// information-gathering for it. Named tiers above (routine walk, calendar
// overlap) still fire when there's a real hypothesis; when none of them do,
// fall through to the "nothing to say" exit below like every other tier in
// this file.

if (!hypothesis) {
  stampRun(TOPIC, false); emitNull("no hypothesis"); process.exit(0);
}

// Edge events (arrived/departed) and in-progress walks get higher urgency —
// act while the user is at a decision point.
const urgency = (hypothesis.edge || (walk && walk.inProgress)) ? 0.75 : 0.5;

// Dedup key: prefer edge event id over walk start
const dedupKey = hypothesis.edge
  ? `location_context:edge:${hypothesis.edge}:${edgeEvent.row.id}`
  : `location_context:walk:${startIso}`;

// The card (client ChoicePrompt § subject). A location question must make
// plain whether it is about a ROUTE (a walk or drive), a PLACE, or an EVENT,
// and when. One tap answers it: the value is the note
// location-annotate would have written for a yes, and "No, something else"
// hands the reply to the agent (OTHER_VALUE in lib/choice-reply.mjs).
if (!recallMedia(dedupKey) && startIso) {
  const subjKind = hypothesis.edge === "arrived" ? "place"
    : (hypothesis.edge === "departed" || (hypothesis.annotate && !hypothesis.annotate.companions && walk)) ? "event"
    : "route";
  const cardEnd = (walk && walk.inProgress) ? new Date().toISOString() : (endIso || startIso);
  let mapUrl = null, trace = null;
  try {
    if (!fs.existsSync(STOP_MAP)) throw new Error("no stop-map");
    const tzFlag = `--tz ${LOCAL_TZ}`;
    const cmdMap = edgeEvent && !walk
      ? `${STOP_MAP} --visit ${edgeEvent.row.id} ${tzFlag} --upload --json`
      : `${STOP_MAP} --start ${startIso} --end ${cardEnd} ${tzFlag} --upload --json`;
    const mj = JSON.parse(execSync(cmdMap, { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] }));
    if (String(mj.url || "").startsWith("https://")) { mapUrl = mj.url; trace = mj.trace || null; }
  } catch { /* card without a map */ }
  const note = hypothesis.annotate?.note || null;
  const options = note
    ? [{ id: "o1", label: `Yes — ${note}`, value: note }, { id: "o2", label: "No, something else", value: "__other__" }]
    : [];
  const subject = Object.fromEntries(Object.entries({
    kind: subjKind, mode: subjKind === "route" ? "walking" : null,
    start: startIso, end: cardEnd, tz: LOCAL_TZ, ongoing: !!(walk && walk.inProgress),
    map_url: mapUrl, path: trace, question: hypothesis.question,
    lat: walk?.first?.lat ?? edgeEvent?.row?.latitude ?? null,
    lon: walk?.first?.lon ?? edgeEvent?.row?.longitude ?? null,
  }).filter(([, v]) => v != null));
  stashMedia(dedupKey, { map_url: mapUrl, choice: {
    v: 1, id: `hum-${dedupKey}`, kind: "location_route", ref: dedupKey,
    prompt: hypothesis.question, options, subject,
    companions: hypothesis.annotate?.companions || [],
  } });
}

stampRun(TOPIC, true);
emit({
  topic: TOPIC,
  signal: hypothesis.question,
  urgency,
  freshness_min: hypothesis.edge ? Math.round(edgeEvent.minAgo) : (walk?.endedMinAgo ?? 0),
  dedup_key: dedupKey,
  supporting_data: {
    edge: hypothesis.edge || null,
    in_progress: walk ? walk.inProgress : false,
    window: { start_iso: startIso, end_iso: endIso },
    start_hhmm: startHhmm,
    end_hhmm: endHhmm,
    duration_min: walk?.durationMin ?? null,
    yes_no: hypothesis.annotate !== null,
    annotate_on_yes: hypothesis.annotate,
    scan_similar_on_yes: !!hypothesis.scan_similar,
    annotate_hint: { tool: "location_annotate", args: { start: startIso, end: endIso } },
  },
});
