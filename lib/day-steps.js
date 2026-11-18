"use strict";
// day-steps — the day's raw step readings, read against the location spine.
//
// Since 2026-11-05 the companion app uploads every individual StepCount sample
// (iPhone and Watch, `health_samples`, kept 7 days by db-retention) from the
// start of yesterday onward. The location spine knows WHERE the user was; the
// steps know whether the user was ON FOOT, minute by minute, even when GPS saw
// nothing. Three uses, all deterministic (Rule #0b: code owns measurement):
//
//   1. Leg mode. A leg is moded by its GPS pace, and pace cannot see a car in
//      traffic or a walk whose fixes were sparse. A "walking" leg with almost no
//      steps was ridden; a "riding" leg at a steady walking cadence was walked.
//   2. Walks GPS missed. A sustained run of steps inside a stop's dwell — the
//      evening walk with the dog while the spine says "Home" all afternoon — is a
//      walk of its own, listed under the stop it left from.
//   3. Counts. Every walk, walking leg and walk excursion carries its steps, and
//      the day carries its total (Apple Health's own daily sum when present —
//      it is already de-duplicated across iPhone and Watch — else ours).
//
// De-duplication: the iPhone and the Watch both count the same steps. Each
// source's samples are spread evenly over the minutes they cover, and each
// minute takes the HIGHER of the sources — the device that was actually
// carried counts more. That is close to what Apple Health does with its source
// priority list, and it never double counts.

const MIN_MS = 60000;
// A walking minute. A stroll with a dog — stopping to sniff, waiting at lights —
// still averages well above this; standing around a kitchen does not.
const WALK_MIN_STEPS = 40;
// Short pauses (a crossing, a dog stop, a word with a neighbour) don't end a walk.
const WALK_GAP_MIN = 3;
// Below either bar it is getting the mail, not a walk.
const WALK_MIN_MIN = 6;
const WALK_MIN_TOTAL = 500;
// Leg-mode evidence. A leg must be long enough for the cadence to mean something.
const LEG_MODE_MIN = 6;
const LEG_RIDDEN_SPM = 12;   // fewer steps a minute than this: not on foot
const LEG_WALKED_SPM = 60;   // at least this: on foot the whole way
const LEG_WALKED_MAX_KMH = 9; // ...and only when the pace allows a brisk walk
const WALK_PAIR_MAX_KMH = 7;  // day-path's ceiling on the pace between two fixes still called a walk

function minuteOf(ms) { return Math.floor(ms / MIN_MS) * MIN_MS; }

