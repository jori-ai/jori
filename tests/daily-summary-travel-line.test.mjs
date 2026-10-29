// daily-summary-travel-line.test.mjs — the line between two stops gives the
// distance the trace covered, not the straight line between the stops' points.
//
// 2026-10-16, Old Port: the 4:43am drive to Ben Gurion to pick Noa up and back to
// the flat printed "56 min (233 m) to next." Both ends were the flat, so the
// straight line was 233 m; the spine's leg (driving, 34.6 km, not street-matched)
// was right there.
//
// Run: node --test tests/daily-summary-travel-line.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _internal } = require("../lib/daily-summary-render.js");
const { travelHtml } = _internal;

const U = (hms) => Date.parse(`2026-10-16T${hms}Z`);
const flatNight = { id: "s-a", end: "04:43", end_ts_ms: U("01:43:10"), tz: "Asia/Jerusalem" };
const flatMorning = { id: "s-b", start: "05:39", start_ts_ms: U("02:39:30"), tz: "Asia/Jerusalem" };
const leg = { from: "s-a", to: "s-b", duration_min: 56, distance_km: 0.233, mode: null };
const spineLeg = (extra = {}) => ({ type: "leg", id: "l0", mode: "driving", mode_uncertain: false,
  start_ms: U("01:43:10"), end_ms: U("02:39:30"), routed_m: 0, straight_m: 34568, geometry: "straight_line", ...extra });
const day = (legs) => ({ date: "2026-10-16", tz: "Asia/Jerusalem", path: { spine: legs } });
const text = (html) => html.replace(/<[^>]+>/g, "");

test("an out-and-back drive reads the trace's distance, as a floor, with its mode", () => {
  const line = text(travelHtml(leg, flatNight, flatMorning, day([spineLeg()])));
  assert.match(line, /Drove 56 min \(at least 34\.6 km\) to next\./);
  assert.doesNotMatch(line, /233 m/);
});

test("a street-matched leg is a measurement, not a floor", () => {
  const line = text(travelHtml(leg, flatNight, flatMorning, day([spineLeg({ routed_m: 33100, geometry: "map_matched" })])));
  assert.match(line, /Drove 56 min \(33\.1 km\) to next\./);
});

test("an uncertain ride keeps the mode-neutral line", () => {
  const line = text(travelHtml(leg, flatNight, flatMorning, day([spineLeg({ mode: "riding", mode_uncertain: true })])));
  assert.match(line, /· 56 min \(at least 34\.6 km\) to next\./);
  assert.doesNotMatch(line, /Drove/);
});

test("with no spine leg the old straight-line figure stands", () => {
  const line = text(travelHtml(leg, flatNight, flatMorning, day([])));
  assert.match(line, /56 min \(233 m\) to next\./);
});

test("a street match far shorter than the leg's straight line is a floor at the straight line", () => {
  // 2026-10-17 rebuild: Nana's to August matched 623 m of a 4.9 km drive.
  const a = { id: "s-c", end: "17:48", end_ts_ms: U("14:48:36"), tz: "Asia/Jerusalem" };
  const b = { id: "s-d", start: "17:57", start_ts_ms: U("14:57:27"), tz: "Asia/Jerusalem" };
  const l2 = spineLeg({ id: "l2", start_ms: U("14:48:36"), end_ms: U("14:57:27"), routed_m: 623, straight_m: 4929, geometry: "map_matched" });
  const line = text(travelHtml({ from: "s-c", to: "s-d", duration_min: 9, distance_km: 4.776 }, a, b, day([l2])));
  assert.match(line, /Drove 9 min \(at least 4\.9 km\) to next\./);
  process.env.JORI_TRAVEL_PARTIAL_FLOOR = "0";
  try {
    assert.match(text(travelHtml({ from: "s-c", to: "s-d", duration_min: 9, distance_km: 4.776 }, a, b, day([l2]))), /\(623 m\)/);
  } finally { delete process.env.JORI_TRAVEL_PARTIAL_FLOOR; }
});

test("each half of a drive around a stop inside it keeps the drive's mode, at least the straight line", () => {
  // The Ben Gurion pickup 05:02-05:18 sits inside the 04:43-05:39 leg.
  const airport = { id: "s-a1", start: "05:02", start_ts_ms: U("02:02:16"), end: "05:18", end_ts_ms: U("02:18:48"), tz: "Asia/Jerusalem" };
  const out = text(travelHtml({ from: "s-a", to: "s-a1", duration_min: 19, distance_km: 12.508 }, flatNight, airport, day([spineLeg()])));
  assert.match(out, /Drove 19 min \(at least 12\.5 km\) to next\./);
  const back = text(travelHtml({ from: "s-a1", to: "s-b", duration_min: 21, distance_km: 12.477 }, airport, flatMorning, day([spineLeg()])));
  assert.match(back, /Drove 21 min \(at least 12\.5 km\) to next\./);
});

test("a gap does not claim a drive that runs through the stop before it", () => {
  // 2026-10-24: the 22:11-23:08 drive home ran through the drop-off at Nana's,
  // 22:29-22:34, a stop the spine never saw; Nana's to the flat printed all 24 km.
  const V = (hms) => Date.parse(`2026-10-23T${hms}Z`);
  const riki = { id: "s-4", start_ts_ms: V("16:27:00"), end: "21:59", end_ts_ms: V("18:59:00"), tz: "Asia/Jerusalem" };
  const nana = { id: "s-a2", start: "22:29", start_ts_ms: V("19:29:00"), end: "22:34", end_ts_ms: V("19:34:00"), tz: "Asia/Jerusalem" };
  const flat = { id: "s-5", start: "23:08", start_ts_ms: V("20:08:00"), end_ts_ms: V("21:00:00"), tz: "Asia/Jerusalem" };
  const home = spineLeg({ id: "l3", mode: "riding", mode_uncertain: true, start_ms: V("19:11:00"), end_ms: V("20:08:00"), routed_m: 0, straight_m: 23981 });
  const back = text(travelHtml({ from: "s-a2", to: "s-5", duration_min: 34, distance_km: 8.6 }, nana, flat, day([home])));
  assert.match(back, /34 min \(at least 8\.6 km\) to next\./);
  assert.doesNotMatch(back, /24\.0 km/);
  const there = text(travelHtml({ from: "s-4", to: "s-a2", duration_min: 30, distance_km: 10.5 }, riki, nana, day([home])));
  assert.match(there, /30 min \(10\.5 km\) to next\./);   // under half the leg: unchanged
  process.env.JORI_TRAVEL_THROUGH_STOP = "0";
  try {
    assert.match(text(travelHtml({ from: "s-a2", to: "s-5", duration_min: 34, distance_km: 8.6 }, nana, flat, day([home]))), /at least 24\.0 km/);
  } finally { delete process.env.JORI_TRAVEL_THROUGH_STOP; }
});
