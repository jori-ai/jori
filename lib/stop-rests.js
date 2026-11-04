"use strict";
// stop-rests — decide where the user actually STOOD STILL, from progress along
// the route rather than from one averaged point.
//
// The requirement: stops are read from progress through the route, not from
// single points (two "stops" four minutes apart near a store were one visit to
// the store, and a third was a walk past it).
//
// The trace that showed it: one afternoon the resolver produced ONE stop
// covering 17:03-17:39 with a **203 m cluster radius**, spanning three separate
// CLVisit rows 700 m apart, and named it after a big-box store because the
// blend's CENTROID landed 72 m from the store's coords — inside the entry's
// 80 m proximity. The user was never at the store during the window that got
// its name. What the raw fixes say, in metres from the store (80 m proximity):
//
//     time      d(store)   acc    what the row says
//     17:03:09     122 m   39 m   visit "<street address>"   walking north
//     17:06:28     143 m   32 m   walking north
//     17:12:07      75 m   28 m   walking THROUGH, not stopping
//     17:14:13     288 m   48 m   visit "<street address>" — the turnaround
//     17:18:45     287 m   48 m   walking (CoreMotion), 0.8 m from the last fix
//     17:26:11      75 m   22 m   walking back south
//     17:26:55      38 m   32 m   visit "<street address>" ← arrives at the store
//     17:31:49      31 m   14 m   7 m from the last fix: STILL HERE
//     17:38:02     170 m   14 m   leaving
//
// ONE real rest: the store, 17:26:55-17:38:02, eleven minutes at 31-38 m. The
// pipeline reported a 15-minute stop named for the store at 17:06-17:21 — a
// window spent walking past it at 75-288 m — plus a 1-minute unlabeled sliver, and
// reconcileStopTimeline had to trim 29 minutes off the blend to stop it
// overlapping its own neighbour.
//
// The 17:14 pair looks like a rest and is not one; see REST_ACC_MAX_M below.
//
// This is the failure the location spine already names — "a container bigger
// than the place is the recurring failure" — reaching the naming ladder. A
// centroid is a summary statistic; it is not a place the user was. Two questions have
// to be asked of the trace instead:
//
//   1. WHERE did the trace rest?  A cluster whose radius exceeds any single
//      building gets re-cut into the windows where consecutive fixes actually
//      stayed put, and the walking between them is dropped.
//   2. Did it rest AT the named place?  A known-recurring name survives only if
//      one of those rests sits inside its own proximity radius. Passing within
//      75 m of a store on the way somewhere else is not a visit to it.
//
// SILENCE IS EVIDENCE OF STILLNESS, not of absence (spine, rung 1): the phone
// stops emitting when the user stops moving, so a rest ends at the next fix
// SOMEWHERE ELSE, never at its own last fix. Measuring the store's rest to its own
// last ping reports 5 minutes; measuring it to the next fix outside the group
// (17:38:02) gives 11 and reproduces the CLVisit row exactly.

// A fix this loose carries no usable position (a 1414 m reading is a cell-tower
// fix); everything downstream rejects it and so does this.
const ACC_MAX_M = 60;

// ...but "usable position" and "good enough to prove the user STOOD STILL" are
// not the same bar, and conflating them invented stops while passing through.
// The 17:14 window above is two fixes 0.8 m apart — which reads like standing perfectly still until you
// notice both carry **48 m accuracy**. At 48 m the true positions could be 90 m
// apart; the reading cannot tell standing from walking a block, so a 0.8 m
// "spread" is not evidence of anything. CoreMotion agreed and was also ignored:
// the second of those fixes is tagged `walking`.
//
// The store's rest 12 minutes later is the contrast — 32 m and 13.6 m, 7 m apart.
// Same shape, but at that precision the fixes actually resolve the question.
//
// So a rest needs fixes precise enough to make the claim. Loose fixes still
// place the user (they stay inside the window and keep the walk drawn); they
// just don't get to assert a stop.
// ...and enough of them: two points might be just a random pause. Two is a
// weak sample: two fixes in the same spot is also what waiting for
// someone on a corner looks like, and the rest we infer from them is usually
// much LONGER than the stretch they actually witness — the store's two fixes span
// 4.9 minutes and are used to claim 11.
//
// But the count cannot simply be raised, because the phone stops emitting when
// the user stops moving: a 40-minute dinner routinely lands 2 fixes, and demanding 4
// would delete exactly the long quiet stops that matter most. So the bar scales
// with what else vouches for the window rather than with the count alone:
//
//   3+ precise fixes            a sample, not a coincidence — stands alone
//   2 precise fixes             stands only if something INDEPENDENT of the
//                               fixes' positions agrees of a stop: a
//                               CLVisit row inside the group (iOS's own visit
//                               detector), or a fix CoreMotion tagged
//                               `stationary` (the accelerometer, not the GPS)
//   fewer                       not a rest
//
// Two independent instruments saying "stopped" beats a third GPS sample saying
// what the first two said.
const REST_ACC_MAX_M = 35;
const REST_MIN_PRECISE = 2;
const REST_UNCORROBORATED_PRECISE = 3;