/** Per-minute steps of each source (device): Map<source, Map<minuteMs, steps>>. */
function sourceSeries(samples) {
  const bySource = new Map();
  for (const s of samples || []) {
    const v = Number(s.value);
    const a = Date.parse(s.start_date), b = Date.parse(s.end_date);
    if (!(v > 0) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const src = s.source_bundle_id || s.source_name || "?";
    if (!bySource.has(src)) bySource.set(src, new Map());
    const m = bySource.get(src);
    const end = Math.max(b, a + 1000);
    const span = end - a;
    for (let t = minuteOf(a); t < end; t += MIN_MS) {
      const overlap = Math.min(end, t + MIN_MS) - Math.max(a, t);
      if (overlap > 0) m.set(t, (m.get(t) || 0) + (v * overlap) / span);
    }
  }
  return bySource;
}

/** Per-minute steps, de-duplicated across sources: Map<minuteMs, steps>. */
function stepSeries(samples) {
  const bySource = sourceSeries(samples);
  const out = new Map();
  for (const m of bySource.values()) {
    for (const [t, v] of m) if (v > (out.get(t) || 0)) out.set(t, v);
  }
  return out;
}

function stepsBetween(series, fromMs, toMs) {
  let n = 0;
  for (const [t, v] of series) if (t + MIN_MS > fromMs && t < toMs) {
    const overlap = Math.min(toMs, t + MIN_MS) - Math.max(fromMs, t);
    n += (v * overlap) / MIN_MS;
  }
  return n;
}

// Every minute's count, rounded, from the first minute with a reading to the last.
// A reader that counts the steps in a window of its own needs the minutes, not the
// walks: a walk line between two stops counts the minutes it prints, and those can
// hold a stretch no leg holds (a pass the email does not draw), whose steps no leg's
// count has.
function perMinute(series) {
  const ts = [...series.keys()].sort((a, b) => a - b);
  const from = ts[0];
  const counts = new Array(Math.round((ts[ts.length - 1] - from) / MIN_MS) + 1).fill(0);
  for (const [t, v] of series) counts[Math.round((t - from) / MIN_MS)] = Math.round(v);
  return { from_ms: from, counts };
}

/** Steps in [fromMs, toMs) from a day's annotation (`resolved.steps`), or null when its readings do not cover the window. */
function stepsInWindow(steps, fromMs, toMs) {
  const pm = steps && steps.per_min, cov = steps && steps.covered;
  if (!pm || !Array.isArray(pm.counts) || !Number.isFinite(pm.from_ms) || !cov) return null;
  if (!(toMs > fromMs) || fromMs < cov.from_ms - 30 * MIN_MS || toMs > cov.to_ms + 30 * MIN_MS) return null;
  let n = 0;
  pm.counts.forEach((v, i) => {
    const t = pm.from_ms + i * MIN_MS;
    const overlap = Math.min(toMs, t + MIN_MS) - Math.max(fromMs, t);
    if (overlap > 0) n += (v * overlap) / MIN_MS;
  });
  return Math.round(n);
}

/** Sustained walking, from the minutes alone: [{start_ms, end_ms, mins, steps}]. */
function walkSpans(series, opts = {}) {
  const minSteps = opts.minSteps ?? WALK_MIN_STEPS;
  const gap = (opts.gapMin ?? WALK_GAP_MIN) * MIN_MS;
  const active = [...series].filter(([, v]) => v >= minSteps).map(([t]) => t).sort((x, y) => x - y);
  const spans = [];
  for (const t of active) {
    const last = spans[spans.length - 1];
    if (last && t - last.end_ms <= gap) last.end_ms = t + MIN_MS;
    else spans.push({ start_ms: t, end_ms: t + MIN_MS });
  }
  return spans
    .map(s => ({ ...s, mins: Math.round((s.end_ms - s.start_ms) / MIN_MS), steps: Math.round(stepsBetween(series, s.start_ms, s.end_ms)) }))
    .filter(s => s.mins >= (opts.minMin ?? WALK_MIN_MIN) && s.steps >= (opts.minTotal ?? WALK_MIN_TOTAL));
}

const overlapMs = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Metres of a walking leg's holes (stretches the phone did not see) that day-path
 * left out of walked_m as faster than a walker goes, yet the steps in the hole are
 * a walker's cadence. A hole's far end is often a visit's arrival time rather than
 * a fix, so its pace is only as good as that time, while the cadence is measured.
 * A hole already at walking pace is in walked_m and adds nothing.
 */
function walkedHoleMetres(leg, series) {
  let m = 0;
  for (const h of leg.holes || []) {
    const min = (h.end_ms - h.start_ms) / MIN_MS;
    if (!(min > 0) || !(h.m > 0)) continue;
    if (h.m / 1000 / (min / 60) <= WALK_PAIR_MAX_KMH) continue;
    if (stepsBetween(series, h.start_ms, h.end_ms) / min >= LEG_WALKED_SPM) m += h.m;
  }
  return m;
}

/** What the steps say about a leg's mode, or null when they say nothing new. */
function legModeFromSteps(leg, spm) {
  if (!(leg.mins >= LEG_MODE_MIN) || spm == null) return null;
  if (leg.mode === "walking" && spm < LEG_RIDDEN_SPM) return { mode: "riding", walked: false };
  if ((leg.mode === "riding" || leg.mode_uncertain) && spm >= LEG_WALKED_SPM
      && (leg.median_kmh == null || leg.median_kmh <= LEG_WALKED_MAX_KMH)) return { mode: "walking", walked: true };
  return null;
}

// Stop edges the steps can move. GPS sees a departure only once the phone has
// travelled far enough from the stop, and an arrival once it settles; the steps
// see the first and last stride. On 2026-11-04 the walk to a show ran 17:27-17:57
// by steps while the stops said home until 17:36 and the venue from 17:50, so the
// travel line could not state the walk's minutes and its steps together.
const ALIGN_MAX_MIN = 20;     // never move an edge further than this
const ALIGN_KEEP_MIN = 5;     // and never leave a stop shorter than this
const LEG_EDGE_MIN = 15;      // a stop "is" a leg's end when its edge is this close
const HOP_EDGE_MIN = 3;       // a walk "begins as a stop ends" within this, for a hop with no leg
// ...and up to this long BEFORE the stop ends (2026-11-14): the phone sees a departure late,
// so the first strides can come several minutes ahead of the stop's recorded end, and the
// walk was then printed inside the next stop from the minute it began. JORI_STEPS_HOP_EARLY=0: off.
const HOP_EARLY_MIN = 10;
// A walk at a stop's edge, next to a ride, is the way to or from the vehicle.
const RIDE_EDGE_TAIL_MIN = 5; // a walk ending this close to the stop's end, with a ride leaving it
const RIDE_EDGE_HEAD_MIN = 2; // a walk starting this close to the stop's start, with a ride arriving at it

function hhmmIn(ms, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

/**
 * Move the edges of the stops on either side of a walking leg to the walk the
 * steps found: the stop the user left ends at the first stride, the stop the
 * user reached starts at the last, and the leg spans the walk. Only walking
 * legs, only edges within ALIGN_MAX_MIN, never a walk excursion's edges, never
 * past another stop. Returns what moved.
 */
function alignStopsToWalks(resolved, series, legs, stops) {
  const moved = [];
  const tzOf = (s) => (s && s.tz) || resolved.tz;
  const dwells = ((resolved.path && resolved.path.spine) || []).filter(n => n.type === "dwell");
  const travel = resolved.travel_legs || [];
  const setEnd = (s, ms) => {
    const was = s.end_ts_ms;
    for (const d of dwells) if (d.end_ms === was) { d.end_ms = ms; d.end = hhmmIn(ms, tzOf(s)); d.mins = Math.round((d.end_ms - d.start_ms) / MIN_MS); }
    s.end_ts_ms = ms; s.end = hhmmIn(ms, tzOf(s)); s.duration_min = Math.round((s.end_ts_ms - s.start_ts_ms) / MIN_MS);
    moved.push({ stop_id: s.id, edge: "end", from_ms: was, to_ms: ms });
  };
  const setStart = (s, ms) => {
    const was = s.start_ts_ms;
    for (const d of dwells) if (d.start_ms === was) { d.start_ms = ms; d.start = hhmmIn(ms, tzOf(s)); d.mins = Math.round((d.end_ms - d.start_ms) / MIN_MS); }
    s.start_ts_ms = ms; s.start = hhmmIn(ms, tzOf(s)); s.duration_min = Math.round((s.end_ts_ms - s.start_ts_ms) / MIN_MS);
    moved.push({ stop_id: s.id, edge: "start", from_ms: was, to_ms: ms });
  };
  const timed = stops.filter(s => s.start_ts_ms != null && s.end_ts_ms != null).sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  // A stop's edge never moves past a photo the user took there (2026-11-07: a market the
  // user browsed on foot had its start moved to the end of the walk the steps found, 7
  // minutes after the first photo taken at its stalls: browsing is walking, so a walk that
  // runs on into a stop's first minutes is not always the way there). JORI_STEPS_ALIGN_PHOTOS=0: off.
  const photoMs = (s) => (s.photos || []).map(p => Date.parse(p && (p.ts || p.taken_at))).filter(Number.isFinite);
  const startOk = (s, ms) => process.env.JORI_STEPS_ALIGN_PHOTOS === "0" || !photoMs(s).some(t => t < ms);
  const endOk = (s, ms) => process.env.JORI_STEPS_ALIGN_PHOTOS === "0" || !photoMs(s).some(t => t > ms);
  // A walk with no leg under it: two stops the spine joined with nothing between them
  // (the phone took no fix on the hop). The steps still see the walk, which can begin as
  // the first stop ends and run on into the next stop's first minutes: on 2026-11-07 the
  // walk from home to the coffee stop was 7:48-8:04 by the steps, the phone's first rest
  // there began 7:52, and the user's nearby alerts at 7:53 and 8:05 put them still on the
  // way and then at the door. The next stop then starts at the last stride, as it does
  // after a walking leg. JORI_STEPS_ALIGN_HOPS=0: the stops stay as the phone saw them.
  const alignHop = (w) => {
    if (process.env.JORI_STEPS_ALIGN_HOPS === "0") return;
    if (legs.some(l => overlapMs(w.start_ms, w.end_ms, l.start_ms, l.end_ms) > 0)) return;
    const earlyOk = process.env.JORI_STEPS_HOP_EARLY !== "0";
    const i = timed.findIndex(s => Math.abs(s.end_ts_ms - w.start_ms) <= HOP_EDGE_MIN * MIN_MS
      || (earlyOk && s.end_ts_ms > w.start_ms && s.end_ts_ms - w.start_ms <= HOP_EARLY_MIN * MIN_MS));
    const prev = timed[i], next = timed[i + 1];
    if (!prev || !next || prev.excursion || next.excursion) return;
    if (!(next.start_ts_ms >= prev.end_ts_ms && next.start_ts_ms > w.start_ms && next.start_ts_ms < w.end_ms)) return;
    if (w.end_ms - next.start_ts_ms > ALIGN_MAX_MIN * MIN_MS) return;
    if (next.end_ts_ms - w.end_ms < ALIGN_KEEP_MIN * MIN_MS) return;
    if (!startOk(next, w.end_ms)) return;
    setStart(next, w.end_ms);
    const tl = travel.find(t => t.from === prev.id && t.to === next.id);
    if (tl) tl.duration_min = Math.round((next.start_ts_ms - prev.end_ts_ms) / MIN_MS);
  };
  for (const w of walkSpans(series)) {
    const leg = legs.filter(l => l.mode === "walking")
      .map(l => ({ l, o: overlapMs(w.start_ms, w.end_ms, l.start_ms, l.end_ms) }))
      .filter(x => x.o > 0).sort((a, b) => b.o - a.o)[0];
    if (!leg) { alignHop(w); continue; }
    const l = leg.l;
    // The stop left: its end near the leg's start (and before the leg is over).
    // The stop reached: its start near the leg's end (and after the leg began) --
    // the spine's own edges may overlap the leg by a few minutes either way.
    const prev = timed.filter(s => s.end_ts_ms < l.end_ms && s.end_ts_ms >= l.start_ms - LEG_EDGE_MIN * MIN_MS).pop();
    const next = timed.find(s => s !== prev && s.start_ts_ms > l.start_ms && s.start_ts_ms <= l.end_ms + LEG_EDGE_MIN * MIN_MS);
    let changed = false;
    if (prev && !prev.excursion && w.start_ms < prev.end_ts_ms
        && prev.end_ts_ms - w.start_ms <= ALIGN_MAX_MIN * MIN_MS
        && w.start_ms - prev.start_ts_ms >= ALIGN_KEEP_MIN * MIN_MS
        && endOk(prev, w.start_ms)) {
      setEnd(prev, w.start_ms); l.start_ms = w.start_ms; changed = true;
    }
    if (next && !next.excursion && w.end_ms > next.start_ts_ms
        && w.end_ms - next.start_ts_ms <= ALIGN_MAX_MIN * MIN_MS
        && next.end_ts_ms - w.end_ms >= ALIGN_KEEP_MIN * MIN_MS
        && startOk(next, w.end_ms)) {
      setStart(next, w.end_ms); l.end_ms = w.end_ms; changed = true;
    }
    if (!changed) continue;
    l.start = hhmmIn(l.start_ms, tzOf(prev || next)); l.end = hhmmIn(l.end_ms, tzOf(next || prev));
    l.mins = Math.round((l.end_ms - l.start_ms) / MIN_MS);
    l.steps = Math.round(stepsBetween(series, l.start_ms, l.end_ms));
    l.steps_per_min = Math.round(l.steps / Math.max(1, l.mins));
    l.edges_from_steps = true;
    const tl = prev && next && travel.find(t => t.from === prev.id && t.to === next.id);
    if (tl) tl.duration_min = Math.round((next.start_ts_ms - prev.end_ts_ms) / MIN_MS);
  }
  return moved;
}

/**
 * A walk the steps found inside a stop that is really the way to or from a vehicle
 * (2026-11-08): the walk out of a theatre to the cab, 9:05-9:14 under a stop that the
 * phone's silence kept open until 9:18; the walk from the drop-off, 9:30-9:40 under the
 * stop that begins as the ride ends. Such a walk is the travel at that stop's edge, not
 * something done at the stop, and printed under it contradicted the stop's own photos
 * (taken inside at 9:03-9:04) and the leg beside it. It sits at the stop's end with a
 * ride leaving there, or at its start with a ride arriving. A walk in the middle of a
 * stop, or beside a walking leg, is unchanged. JORI_STEPS_EDGE_RIDE=0 turns it off.
 *
 * Only a short walk is that: the way to or from a vehicle is minutes, and a walk longer
 * than WALK_STOP_MAX_MIN that begins as the ride ends is an outing of its own (a half-hour
 * walk from the front door, two minutes after the car stopped, was filed "between stops"
 * and printed nowhere). JORI_STEPS_EDGE_RIDE_CAP=0: no length limit.
 */
function walkIsWayToVehicle(w, stop, legs) {
  if (process.env.JORI_STEPS_EDGE_RIDE === "0") return false;
  if (!stop || stop.start_ts_ms == null || stop.end_ts_ms == null) return false;
  if (process.env.JORI_STEPS_EDGE_RIDE_CAP !== "0" && w.mins > WALK_STOP_MAX_MIN) return false;
  const ride = (l) => l.mode && l.mode !== "walking";
  const leaving = stop.end_ts_ms - w.end_ms <= RIDE_EDGE_TAIL_MIN * MIN_MS && w.end_ms <= stop.end_ts_ms + MIN_MS
    && legs.some(l => ride(l) && Math.abs(l.start_ms - stop.end_ts_ms) <= 2 * MIN_MS);
  const arriving = w.start_ms - stop.start_ts_ms <= RIDE_EDGE_HEAD_MIN * MIN_MS && w.start_ms >= stop.start_ts_ms - MIN_MS
    && legs.some(l => ride(l) && Math.abs(l.end_ms - stop.start_ts_ms) <= 2 * MIN_MS);
  return leaving || arriving;
}

/**
 * A stop that is nothing but the walk between a ride and the next place
 * (2026-11-08): the ride home ended, the phone logged an arrival where the cab
 * stopped and then took one fix and went quiet, and a ten-minute "stop" at a
 * street address two blocks from home was built from it, though the steps show
 * a walk at 87 a minute through all of it and on to the door. It is a short stop
 * nobody named (no confirmed or evidence-settled name, no photo in it), a ride
 * arriving at its start or leaving at its end (not both: arriving and leaving by
 * car is an errand), and one walk the steps found covers most of it and runs on
 * past its far edge. Such a stop is movement: it is not printed, its walk is the
 * travel, and nobody is asked what it was. JORI_STEPS_WALK_STOP=0 turns it off.
 */
const WALK_STOP_MAX_MIN = 15;  // the way to or from a vehicle is short
const WALK_STOP_COVER = 0.8;   // the walk covers this much of the stop
const NAMED_SOURCES = new Set(["user_confirmed", "user_confirmed_via_transcript", "confirmed_stop", "named_location",
  "known_recurring", "wifi_ssid", "accommodation", "saved_place", "photo_text", "calendar_corroborated"]);
function markStopsThatAreTheWalk(resolved, series, legs, stops) {
  if (process.env.JORI_STEPS_WALK_STOP === "0") return [];
  const marked = [];
  const spans = walkSpans(series);
  const ride = (l) => l.mode && l.mode !== "walking";
  for (const s of stops) {
    if (s.start_ts_ms == null || s.end_ts_ms == null || s.excursion || s.is_movement || s.user_non_stop) continue;
    const len = s.end_ts_ms - s.start_ts_ms;
    if (!(len > 0) || len > WALK_STOP_MAX_MIN * MIN_MS) continue;
    const cert = s.provenance && s.provenance.certainty;
    if (NAMED_SOURCES.has((s.place && s.place.source) || "") || ["answered", "known", "corroborated"].includes(cert)) continue;
    if ((s.photos || []).length) continue;
    const rideIn = legs.some(l => ride(l) && Math.abs(l.end_ms - s.start_ts_ms) <= 2 * MIN_MS);
    const rideOut = legs.some(l => ride(l) && Math.abs(l.start_ms - s.end_ts_ms) <= 2 * MIN_MS);
    if (rideIn === rideOut) continue;
    const w = spans.find(x => overlapMs(x.start_ms, x.end_ms, s.start_ts_ms, s.end_ts_ms) >= WALK_STOP_COVER * len
      && (rideIn ? x.end_ms > s.end_ts_ms + MIN_MS : x.start_ms < s.start_ts_ms - MIN_MS));
    if (!w) continue;
    s.is_movement = true;
    s.needs_review = null;
    s.walked_through_by_steps = { start_ms: w.start_ms, end_ms: w.end_ms, steps: w.steps, beside: rideIn ? "ride_in" : "ride_out" };
    marked.push({ id: s.id, name: (s.place && s.place.name) || null, start: s.start, end: s.end, walk_steps: w.steps,
                  beside: rideIn ? "ride_in" : "ride_out" });
  }
  if (marked.length && Array.isArray(resolved.unknown_stops)) {
    const ids = new Set(marked.map(m => m.id));
    resolved.unknown_stops = resolved.unknown_stops.filter(u => !ids.has(u.id));
  }
  return marked;
}

/**
 * Annotate a resolved day in place with what its step readings say.
 * `samples`: health_samples StepCount rows; `dailyTotal`: Apple Health's daily
 * sum (or null). Returns resolved.steps.
 */
function annotateDaySteps(resolved, samples, dailyTotal = null, { startMs, endMs } = {}) {
  const series = stepSeries(samples);
  if (startMs != null) for (const t of [...series.keys()]) if (t < startMs || t >= endMs) series.delete(t);
  const rawTotal = Math.round([...series.values()].reduce((a, b) => a + b, 0));
  const out = {
    total: dailyTotal != null ? Math.round(dailyTotal) : (series.size ? rawTotal : null),
    total_source: dailyTotal != null ? "apple_health_daily" : (series.size ? "raw_readings" : null),
    raw_total: rawTotal,
    readings: (samples || []).length,
    walks: [],
    legs_remoded: [],
  };
  resolved.steps = out;
  if (!series.size) return out;

  // Readings only speak for the hours they cover: on the first day of uploads
  // they may start mid-afternoon, and a morning leg with no readings is not a
  // leg with no steps.
  const times = (samples || []).flatMap(x => [Date.parse(x.start_date), Date.parse(x.end_date)]).filter(Number.isFinite);
  const covFrom = Math.min(...times), covTo = Math.max(...times);
  out.covered = { from_ms: covFrom, to_ms: covTo };
  const covered = (a, b) => a >= covFrom - 30 * MIN_MS && b <= covTo + 30 * MIN_MS;
  out.per_min = perMinute(series);

  const spine = (resolved.path && resolved.path.spine) || [];
  const legs = spine.filter(n => n.type === "leg" && n.start_ms != null && n.end_ms != null);
  // prep re-runs on a day it already annotated: start each leg clean, so a
  // second pass recomputes rather than adds (a walk's count once doubled).
  for (const leg of legs) { delete leg.walk_steps; delete leg.walks; }
  for (const leg of legs) {
    if (!covered(leg.start_ms, leg.end_ms)) continue;
    const steps = stepsBetween(series, leg.start_ms, leg.end_ms);
    const mins = Math.max(1, (leg.end_ms - leg.start_ms) / MIN_MS);
    leg.steps = Math.round(steps);
    leg.steps_per_min = Math.round(steps / mins);
    const re = legModeFromSteps(leg, leg.steps_per_min);
    if (re) {
      out.legs_remoded.push({ id: leg.id, from: leg.mode, to: re.mode, steps_per_min: leg.steps_per_min });
      leg.mode_by_pace = leg.mode;
      leg.mode = re.mode;
      leg.mode_uncertain = re.mode === "riding";
      leg.mode_evidence = [...(leg.mode_evidence || []).filter(e => !/ steps\/min$/.test(e)), `${leg.steps_per_min} steps/min`]; // lang-regex-ok: our own evidence tag
      if (re.walked) leg.walked_m = leg.routed_m || leg.straight_m || leg.walked_m;
      else leg.walked_m = 0;
    } else if (leg.mode === "walking" && leg.walked_m != null && (leg.holes || []).length) {
      // Kept from the first pass, so a second one recomputes rather than adds.
      if (leg.walked_m_by_pace == null) leg.walked_m_by_pace = leg.walked_m;
      const cap = leg.routed_m || leg.straight_m || Infinity;
      leg.walked_m = Math.min(cap, leg.walked_m_by_pace + walkedHoleMetres(leg, series));
    }
  }

  const stops = resolved.stops || [];
  out.stops_aligned = alignStopsToWalks(resolved, series, legs, stops);
  out.stops_walked_through = markStopsThatAreTheWalk(resolved, series, legs, stops);

  for (const s of stops) {
    if (s.excursion && s.start_ts_ms != null && s.end_ts_ms != null) {
      s.excursion.steps = Math.round(stepsBetween(series, s.start_ts_ms, s.end_ts_ms));
    }
  }

  // Each sustained walk, placed. A walk excursion already is the walk (it only
  // lends its count). A walk mostly inside one stop's window is a walk the
  // spine never saw, listed under that stop. Otherwise a walk touching a
  // walking leg is that leg's walk: the steps start before GPS sees the user
  // leave and end after it sees them arrive (a 30-minute walk to a venue whose
  // leg the fixes made 9 minutes), so the leg's line carries the WALK's count,
  // not just the steps inside the leg's own window.
  for (const w of walkSpans(series)) {
    const len = w.end_ms - w.start_ms;
    const exc = stops.find(s => s.excursion && overlapMs(w.start_ms, w.end_ms, s.start_ts_ms, s.end_ts_ms) >= 0.5 * len);
    let stop = null, leg = null;
    if (!exc) {
      // A walk that runs on into a walking leg is that leg's walk unless nearly
      // all of it is inside the stop (otherwise it would print twice: under the
      // stop and again on the travel line).
      const touchesLeg = legs.some(l => l.mode === "walking" && overlapMs(w.start_ms, w.end_ms, l.start_ms, l.end_ms) > 0);
      stop = stops.filter(s => !s.excursion && s.start_ts_ms != null)
        .map(s => ({ s, o: overlapMs(w.start_ms, w.end_ms, s.start_ts_ms, s.end_ts_ms) }))
        .sort((a, b) => b.o - a.o)[0];
      stop = stop && stop.o >= (touchesLeg ? 0.8 : 0.5) * len ? stop.s : null;
      if (stop && walkIsWayToVehicle(w, stop, legs)) stop = null;
    }
    if (!exc && !stop) {
      leg = legs.filter(l => l.mode === "walking")
        .map(l => ({ l, o: overlapMs(w.start_ms, w.end_ms, l.start_ms, l.end_ms) }))
        .filter(x => x.o > 0).sort((a, b) => b.o - a.o)[0];
      leg = leg ? leg.l : null;
      if (leg) {
        leg.walk_steps = (leg.walk_steps || 0) + w.steps;
        leg.walks = [...(leg.walks || []), { start_ms: w.start_ms, end_ms: w.end_ms, mins: w.mins, steps: w.steps }];
      }
    }
    out.walks.push({
      ...w,
      kind: leg ? "leg" : exc ? "excursion" : stop ? "in_stop" : "between",
      leg_id: leg ? leg.id : null,
      stop_id: exc ? exc.id : stop ? stop.id : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A silent phone is stillness only when the steps agree (2026-11-16)
// ---------------------------------------------------------------------------
//
// The spine reads a silence as stillness: a still phone stops emitting, so a
// stretch with no fixes inside one stop, with the stop's place on both sides,
// is filled as that place. That is wrong when the user left the phone behind
// and went out. In the case that built this the phone logged nothing for two
// and a half hours, its last fix before and first fix after were both at home,
// and the day said "home" all morning, while the Watch counted a walk out, an
// hour and a half nearly still, and a walk back: the user had been at a café.
//
// So a silence of at least `gap_min` minutes inside one stop, bounded by two of
// its fixes, is read against the steps. A walking burst in it (`burst_steps`
// within any `burst_window_min`, every device's readings merged as stepSeries
// merges them) is a walk AWAY when one device that was counting steps on both
// sides of it counted almost none during it: the phone stayed put while the
// user walked. A walk every device counted is the user moving with the phone
// while its GPS was quiet (getting up at a show, walking a terminal, pacing at
// home): measured over a week of real days, every silence with walking in it
// but the one that built this was that, and treating them as moves turned a
// two-hour show into "place unknown". `phone_sources` (step source ids) names
// the phone when the installation knows it; otherwise any counting device may
// witness. From the first walk away to the last walk in the silence the user
// was somewhere else: the stop gives that span up and it becomes a stop of its
// own, place unknown. After the last walk the user was still, and the next fix
// is at the stop's place, so the place resumes. Step batches are timed to about
// `edge_tolerance_min`: a span that close to the silence's edge runs to the
// edge's fix. A span under `min_moved_min` is a quick step out and stays inside
// the stop (its walk is listed there, as before). Only a silence with no walk
// away in it stays the stop's place. Code owns all of it (Rule #0b): no words
// are read and no model is asked; the step readings never leave this process.
const SILENT_GAP_DEFAULTS = Object.freeze({
  gap_min: 20,
  burst_steps: 150,
  burst_window_min: 10,
  edge_tolerance_min: 10,
  min_moved_min: 15,
  // A witness counted no more than this during the walk (steps, or share of the walk's).
  witness_still_steps: 30,
  witness_still_share: 0.1,
  // ...and counted something within this many hours on both sides of it.
  witness_active_h: 3,
  // The follow-up's shortlist: places the user named before, this close to where
  // the silence began, at about this hour of the day.
  candidate_radius_m: 800,
  candidate_hours: 2,
  max_candidates: 3,
});

function silentGapConfig(overrides = null) {
  let cfg = { ...SILENT_GAP_DEFAULTS, phone_sources: [] };
  try { cfg = require("./instance.cjs").localConfig("silent-gap-steps", cfg); } catch { /* generic defaults */ }
  if (overrides) cfg = { ...cfg, ...overrides };
  for (const k of Object.keys(SILENT_GAP_DEFAULTS)) {
    if (!Number.isFinite(Number(cfg[k]))) cfg[k] = SILENT_GAP_DEFAULTS[k];
    else cfg[k] = Number(cfg[k]);
  }
  cfg.phone_sources = Array.isArray(cfg.phone_sources) ? cfg.phone_sources.filter(x => typeof x === "string" && x) : [];
  return cfg;
}

/**
 * Walking bursts in a de-duplicated per-minute series: [{start_ms, end_ms, steps}].
 * A minute is walking when some `windowMin` window holding it has at least
 * `burstSteps` steps AND the minute itself runs at that window's cadence, so a
 * few steps just before a walk do not stretch it. Bursts closer than one window
 * apart are one.
 */
function stepBursts(series, { burst_steps: burstSteps = SILENT_GAP_DEFAULTS.burst_steps,
  burst_window_min: windowMin = SILENT_GAP_DEFAULTS.burst_window_min } = {}) {
  const mins = [...(series || new Map())].filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const W = windowMin * MIN_MS;
  const cadence = burstSteps / windowMin;
  const walking = new Set();
  for (let i = 0; i < mins.length; i++) {
    let sum = 0;
    let k = i;
    for (; k < mins.length && mins[k][0] < mins[i][0] + W; k++) sum += mins[k][1];
    if (sum < burstSteps) continue;
    for (let j = i; j < k; j++) if (mins[j][1] >= cadence) walking.add(mins[j][0]);
  }
  const spans = [];
  for (const t of [...walking].sort((a, b) => a - b)) {
    const last = spans[spans.length - 1];
    if (last && t - last.end_ms <= W) last.end_ms = t + MIN_MS;
    else spans.push({ start_ms: t, end_ms: t + MIN_MS });
  }
  for (const w of spans) w.steps = stepsBetween(series, w.start_ms, w.end_ms);
  return spans;
}

function metresBetween(a, b) {
  if (![a && a.lat, a && a.lon, b && b.lat, b && b.lon].every(Number.isFinite)) return null;
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Visit rows are not fixes: their times can be written later (a sweeper, a
// day-segments row), and a CLVisit arrival is a summary of fixes, not one.
const isFix = (p) => p && p.kind !== "visit" && Number.isFinite(p.ts);

const anyStepsIn = (m, fromMs, toMs) => { for (const [t, v] of m) if (v > 0 && t + MIN_MS > fromMs && t < toMs) return true; return false; };

/**
 * Did a device stay put through this walk? A witness counted (almost) nothing in
 * the walk's minutes, give or take the batch tolerance. When the installation
 * names the phone (`phone_sources`) and it counted that day, only the phone
 * witnesses: it carries the GPS, so its stillness is the whole question (and a
 * Watch on its charger while the user paces with the phone is not a move).
 * Otherwise any device may, if it counted something within `witness_active_h`
 * on both sides of the walk (a device nobody had on that morning proves nothing).
 */
function walkedAway(w, bySource, silence, cfg) {
  const tol = cfg.edge_tolerance_min * MIN_MS;
  const H = cfg.witness_active_h * 3600e3;
  const phones = cfg.phone_sources.filter(id => bySource.has(id));
  const stillMax = Math.max(cfg.witness_still_steps, cfg.witness_still_share * (w.steps || 0));
  const still = (m) => stepsBetween(m, w.start_ms - tol, w.end_ms + tol) <= stillMax;
  if (phones.length) return phones.some(id => still(bySource.get(id)));
  return [...bySource.values()].some(m => still(m)
    && anyStepsIn(m, silence.from_ms - H, w.start_ms - tol) && anyStepsIn(m, w.end_ms + tol, silence.to_ms + H));
}

/**
 * The silences inside one stop and what the steps say about each:
 * [{ from_ms, to_ms, minutes, ends_m, verdict, moved_from_ms?, moved_to_ms?, walks? }].
 * verdict: "moved" (the stop gives the span up), "moved_briefly" (a walk away,
 * but the span is under min_moved_min), "walked_with_every_device" (walking that
 * every device counted: the phone went along, its GPS was only quiet), "still"
 * (readings on both sides, no walking), "no_step_readings" (the readings do not
 * reach across it). Only "moved" changes the day.
 */
function silencesInStop(stop, pings, ctx, cfg) {
  const { bursts, bySource, coverage } = ctx;
  const tol = cfg.edge_tolerance_min * MIN_MS;
  const gapMs = cfg.gap_min * MIN_MS;
  const a = stop.start_ts_ms - tol, b = stop.end_ts_ms + tol;
  const fixes = (pings || []).filter(p => isFix(p) && p.ts >= a && p.ts <= b).sort((x, y) => x.ts - y.ts);
  const out = [];
  for (let i = 0; i + 1 < fixes.length; i++) {
    const p0 = fixes[i], p1 = fixes[i + 1];
    if (p1.ts - p0.ts < gapMs) continue;
    const endsM = metresBetween(p0, p1);
    const rec = { from_ms: p0.ts, to_ms: p1.ts, minutes: Math.round((p1.ts - p0.ts) / MIN_MS),
                  ends_m: endsM == null ? null : Math.round(endsM) };
    const inGap = bursts.filter(w => w.end_ms > p0.ts && w.start_ms < p1.ts);
    if (!inGap.length) {
      rec.verdict = coverage && coverage.from_ms <= p0.ts && coverage.to_ms >= p1.ts ? "still" : "no_step_readings";
      out.push(rec);
      continue;
    }
    rec.walks = inGap.map(w => ({ start_ms: Math.max(w.start_ms, p0.ts), end_ms: Math.min(w.end_ms, p1.ts),
                                  away: walkedAway(w, bySource, rec, cfg) }));
    const firstAway = rec.walks.find(w => w.away);
    if (!firstAway) { rec.verdict = "walked_with_every_device"; out.push(rec); continue; }
    let from = firstAway.start_ms;
    let to = rec.walks[rec.walks.length - 1].end_ms;
    if (from - p0.ts <= tol) from = p0.ts;
    if (p1.ts - to <= tol) to = p1.ts;
    from = Math.max(from, stop.start_ts_ms);
    to = Math.min(to, stop.end_ts_ms);
    rec.moved_from_ms = from;
    rec.moved_to_ms = to;
    rec.verdict = to - from >= cfg.min_moved_min * MIN_MS ? "moved" : "moved_briefly";
    out.push(rec);
  }
  return out;
}

/**
 * Cut every named stop around the silences the steps say the user moved in.
 * Returns { stops, silences, split }:
 *   stops     the new list, in time order (each moved span is a stop of its own:
 *             place unknown, or the user's own answer for that window);
 *   silences  every silence checked, with its verdict (the day JSON's record);
 *   split     one entry per stop cut.
 * opts:
 *   config       silentGapConfig() values (defaults otherwise)
 *   hm(ms, stop) "HH:MM" for a time, in that stop's zone
 *   minPieceMin  a piece of the old stop shorter than this goes (default 10)
 *   answerFor(span, stop)     the user's answers for windows inside the span ([] or null when none):
 *                             [{ name, lat, lon, start_ms, end_ms, address?, ask_id?, companions? }]
 *   candidatesFor(span, stop) a shortlist for the follow-up: [{ name, distance_m }]
 */
function splitStopsOnMovedSilence(stops, pings, samples, opts = {}) {
  const cfg = opts.config || silentGapConfig();
  const hm = opts.hm || ((ms) => hhmmIn(ms, "UTC"));
  const minPiece = (opts.minPieceMin ?? 10) * MIN_MS;
  const result = { stops: stops || [], silences: [], split: [] };
  if (!(stops || []).length) return result;
  const series = stepSeries(samples);
  if (!series.size) return result;
  const times = (samples || []).flatMap(x => [Date.parse(x.start_date), Date.parse(x.end_date)]).filter(Number.isFinite);
  const ctx = { bursts: stepBursts(series, cfg), bySource: sourceSeries(samples),
                coverage: { from_ms: Math.min(...times), to_ms: Math.max(...times) } };

  const out = [];
  for (const s of stops) {
    const eligible = s && s.place && s.place.name
      && Number.isFinite(s.start_ts_ms) && Number.isFinite(s.end_ts_ms)
      && !s.excursion && !s.is_movement && !s.user_non_stop && !s.from_saved_at && !s.moved_place_unknown;
    if (!eligible) { out.push(s); continue; }
    const checked = silencesInStop(s, pings, ctx, cfg);
    for (const c of checked) result.silences.push({ stop_id: s.id, name: s.place.name, ...c });
    const moved = checked.filter(c => c.verdict === "moved");
    if (!moved.length) { out.push(s); continue; }

    const pieces = [];
    let cursor = s.start_ts_ms;
    let pieceNo = 0;
    const keepPiece = (from, to) => {
      if (to - from < minPiece) return;
      const id = pieceNo === 0 ? s.id : `${s.id}-r${pieceNo}`;
      pieceNo += 1;
      pieces.push({ ...s, id, start_ts_ms: from, end_ts_ms: to, start: hm(from, s), end: hm(to, s),
                    duration_min: Math.round((to - from) / MIN_MS), photos: [], cut_for_moved_silence: true });
    };
    moved.forEach((m, k) => {
      keepPiece(cursor, m.moved_from_ms);
      const span = { from_ms: m.moved_from_ms, to_ms: m.moved_to_ms, silence: { from_ms: m.from_ms, to_ms: m.to_ms }, walks: m.walks };
      const base = { cut_from: s.id, companions: [], photos: [], alternatives: [],
                     pattern: "dwell", calendar_event: null, ...(s.tz ? { tz: s.tz } : {}) };
      // The user's own answers for windows inside the span, in time order, never overlapping.
      let answers = opts.answerFor ? opts.answerFor(span, s) : null;
      answers = (Array.isArray(answers) ? answers : answers ? [answers] : [])
        .filter(a => a && a.name)
        .map(a => ({ a, from: Math.max(span.from_ms, Number.isFinite(a.start_ms) ? a.start_ms : span.from_ms),
                          to: Math.min(span.to_ms, Number.isFinite(a.end_ms) ? a.end_ms : span.to_ms) }))
        .filter(x => x.to > x.from)
        .sort((x, y) => x.from - y.from)
        .reduce((kept, x) => (kept.length && x.from < kept[kept.length - 1].to ? kept : [...kept, x]), []);
      if (answers.length) {
        answers.forEach(({ a, from, to }, j) => {
          pieces.push({ ...base, id: `${s.id}-m${k + 1}${answers.length > 1 ? `-${j + 1}` : ""}`,
                        start_ts_ms: from, end_ts_ms: to, start: hm(from, s), end: hm(to, s),
                        duration_min: Math.round((to - from) / MIN_MS),
                        lat: Number.isFinite(a.lat) ? a.lat : null, lon: Number.isFinite(a.lon) ? a.lon : null,
                        companions: Array.isArray(a.companions) ? a.companions.filter(Boolean) : [],
                        place: { name: a.name, source: "user_confirmed", confidence: 1, address: a.address || null },
                        from_confirmed_visit: true, ...(a.ask_id ? { from_saved_at: a.ask_id } : {}),
                        answered_moved_silence: { from_place: s.place.name, ...span } });
        });
      } else {
        pieces.push({ ...base, id: `${s.id}-m${k + 1}`, start_ts_ms: span.from_ms, end_ts_ms: span.to_ms,
                      start: hm(span.from_ms, s), end: hm(span.to_ms, s),
                      duration_min: Math.round((span.to_ms - span.from_ms) / MIN_MS),
                      // No position: the phone saw nothing, and the place on either side
                      // is the very place this span is NOT (a point there would let the
                      // naming rungs name it after the stop it was cut from).
                      lat: null, lon: null,
                      place: { name: null, source: "moved_place_unknown", confidence: 0, address: null },
                      moved_place_unknown: { from_place: s.place.name, ...span,
                        candidates: opts.candidatesFor ? (opts.candidatesFor(span, s) || []) : [] } });
      }
      cursor = Math.max(cursor, m.moved_to_ms);
    });
    keepPiece(cursor, s.end_ts_ms);
    // Every photo of the old stop goes on the piece whose window holds it, else the
    // nearest in time: a piece dropped for being short never takes a photo with it.
    for (const ph of s.photos || []) {
      const t = Date.parse(ph && (ph.ts || ph.taken_at));
      const gap = (p) => (!Number.isFinite(t) ? 0 : t < p.start_ts_ms ? p.start_ts_ms - t : t > p.end_ts_ms ? t - p.end_ts_ms : 0);
      const home = pieces.reduce((best, p) => (!best || gap(p) < gap(best) ? p : best), null);
      if (home) home.photos.push(ph);
    }
    out.push(...pieces);
    result.split.push({ id: s.id, name: s.place.name, was: `${s.start}–${s.end}`,
      now: pieces.map(p => `${p.start}–${p.end} ${p.place && p.place.name ? p.place.name : "place unknown"}`) });
  }
  result.stops = out.sort((x, y) => (x.start_ts_ms ?? 0) - (y.start_ts_ms ?? 0));
  return result;
}

/** The day's StepCount readings in [fromMs, toMs), through a PostgREST `request`. */
async function fetchStepSamples(fromMs, toMs, request) {
  const s = encodeURIComponent(new Date(fromMs).toISOString());
  const e = encodeURIComponent(new Date(toMs).toISOString());
  const samples = [];
  for (let off = 0; off < 50000; off += 1000) {
    const page = await request(`/rest/v1/health_samples?select=start_date,end_date,value,source_name,source_bundle_id`
      + `&hk_type=eq.HKQuantityTypeIdentifierStepCount&start_date=gte.${s}&start_date=lt.${e}`
      + `&order=start_date.asc,hk_uuid.asc&limit=1000&offset=${off}`) || [];
    samples.push(...page);
    if (page.length < 1000) break;
  }
  return samples;
}

/** Fetch the day's readings + Apple Health's daily total, then annotate. */
async function attachDaySteps(resolved, win, request) {
  const samples = await fetchStepSamples(win.startMs, win.endMs, request);
  // The phone buckets its daily sum at ITS midnight; when travelling that can
  // sit hours from ours, so take the bucket nearest this day's start.
  const lo = encodeURIComponent(new Date(win.startMs - 12 * 3600e3).toISOString());
  const hi = encodeURIComponent(new Date(win.startMs + 12 * 3600e3).toISOString());
  const agg = await request(`/rest/v1/health_aggregates?select=value,bucket_start,updated_at`
    + `&hk_type=eq.HKQuantityTypeIdentifierStepCount&granularity=eq.daily&stat=eq.sum`
    + `&bucket_start=gte.${lo}&bucket_start=lt.${hi}&order=updated_at.desc&limit=1`) || [];
  return annotateDaySteps(resolved, samples, agg.length ? Number(agg[0].value) : null, win);
}

module.exports = {
  stepSeries, stepsBetween, stepsInWindow, walkSpans, legModeFromSteps, annotateDaySteps, attachDaySteps,
  sourceSeries, stepBursts, silencesInStop, splitStopsOnMovedSilence, silentGapConfig, fetchStepSamples, SILENT_GAP_DEFAULTS,
  _consts: { WALK_MIN_STEPS, WALK_GAP_MIN, WALK_MIN_MIN, WALK_MIN_TOTAL, LEG_MODE_MIN, LEG_RIDDEN_SPM, LEG_WALKED_SPM },
};
