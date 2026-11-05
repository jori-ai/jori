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

/** What the steps say about a leg's mode, or null when they say nothing new. */
function legModeFromSteps(leg, spm) {
  if (!(leg.mins >= LEG_MODE_MIN) || spm == null) return null;
  if (leg.mode === "walking" && spm < LEG_RIDDEN_SPM) return { mode: "riding", walked: false };
  if ((leg.mode === "riding" || leg.mode_uncertain) && spm >= LEG_WALKED_SPM
      && (leg.median_kmh == null || leg.median_kmh <= LEG_WALKED_MAX_KMH)) return { mode: "walking", walked: true };
  return null;
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

  const spine = (resolved.path && resolved.path.spine) || [];
  const legs = spine.filter(n => n.type === "leg" && n.start_ms != null && n.end_ms != null);
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
      leg.mode_evidence = [...(leg.mode_evidence || []), `${leg.steps_per_min} steps/min`];
      if (re.walked) leg.walked_m = leg.routed_m || leg.straight_m || leg.walked_m;
      else leg.walked_m = 0;
    }
  }

  const stops = resolved.stops || [];
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
      stop = stops.filter(s => !s.excursion && s.start_ts_ms != null)
        .map(s => ({ s, o: overlapMs(w.start_ms, w.end_ms, s.start_ts_ms, s.end_ts_ms) }))
        .sort((a, b) => b.o - a.o)[0];
      stop = stop && stop.o >= 0.5 * len ? stop.s : null;
    }
    if (!exc && !stop) {
      leg = legs.filter(l => l.mode === "walking")
        .map(l => ({ l, o: overlapMs(w.start_ms, w.end_ms, l.start_ms, l.end_ms) }))
        .filter(x => x.o > 0).sort((a, b) => b.o - a.o)[0];
      leg = leg ? leg.l : null;
      if (leg) leg.walk_steps = (leg.walk_steps || 0) + w.steps;
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
  stepSeries, stepsBetween, walkSpans, legModeFromSteps, annotateDaySteps, attachDaySteps,
  _consts: { WALK_MIN_STEPS, WALK_GAP_MIN, WALK_MIN_MIN, WALK_MIN_TOTAL, LEG_MODE_MIN, LEG_RIDDEN_SPM, LEG_WALKED_SPM },
};
