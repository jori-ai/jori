// stop-passage — was a "stop" a stop at all, or a stretch of a walk?
//
// The requirement, from two questions sent the same afternoon: look at the
// data and answer what it was before asking, so such a question is avoided.
//
//   14:52–15:00  "8m around 14:52, but GPS shows you drifting ~390m the whole
//                time — just walking around, or did you actually stop?"
//                Every fix tagged `walking`, ~150 m apart, four minutes apart,
//                straight from lunch at a restaurant to the rental's door.
//   18:05–18:29  "Where was this?" in a seaside park. A sunset walk: five
//                photos at 18:11–18:12 on the promenade, a sixth 140 m further
//                on at 18:16, the longest pause anything SAW about two minutes.
//
// Both questions were composed with the evidence in hand. findme's
// `_movement_evidence` had already seen the walking and only re-worded the ask
// (jobs/location-enrich.md point 7); segment-ask never looked. This module is
// the check both ask paths now run first.
//
// TWO LAYERS, because this is mostly geometry and code owns geometry:
//
//   1. classifyWindow() — deterministic. A window is a PASSAGE when nothing in
//      it could have hidden a stop: no rest of STOP_MIN or more among the fixes
//      (photos count as fixes — the camera is often the only thing awake), no
//      silence long enough to have stood still in for STOP_MIN after allowing
//      the walking time the gap's distance needs, and the user covered ground or the
//      phone said the user was moving. A REST of STOP_MIN or more is a real stop.
//      Anything else is INCONCLUSIVE — usually a silence the trace can't see
//      into (the sunset walk has one: 18:17→18:24, 63 m apart).
//   2. stop-passage-jev.mjs — Jev decides the INCONCLUSIVE ones from the same
//      features plus what the numbers can't carry: the photos the user took (labels,
//      OCR'd text), calendar events and the user's own messages in the window.
//
// "Silence is stillness" (location-spine): a still phone stops emitting, so a
// gap is never evidence of movement. It is counted as possible standing time,
// minus the time walking the gap's distance would have taken.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { haversineMeters, REST_ACC_MAX_M } = require("./stop-rests.js");

// A fix looser than this places the user nowhere useful (cell-tower fixes arrive at
// 1414 m). Same bound the resolver uses for the path.
export const PATH_ACC_MAX_M = 75;
// Two fixes this close are the same spot. Matches the rest radius elsewhere.
export const REST_RADIUS_M = 30;
// Under this long the user paused (a photo, a crossing); at or over it the user stopped.
// Well under enrich's 8-minute floor, so a stop that would be asked about can
// never be called a passage on the strength of a shorter rest.
export const STOP_MIN = 5;
// The pace used to explain a gap. Deliberately brisk: the faster we assume the user
// walked, the MORE of the gap is left over as possible standing time, so the
// check errs toward "could have stopped".
export const WALK_M_PER_MIN = 80;
// Covered at least this much ground inside the window = the user was going somewhere.
export const SPREAD_MIN_M = 100;
// Share of motion-tagged fixes (ignoring unknown/null) that must say moving.
export const MOVING_SHARE_MIN = 0.6;
// Below this many usable fixes inside the window there is nothing to judge.
export const MIN_POINTS_IN_WINDOW = 2;
// Jev may not call a window a walk when a silence inside it could have held
// this much standing time. A gap that long whose distance takes a minute or
// two to walk is a still phone. 2026-10-07 replay: Jev said walk at 0.92 on an
// 86-min confirmed stop at a shop, which had a 45-minute silence.
export const JEV_MAX_HIDDEN_MIN = 15;

// The far end of a drive out and back (bin/day-segments § turnaround_stops):
// driving to a place and returning without a stop makes the turning point a
// destination worth asking about, unless the purpose of the drive is known. The row's notes carry this token, a string we
// write, matched by membership.
export const TURNAROUND_TOKEN = "[turnaround]";
export const isTurnaround = (notes) => String(notes || "").includes(TURNAROUND_TOKEN);

