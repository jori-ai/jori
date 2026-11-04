"use strict";
// day-overlay — a stored day with the user's corrections layered on top, at
// READ time. The stored day itself is never rewritten.
//
// The requirement: when the user corrects a day, keep the original and add
// the corrections on top; every reader (chat's "where were we Saturday
// morning?", summaries, recall) reads the corrected version first; the
// live-accuracy measurement keeps comparing against the original.
//
// Why both have to survive. Once the morning café was named as the rental the
// user was staying at, and the afternoon was really a dog walk at the port.
// The email was fixed and reissued, but the live-day archive
// (data/live-day-archive/<date>.json, what Jori believed during the day) still
// said the rental. That archive is also what `live-day accuracy` grades
// against the user's answers, which is how the bug was found; rewriting it
// with the corrections would grade every corrected day 1.0. So the archive
// stays as it was, and this module builds the corrected view whenever someone
// asks about the day.
//
// The corrections are the user's own stores, read here and never interpreted:
//   - the user's answers on visit rows: location_history `place_type='user-confirmed'`
//     (findme resolve / location-confirm), which name a window;
//   - the user's words about a day: data/day-corrections/<date>.jsonl
//     (`bin/day-correction`, written by the email turn and the daily-
//     summary fix loop), each with the window the recording model chose.
// Code only anchors them by time and distance (Rule #0b); what a sentence
// establishes stays the reader's call, so it travels verbatim.

const path = require("node:path");

// A window he named replaces the interval's name only when the two are the same
// stretch: they share at least half of the shorter window.
const NAME_SHARE = 0.5;

function readDayCorrections(date, dir) {
  const { readCorrections } = require(path.join(__dirname, "daily-summary-harvest.js"));
  return dir ? readCorrections(date, dir) : readCorrections(date);
}

const msOf = (iso) => (iso ? Date.parse(iso) : NaN);

/** His words whose window touches [startMs, endMs), verbatim. Pure. */
function correctionsTouching(corrections, startMs, endMs) {
  const out = [];
  for (const c of corrections || []) {
    const a = msOf(c.applies_from), b = msOf(c.applies_to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b > startMs && a < endMs) {
      out.push({ text: c.text, said_at: c.said_at || null, channel: c.channel || null,
        window: { from: c.applies_from, to: c.applies_to }, ...(c.reading ? { reading: c.reading } : {}) });
    }
  }
  return out;
}

/** Corrections no interval/stop of the day took (no window, or none touched). */
function unanchored(corrections, spans) {
  return (corrections || []).filter((c) => {
    const a = msOf(c.applies_from), b = msOf(c.applies_to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    return !spans.some(([s, e]) => b > s && a < e);
  }).map((c) => ({ text: c.text, said_at: c.said_at || null, channel: c.channel || null,
    ...(c.applies_from ? { window: { from: c.applies_from, to: c.applies_to } } : {}),
    ...(c.reading ? { reading: c.reading } : {}) }));
}

/** The user-confirmed row that IS this interval (most shared minutes), or null. */
function answerFor(startMs, endMs, confirmations) {
  let best = null, bestOv = 0;
  for (const r of confirmations || []) {
    if (r.place_type !== "user-confirmed" || !r.place_name) continue;
    const a = msOf(r.arrived_at), b = msOf(r.departed_at);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    const ov = Math.min(b, endMs) - Math.max(a, startMs);
    if (ov <= 0 || ov < NAME_SHARE * Math.min(b - a, endMs - startMs)) continue;
    if (ov > bestOv) { best = r; bestOv = ov; }
  }
  return best;
}

/**
 * The live-day record (an archived day, or today's) with his corrections on
 * top. Returns a NEW object; `day` is untouched, so the caller can still hand
 * the original to `computeAccuracy`. Each interval he corrected keeps what we
 * believed as `original_place`. Pure.
 */
function correctedLiveDay(day, { confirmations = [], corrections = [] } = {}) {
  if (!day) return day;
  const intervals = (day.intervals || []).map((i) => {
    const s = Number.isFinite(i.start_ts_ms) ? i.start_ts_ms : msOf(i.start);
    const e = Number.isFinite(i.end_ts_ms) ? i.end_ts_ms : msOf(i.end);
    const out = { ...i };
    const ans = Number.isFinite(s) && Number.isFinite(e) ? answerFor(s, e, confirmations) : null;
    if (ans && !(i.place && i.place.source === "user_confirmed" && i.place.name === ans.place_name)) {
      out.original_place = i.place || null;
      out.place = { name: ans.place_name, source: "user_confirmed", confidence: 1,
        lat: ans.latitude ?? null, lon: ans.longitude ?? null, row_id: ans.id };
      out.corrected_by = "his_answer";
    }
    const words = Number.isFinite(s) && Number.isFinite(e) ? correctionsTouching(corrections, s, e) : [];
    if (words.length) out.his_corrections = words;
    return out;
  });
  const spans = intervals.map((i) => [Number.isFinite(i.start_ts_ms) ? i.start_ts_ms : msOf(i.start),
    Number.isFinite(i.end_ts_ms) ? i.end_ts_ms : msOf(i.end)]);
  const loose = unanchored(corrections, spans);
  return {
    ...day,
    intervals,
    view: "corrected",
    corrections_applied: intervals.filter((i) => i.corrected_by).length,
    ...(loose.length ? { his_corrections_unanchored: loose } : {}),
    original_note: "intervals[].original_place is what Jori believed at the time; the stored record is unchanged (live-day day <date> --original)",
  };
}

/**
 * resolve-day output (location-day) with his words about the day attached.
 * resolve-day already reads his answers off the rows, so only the
 * day-corrections sentences are added: per stop as `his_corrections`, the rest
 * as `his_day_corrections`. They outrank the stop's own title. Pure.
 */
function correctedResolvedDay(resolved, corrections = []) {
  if (!resolved || !Array.isArray(resolved.stops) || !(corrections || []).length) return resolved;
  const stops = resolved.stops.map((s) => {
    const words = correctionsTouching(corrections, s.start_ts_ms, s.end_ts_ms);
    return words.length ? { ...s, his_corrections: words } : s;
  });
  const loose = unanchored(corrections, stops.map((s) => [s.start_ts_ms, s.end_ts_ms]));
  return {
    ...resolved,
    stops,
    view: "corrected",
    his_day_corrections: (corrections || []).map((c) => ({ text: c.text, said_at: c.said_at || null,
      channel: c.channel || null, ...(c.applies_from ? { window: { from: c.applies_from, to: c.applies_to } } : {}),
      ...(c.reading ? { reading: c.reading } : {}) })),
    ...(loose.length ? { his_corrections_unanchored: loose } : {}),
  };
}

module.exports = { readDayCorrections, correctedLiveDay, correctedResolvedDay, correctionsTouching, NAME_SHARE };