// How far apart two fixes can be and still be "the same spot". Generous enough
// for indoor drift and a big-box store's own footprint, tight enough that two
// places a block apart never merge.
const REST_RADIUS_M = 75;

// Below this a rest is a pause at a light, not a stop. Matches the pipeline's
// existing "under 10 minutes isn't a stop" bar minus a little slack, because a
// rest measured to the NEXT fix is already a lower bound.
const REST_MIN_MIN = 6;

// A cluster wider than this is not a place — it is a walk with a mean. 120 m is
// bigger than any single building and far smaller than the 203 m blend that
// started this.
//
// Lowered 120 -> 100 after a real closing at an office followed by a real
// ~20-minute lunch at a restaurant 167 m away blended into one 107.4 m stop -- under the old bar by
// 12.6 m, so splitStopOnRests never even looked for the second rest. On a dense
// urban block two distinct storefronts routinely sit 100-120 m apart; the 120 m
// bar was calibrated against the 203 m store blend and had never been
// tested against anything narrower. 100 m keeps clear daylight above genuine
// single-building drift (the "tight cluster" case below is 30 m) while catching
// this shape.
const SPLIT_RADIUS_M = 100;

// ...but a radius measured from the CENTROID cannot see two lobes. Put a long
// stay at one door and a 20-minute coffee 170 m away into one cluster and the
// centroid lands between them, so the "radius" is half the gap (2026-10-10: a
// 92 m radius over a 170 m split, under the 100 m bar above, so the coffee stop
// was never looked for). Two rests SPLIT_SEPARATION_M apart (resolve-day, 130 m)
// force a radius of at least half that, so below this the stop cannot hold two
// places and is left alone; between this and SPLIT_RADIUS_M it is only ever cut
// on two or more rests -- never tightened onto a single one, which stays the
// wide-cluster rule's job.
const TWO_LOBE_RADIUS_M = 65;

function haversineMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lat2 == null || lon1 == null || lon2 == null) return Infinity;
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Fixes precise enough to argue about stillness with. Used by the "was this a
// stop at all?" test, which must not fire on a window we simply cannot see.
function preciseCount(pings, fromMs, toMs) {
  return usablePings(pings, fromMs, toMs)
    .filter(p => p.acc == null || p.acc <= REST_ACC_MAX_M).length;
}