/**
 * The car is moving through the whole window, which is how it got there, so the
 * geometry can only ever call it a passage (and Jev would call it a walk). Its
 * verdict is replaced with "inconclusive": the evidence step still runs and
 * names it when the purpose is already known (the user's calendar, the user's words), else it
 * is asked about.
 */
export function asTurnaround(l1) {
  return { ...l1, verdict: "inconclusive",
    reason: "far end of a drive out and back: the window is moving by construction, so it is asked about unless its purpose is already known" };
}

const MOVING = new Set(["walking", "running", "cycling", "driving", "automotive"]);
const STILL = new Set(["stationary"]);

const ms = (t) => (typeof t === "number" ? t : Date.parse(t));
const min = (a, b) => (b - a) / 60000;

/**
 * Turn location_history transit rows and self-captured photos into one sorted
 * point stream. Rows with no position, a cell-tower accuracy, or a duplicate
 * timestamp (the client uploads some fixes twice) are dropped.
 */
export function pointsFrom({ fixes = [], photos = [] }) {
  const pts = [];
  for (const f of fixes) {
    const lat = Number(f.latitude), lon = Number(f.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const acc = f.accuracy_m == null ? null : Number(f.accuracy_m);
    if (acc != null && acc > PATH_ACC_MAX_M) continue;
    pts.push({ t: ms(f.arrived_at), lat, lon, acc, activity: f.activity || null, kind: "fix" });
  }
  for (const p of photos) {
    const lat = Number(p.latitude), lon = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !p.taken_at) continue;
    if (p.self_captured === false) continue; // a received photo says nothing about where the user was
    pts.push({ t: ms(p.taken_at), lat, lon, acc: null, activity: null, kind: "photo" });
  }
  pts.sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.t === p.t && last.lat === p.lat && last.lon === p.lon) continue;
    out.push(p);
  }
  return out;
}

const precise = (p) => p.acc == null || p.acc <= REST_ACC_MAX_M;

/** Observed rests over a whole point stream, unclipped: ≥2 precise points
 *  within REST_RADIUS_M, lasting until the user is seen elsewhere less the walk. */
export function restRuns(points) {
  const runs = [];
  for (let i = 0; i < points.length; i++) {
    if (!precise(points[i])) continue;
    let j = i;
    while (j + 1 < points.length && precise(points[j + 1])
      && haversineMeters(points[i].lat, points[i].lon, points[j + 1].lat, points[j + 1].lon) <= REST_RADIUS_M) j++;
    if (j > i) {
      let end = points[j].t;
      const next = points[j + 1];
      if (next) end = Math.max(end, next.t - haversineMeters(points[j].lat, points[j].lon, next.lat, next.lon) / WALK_M_PER_MIN * 60000);
      runs.push({ start: points[i].t, end, lat: points[i].lat, lon: points[i].lon });
    }
    i = j;
  }
  return runs;
}

/**
 * Deterministic verdict for [start, end].
 * @returns {{verdict:"passage"|"rest"|"inconclusive", reason:string, features:object}}
 */
