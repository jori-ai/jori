// ask-gate — may we ask him about this stop (or announce that he left it)?
//
// Pure functions; bin/ask-gate does the fetching. Every location
// question and every "Left X" event passes through here first.
//
// The rule (2026-10-07): a stop is over only when the RAW trace shows him
// somewhere else. Rows can't be trusted to say so: they come in duplicates,
// sweeper-stretched, iOS-late, open, or (that night) invented — `day-segments`
// cut a 21:29–21:53 slice out of an Airbnb stay that was still in progress,
// ended it at the phone's last fix, and he was asked "were you at the airbnb?"
// without having moved all evening. Every fix since 19:23 sat within 1 m of
// the flat. Reading only fixes and self-captured photos makes the gate immune
// to every row-level bug, including the ones not found yet.
//
//   A  departure proof — a point after the stop's end that is away from it
//      even at the worst edge of its own accuracy circle. No proof, no ask.
//   B  same stay — an earlier visit at the same place with no proof he was
//      away in between means this "stop" is a slice of that stay.
//
// The cost is deliberate: a real stop whose next fixes upload late is asked
// later (askTiming's honest lead) or left to the daily summary. A missing
// question is cheap; a question about a place he never left is the failure.

const R = 6371000;
export function meters(a, b) {
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Away = farther than this even after subtracting the point's accuracy.
// Measured 2026-10-07 over 36 confirmed stays of 1–14 h (349 fixes): 15 sat
// ≥75 m out by this test and 3 ≥150 m — still phones do throw the odd far fix,
// so departure takes TWO away points (or one self-captured photo). 75 m, not
// 150: a real breakfast stop 155 m from the lodging the user walked back to
// would never have been asked at 150 m.
export const LEFT_M = 75;
export const AWAY_POINTS = 2;
// An earlier visit is the SAME stay only if it sat this close; one point this
// far out (accuracy subtracted) breaks the stay. 150 m swallowed that
// breakfast into the lodging night.
export const SAME_PLACE_M = 50;
// Self-captured photos carry no accuracy; camera GPS outdoors is usually good.
export const PHOTO_ACC_M = 30;
// Points looser than this place him nowhere useful (matches PATH_ACC_MAX_M).
export const ACC_MAX_M = 75;
// Points used to locate the stop itself.
export const CENTER_ACC_M = 35;
// How far back an earlier visit can claim this one as its continuation.
export const LOOKBACK_H = 24;
// Rows arriving this close to the stop's own start are its duplicate twins.
export const TWIN_S = 90;

const ms = (t) => (typeof t === "number" ? t : Date.parse(t));

export function isAway(p, center, m = LEFT_M) {
  const acc = p.acc == null ? PHOTO_ACC_M : p.acc;
  if (acc > ACC_MAX_M) return false;
  return meters(p, center) - acc >= m;
}

/** Where the stop was: median of its own precise points, else the row's coords. */
export function stopCenter(points, start, end, fallback) {
  const inside = points.filter((p) => p.t >= start && p.t <= end && (p.acc == null || p.acc <= CENTER_ACC_M));
  if (!inside.length) return fallback;
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return { lat: med(inside.map((p) => p.lat)), lon: med(inside.map((p) => p.lon)) };
}

/** The point after `after` that completes proof he was away from `center`
 *  (the second away point, or the first away photo), or null. */
export function departureProof({ points, center, after }) {
  let n = 0;
  for (const p of points) {
    if (!(p.t > after) || !isAway(p, center)) continue;
    if (p.kind === "photo" || ++n >= AWAY_POINTS) return p;
  }
  return null;
}

/** The earlier visit at this place he never left before this stop began, or null. */
export function sameStay({ points, center, start, priorStays }) {
  const lo = start - LOOKBACK_H * 3600000;
  let lastAway = -Infinity;
  for (const p of points) if (p.t >= lo && p.t < start && isAway(p, center, SAME_PLACE_M)) lastAway = Math.max(lastAway, p.t);
  for (const s of priorStays || []) {
    const a = ms(s.arrived_at);
    if (!(a >= lo && a < start - TWIN_S * 1000)) continue;
    if (s.place_type === "non-stop") continue;
    if (s.latitude == null || meters({ lat: s.latitude, lon: s.longitude }, center) > SAME_PLACE_M) continue;
    if (a > lastAway) return s;
  }
  return null;
}

/**
 * The full gate. `mode: "ask"` runs A and B; `mode: "departure"` runs A only
 * (a "Left X" event needs proof he left, not that the stop was new).
 * Returns { ask, check, reason, center, departure?, same_stay? }.
 */
export function gate({ points, start, end, fallbackCenter, priorStays = [], mode = "ask" }) {
  start = ms(start); end = ms(end);
  const center = stopCenter(points, start, end, fallbackCenter);
  if (!center || center.lat == null) return { ask: true, check: "no-center", reason: "no position to judge from — asking as before" };
  if (mode === "ask") {
    const held = sameStay({ points, center, start, priorStays });
    if (held) {
      return { ask: false, check: "same-stay", center, same_stay: { id: held.id, arrived_at: held.arrived_at, place_name: held.place_name || null },
        reason: `continues the stay that began ${new Date(ms(held.arrived_at)).toISOString()} — no point away from it in between` };
    }
  }
  const dep = departureProof({ points, center, after: end });
  if (!dep) return { ask: false, check: "no-departure", center, reason: "no point away from the stop since it ended — he may still be there" };
  return { ask: true, check: "left", center,
    departure: { t: new Date(dep.t).toISOString(), m: Math.round(meters(dep, center)), acc: dep.acc, kind: dep.kind },
    reason: `seen ${Math.round(meters(dep, center))} m away at ${new Date(dep.t).toISOString()}` };
}