function usablePings(pings, fromMs, toMs) {
  return (pings || [])
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .filter(p => p.acc == null || p.acc <= ACC_MAX_M)
    .filter(p => p.ts >= fromMs && p.ts <= toMs)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * The windows inside [fromMs, toMs] where the trace stayed put.
 *
 * Greedy and in time order: a fix joins the current rest while it stays within
 * REST_RADIUS_M of that rest's running centroid; the first fix that doesn't
 * ENDS the rest — and its own timestamp is the rest's end, because that is the
 * first moment we can prove the user was elsewhere.
 */
function findRests(pings, fromMs, toMs, opts = {}) {
  const radius = opts.restRadiusM || REST_RADIUS_M;
  const minMin = opts.minRestMin != null ? opts.minRestMin : REST_MIN_MIN;
  const pts = usablePings(pings, fromMs, toMs);
  if (!pts.length) return [];

  const groups = [];
  let cur = null;
  for (const p of pts) {
    if (cur && haversineMeters(p.lat, p.lon, cur.lat, cur.lon) <= radius) {
      cur.members.push(p);
      cur.lat = cur.members.reduce((t, m) => t + m.lat, 0) / cur.members.length;
      cur.lon = cur.members.reduce((t, m) => t + m.lon, 0) / cur.members.length;
      continue;
    }
    if (cur) { cur.broken_by = p.ts; groups.push(cur); }
    cur = { members: [p], lat: p.lat, lon: p.lon, broken_by: null };
  }
  if (cur) groups.push(cur);

  const rests = [];
  for (const g of groups) {
    // Precise enough to be making this claim at all. A null accuracy is
    // unknown, not bad -- some sources never wrote the column.
    const precise = g.members.filter(m => m.acc == null || m.acc <= REST_ACC_MAX_M);
    if (precise.length < REST_MIN_PRECISE) continue;
    // Something other than the GPS positions saying the user had stopped: iOS's own
    // visit detector, or the accelerometer.
    const corroborators = [
      g.members.some(m => m.kind === "visit") ? "clvisit" : null,
      g.members.some(m => /stationary/i.test(String(m.activity || ""))) ? "stationary" : null,
      // A photo is a witness of its own: the user stopped, framed something, and
      // pressed the button. Independent of the GPS positions in exactly the way
      // this list requires, and often the only thing awake during a long quiet
      // stop — see resolve-day's photoPings.
      g.members.some(m => m.kind === "photo") ? "photo" : null,
    ].filter(Boolean);
    if (precise.length < REST_UNCORROBORATED_PRECISE && !corroborators.length) continue;

    const start = g.members[0].ts;
    // The user was still there until turning up somewhere else. With nothing after
    // it, the enclosing window's end is the best bound we have.
    const end = g.broken_by != null ? g.broken_by : toMs;
    const minutes = (end - start) / 60_000;
    if (minutes < minMin) continue;
    // How much of the claim the fixes actually WITNESS, as against how much is
    // inferred from the silence after the last one. A rest can be true and
    // thinly witnessed — that is what a quiet phone looks like — but the
    // difference is worth carrying rather than flattening.
    const witnessedMs = g.members[g.members.length - 1].ts - start;
    rests.push({
      start_ms: start, end_ms: end, minutes: Math.round(minutes),
      lat: g.lat, lon: g.lon, sample_count: g.members.length,
      precise_count: precise.length,
      witnessed_min: Math.round(witnessedMs / 60_000),
      corroborated_by: corroborators,
      // How far the fixes themselves spread — a rest's own honest radius.
      radius_m: Math.round(Math.max(0, ...g.members.map(m =>
        haversineMeters(m.lat, m.lon, g.lat, g.lon)))),
    });
  }
  return rests;
}

/**
 * Did the trace actually rest AT this place during the window?
 *
 * Used to verify a known-recurring match before its name is allowed to stand.
 * Returns the qualifying rest, or null. `proximityM` is the entry's own — a
 * place declares how close counts as being there.
 */
function restAt(pings, fromMs, toMs, coords, proximityM, opts = {}) {
  if (!coords || coords.length < 2) return null;
  const rests = findRests(pings, fromMs, toMs, opts);
  let best = null;
  for (const r of rests) {
    const d = haversineMeters(r.lat, r.lon, coords[0], coords[1]);
    if (d > proximityM) continue;
    if (!best || d < best.distance_m) best = { ...r, distance_m: Math.round(d) };
  }
  return best;
}

/**
 * Re-cut one over-wide stop into the rests inside it.
 *
 * Returns null when the stop should be left alone — it isn't over-wide, there
 * is no trace to read, or the trace shows a single rest that already accounts
 * for the window (i.e. the cluster was honest and only its radius looked bad).
 */
function splitStopOnRests(stop, pings, opts = {}) {
  const splitRadius = opts.splitRadiusM || SPLIT_RADIUS_M;
  const radiusM = (stop.cluster_radius_km || 0) * 1000;
  const wide = radiusM > splitRadius;
  if (radiusM <= (opts.twoLobeRadiusM || TWO_LOBE_RADIUS_M)) return null;
  const rests = findRests(pings, stop.start_ts_ms, stop.end_ts_ms, opts);
  if (!rests.length) return null;
  if (!wide && rests.length < 2) return null;
  if (rests.length === 1) {
    const covered = (rests[0].end_ms - rests[0].start_ms) / (stop.end_ts_ms - stop.start_ts_ms);
    // One rest that fills the window means the wide radius was drift, not a
    // walk — keep the stop as it is.
    if (covered >= 0.8) return null;
    // One rest inside a much longer window means the window was a walk with one
    // stop in it: tighten onto the rest rather than keeping the blend's span.
  }
  return rests;
}

module.exports = {
  findRests,
  restAt,
  splitStopOnRests,
  usablePings,
  preciseCount,
  haversineMeters,
  ACC_MAX_M, REST_ACC_MAX_M, REST_MIN_PRECISE, REST_UNCORROBORATED_PRECISE,
  REST_RADIUS_M, REST_MIN_MIN, SPLIT_RADIUS_M, TWO_LOBE_RADIUS_M,
};