export function classifyWindow({ points, start, end }) {
  const s = ms(start), e = ms(end);
  const inWin = points.filter((p) => p.t >= s && p.t <= e);
  const before = [...points].reverse().find((p) => p.t < s) || null;
  const after = points.find((p) => p.t > e) || null;
  const seq = [...(before ? [before] : []), ...inWin, ...(after ? [after] : [])];

  // Rests: runs of consecutive precise points within REST_RADIUS_M of the
  // run's first point. A run lasts until the user is seen somewhere else, less the
  // walk to get there (silence is stillness), and is clipped to the window.
  let longestRestMin = 0, longestRestAt = null;
  for (let i = 0; i < seq.length; i++) {
    if (!precise(seq[i])) continue;
    let j = i;
    while (j + 1 < seq.length && precise(seq[j + 1])
      && haversineMeters(seq[i].lat, seq[i].lon, seq[j + 1].lat, seq[j + 1].lon) <= REST_RADIUS_M) j++;
    // One point followed by silence is not an OBSERVED rest — that silence is
    // counted below as time a stop could hide in (2026-10-06: the 18:16 sunset
    // photo then 7 quiet minutes read as "rested 6.9 min" and blocked Jev).
    if (j === i) continue;
    // Two fixes are only as good as the time they span. One evening at 18:56:
    // two untagged fixes 22 s apart between `walking` fixes, then 9.5 quiet
    // minutes ending 143 m on, read as "rested 8.1 min" — mid-walk, and a rest
    // verdict never reaches Jev. A silence after a run that could hide a stop
    // by itself (≥ STOP_MIN) extends the rest only when the phone said
    // `stationary` inside the run; otherwise it stays possible standing time
    // (counted below) and the window goes to Jev. A shorter one is ordinary
    // fix cadence and still counts — dropping it turned confirmed short stops
    // (King's Kitchen, Shoe Locker) into passages in the replay.
    let restEnd = seq[j].t;
    const next = seq[j + 1];
    if (next) {
      const walk = haversineMeters(seq[j].lat, seq[j].lon, next.lat, next.lon) / WALK_M_PER_MIN * 60000;
      const extended = Math.max(restEnd, next.t - walk);
      const stillTagged = seq.slice(i, j + 1).some((p) => STILL.has(p.activity));
      if (stillTagged || min(restEnd, extended) < STOP_MIN) restEnd = extended;
    }
    const a = Math.max(seq[i].t, s), b = Math.min(restEnd, e);
    const dur = b > a ? min(a, b) : 0;
    if (dur > longestRestMin) { longestRestMin = dur; longestRestAt = { lat: seq[i].lat, lon: seq[i].lon, t: a }; }
    i = j;
  }

  // Silences: between consecutive points that are NOT one spot, how long could
  // the user have stood still somewhere unseen? Gap minus the walk, clipped to the window.
  let longestHiddenMin = 0, longestHidden = null;
  for (let i = 0; i + 1 < seq.length; i++) {
    const p = seq[i], q = seq[i + 1];
    const d = haversineMeters(p.lat, p.lon, q.lat, q.lon);
    // A pair inside one observed rest is counted above — unless the rest is a
    // single point, which the rest loop skips.
    if (precise(p) && precise(q) && d <= REST_RADIUS_M) continue;
    const idle = min(p.t, q.t) - d / WALK_M_PER_MIN;
    const overlap = Math.max(0, min(Math.max(p.t, s), Math.min(q.t, e)));
    const hidden = Math.max(0, Math.min(idle, overlap));
    if (hidden > longestHiddenMin) {
      longestHiddenMin = hidden;
      longestHidden = { from: new Date(p.t).toISOString(), to: new Date(q.t).toISOString(), apart_m: Math.round(d) };
    }
  }

  // A lone point between two silences: the user could have stood AT it for both
  // halves at once. One morning 09:25–09:41, a print shop on the user's
  // calendar: 160 m away at 09:23:42, one fix at the counter at 09:30:15
  // (a photo there at 09:29), 184 m away at 09:37:04. Pairwise, each silence
  // leaves 4.6 min after the walk — under STOP_MIN twice — so the window read
  // as a passage and the stop was withdrawn. Across the point it is 13.4 min
  // less ~4.3 min of walking: 9 min the user could have spent in the shop.
  for (let i = 1; i + 1 < seq.length; i++) {
    const p = seq[i - 1], c = seq[i], q = seq[i + 1];
    if (!precise(c)) continue;
    const walkIn = haversineMeters(p.lat, p.lon, c.lat, c.lon) / WALK_M_PER_MIN;
    const walkOut = haversineMeters(c.lat, c.lon, q.lat, q.lon) / WALK_M_PER_MIN;
    const from = Math.max(p.t + walkIn * 60000, s), to = Math.min(q.t - walkOut * 60000, e);
    const hidden = to > from ? min(from, to) : 0;
    if (hidden > longestHiddenMin) {
      longestHiddenMin = hidden;
      longestHidden = { from: new Date(p.t).toISOString(), to: new Date(q.t).toISOString(),
        apart_m: Math.round(haversineMeters(p.lat, p.lon, q.lat, q.lon)), around_point: new Date(c.t).toISOString() };
    }
  }

  // Ground covered inside the window, and what the motion tags say.
  let spreadM = 0;
  for (let i = 0; i < inWin.length; i++)
    for (let j = i + 1; j < inWin.length; j++)
      spreadM = Math.max(spreadM, haversineMeters(inWin[i].lat, inWin[i].lon, inWin[j].lat, inWin[j].lon));
  const tagged = inWin.filter((p) => MOVING.has(p.activity) || STILL.has(p.activity));
  const movingShare = tagged.length ? tagged.filter((p) => MOVING.has(p.activity)).length / tagged.length : null;

  // Where the user was on either side: an out-and-back starts and ends at one spot.
  const ctxBefore = [...points].reverse().find((p) => p.t <= s - 15 * 60000) || null;
  const ctxAfter = points.find((p) => p.t >= e + 15 * 60000) || null;
  const endsApartM = ctxBefore && ctxAfter ? haversineMeters(ctxBefore.lat, ctxBefore.lon, ctxAfter.lat, ctxAfter.lon) : null;

  // A stay of STOP_MIN+ that begins as the window ends (or ends as it
  // begins): the window is the approach to — or the leaving of — a real stay.
  // The caller must find that stay recorded on another row before calling the
  // window a passage (2026-10-06: a confirmed late-night arrival at the Airbnb
  // was 12 min of driving + parking on one row, the night on its twin).
  const EDGE = 3 * 60000;
  const runs = restRuns(points).filter((r) => min(r.start, r.end) >= STOP_MIN);
  const edgeOf = (r) => r && { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), lat: r.lat, lon: r.lon };
  const arrivalStay = runs.find((r) => r.start >= e - EDGE && r.start <= e + EDGE) || null;
  const departureStay = runs.find((r) => r.end >= s - EDGE && r.end <= s + EDGE) || null;

  const features = {
    window_min: Math.round(min(s, e) * 10) / 10,
    points_in_window: inWin.length,
    photos_in_window: inWin.filter((p) => p.kind === "photo").length,
    longest_rest_min: Math.round(longestRestMin * 10) / 10,
    longest_rest_at: longestRestAt,
    longest_hidden_min: Math.round(longestHiddenMin * 10) / 10,
    longest_hidden: longestHidden,
    spread_m: Math.round(spreadM),
    moving_share: movingShare == null ? null : Math.round(movingShare * 100) / 100,
    tagged_points: tagged.length,
    before_after_apart_m: endsApartM == null ? null : Math.round(endsApartM),
    arrival_stay: edgeOf(arrivalStay),
    departure_stay: edgeOf(departureStay),
  };

  if (inWin.length < MIN_POINTS_IN_WINDOW)
    return { verdict: "inconclusive", reason: `only ${inWin.length} usable point(s) in the window`, features };
  if (longestRestMin >= STOP_MIN)
    return { verdict: "rest", reason: `rested ${features.longest_rest_min} min in one spot`, features };
  if (longestHiddenMin >= STOP_MIN)
    return { verdict: "inconclusive", reason: `a ${features.longest_hidden_min}-min silence could hide a stop`, features };
  const covered = spreadM >= SPREAD_MIN_M;
  const moving = movingShare != null && movingShare >= MOVING_SHARE_MIN;
  if (covered || moving)
    return {
      verdict: "passage",
      reason: `no rest over ${features.longest_rest_min} min, no silence over ${features.longest_hidden_min} min; `
        + `${covered ? `covered ${features.spread_m} m` : ""}${covered && moving ? ", " : ""}`
        + `${moving ? `${Math.round(movingShare * 100)}% of motion tags moving` : ""}`,
      features,
    };
  return { verdict: "inconclusive", reason: "short pauses only, but neither ground covered nor motion tags say moving", features };
}
