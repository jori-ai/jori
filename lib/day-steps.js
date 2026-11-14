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

/** Per-minute steps, de-duplicated across sources: Map<minuteMs, steps>. */
function stepSeries(samples) {
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
 */
function walkIsWayToVehicle(w, stop, legs) {
  if (process.env.JORI_STEPS_EDGE_RIDE === "0") return false;
  if (!stop || stop.start_ts_ms == null || stop.end_ts_ms == null) return false;
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

/** Fetch the day's readings + Apple Health's daily total, then annotate. */
async function attachDaySteps(resolved, win, request) {
  const s = encodeURIComponent(new Date(win.startMs).toISOString());
  const e = encodeURIComponent(new Date(win.endMs).toISOString());
  const samples = [];
  for (let off = 0; off < 50000; off += 1000) {
    const page = await request(`/rest/v1/health_samples?select=start_date,end_date,value,source_name,source_bundle_id`
      + `&hk_type=eq.HKQuantityTypeIdentifierStepCount&start_date=gte.${s}&start_date=lt.${e}`
      + `&order=start_date.asc,hk_uuid.asc&limit=1000&offset=${off}`) || [];
    samples.push(...page);
    if (page.length < 1000) break;
  }
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
  _consts: { WALK_MIN_STEPS, WALK_GAP_MIN, WALK_MIN_MIN, WALK_MIN_TOTAL, LEG_MODE_MIN, LEG_RIDDEN_SPM, LEG_WALKED_SPM },
};
