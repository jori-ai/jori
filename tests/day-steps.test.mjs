// day-steps.test.mjs — raw step readings read against the location spine.
//
// Requirement: the daily summary uses the day's raw step readings to tell
// walking from riding, to find short walks GPS never saw (a walk from home
// while the spine says "Home"), and to carry steps on walks and the day.
//
// Run: node --test tests/day-steps.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stepSeries, walkSpans, annotateDaySteps } = require("../lib/day-steps.js");
const { buildSkeleton, buildMarkdown } = require("../lib/daily-summary-render.js");

const T0 = Date.parse("2026-03-02T05:00:00Z"); // 00:00 New York
const at = (h, m = 0) => T0 + (h * 60 + m) * 60000;
const iso = (ms) => new Date(ms).toISOString();
// `perMin` steps every minute from a to b, as 5-minute samples from one source.
function readings(a, b, perMin, src = "com.apple.health.watch") {
  const out = [];
  for (let t = a; t < b; t += 5 * 60000) {
    const e = Math.min(b, t + 5 * 60000);
    out.push({ start_date: iso(t), end_date: iso(e), value: perMin * (e - t) / 60000, source_bundle_id: src });
  }
  return out;
}

test("iPhone and Watch counting the same walk are not added together", () => {
  const s = stepSeries([...readings(at(8), at(8, 30), 100, "watch"), ...readings(at(8), at(8, 30), 90, "phone")]);
  const total = [...s.values()].reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total), 3000);
});

test("a walk with short pauses is one walk; puttering at home is none", () => {
  const s = stepSeries([
    ...readings(at(8), at(8, 12), 95), ...readings(at(8, 14), at(8, 30), 95), // 2-min pause
    ...readings(at(11), at(13), 8),                                         // around the house
  ]);
  const w = walkSpans(s);
  assert.equal(w.length, 1);
  assert.equal(w[0].start_ms, at(8));
  assert.equal(w[0].end_ms, at(8, 30));
});

function day() {
  return {
    date: "2026-03-02", tz: "America/New_York",
    stops: [
      { id: "s1", start: "00:00", end: "12:00", start_ts_ms: at(0), end_ts_ms: at(12), duration_min: 720, place: { name: "Home" } },
      { id: "s2", start: "12:20", end: "14:00", start_ts_ms: at(12, 20), end_ts_ms: at(14), duration_min: 100, place: { name: "Cafe" } },
      { id: "s3", start: "14:30", end: "23:59", start_ts_ms: at(14, 30), end_ts_ms: at(23, 59), duration_min: 569, place: { name: "Home" } },
    ],
    path: { spine: [
      { type: "leg", id: "l0", mode: "walking", median_kmh: 4.5, start_ms: at(12), end_ms: at(12, 20), mins: 20, routed_m: 1500, walked_m: 1500 },
      { type: "leg", id: "l1", mode: "walking", median_kmh: 5, start_ms: at(14), end_ms: at(14, 30), mins: 30, routed_m: 2400, walked_m: 2400 },
    ] },
  };
}

test("a 'walking' leg with no steps was ridden; a walk inside Home is found", () => {
  const d = day();
  const st = annotateDaySteps(d, [
    ...readings(at(0, 5), at(0, 10), 2),            // coverage from the start of the day
    ...readings(at(8, 30), at(9), 90),              // the morning walk GPS missed
    ...readings(at(12), at(12, 20), 100),           // walked to the cafe
    ...readings(at(14), at(14, 30), 3),             // the "walk" home was a ride in traffic
    ...readings(at(23, 50), at(23, 55), 2),
  ], 9000, { startMs: at(0), endMs: at(24) });
  const [l0, l1] = d.path.spine;
  assert.equal(l0.mode, "walking");
  assert.equal(l0.steps, 2000);
  assert.equal(l1.mode, "riding");
  assert.equal(l1.walked_m, 0);
  assert.equal(st.total, 9000);
  const inStop = st.walks.filter(w => w.kind === "in_stop");
  assert.equal(inStop.length, 1);
  assert.equal(inStop[0].stop_id, "s1");
  assert.equal(inStop[0].steps, 2700);
  assert.equal(st.walks.find(w => w.kind === "leg").leg_id, "l0");
});

test("legs outside the hours the readings cover are left alone", () => {
  const d = day();
  annotateDaySteps(d, readings(at(18), at(18, 30), 90), null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.path.spine[1].mode, "walking");
  assert.equal(d.path.spine[1].steps, undefined);
});

test("the email and the wiki print the walk and the day's total", () => {
  const d = day();
  annotateDaySteps(d, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(8, 30), at(9), 90), ...readings(at(23, 50), at(23, 55), 2)],
    9000, { startMs: at(0), endMs: at(24) });
  const html = buildSkeleton(d);
  assert.match(html, /Walk 8:30 to 9:00am · 30 min · 2,700 steps/);
  assert.match(html, /9,000 steps/);
  const md = buildMarkdown(d);
  assert.match(md, /\*9,000 steps\*/);
  assert.match(md, /Walk 8:30 to 9:00am · 30 min · 2,700 steps/);
});

test("no readings: nothing changes and nothing prints", () => {
  const d = day();
  const st = annotateDaySteps(d, [], null);
  assert.equal(st.total, null);
  assert.equal(d.path.spine[1].mode, "walking");
  assert.doesNotMatch(buildSkeleton(d), /steps/);
});

test("a walk that outlasts its GPS leg gives the leg the whole walk's steps", () => {
  // Steps 17:27-17:57 at ~95/min; GPS saw the leg only 17:36-17:45 between
  // home (until 17:36) and the venue (from 17:50).
  const d = {
    date: "2026-03-02", tz: "America/New_York",
    stops: [
      { id: "h", start: "00:00", end: "17:36", start_ts_ms: at(0), end_ts_ms: at(17, 36), duration_min: 1056, place: { name: "Home" } },
      { id: "v", start: "17:50", end: "19:45", start_ts_ms: at(17, 50), end_ts_ms: at(19, 45), duration_min: 115, place: { name: "Venue" } },
    ],
    path: { spine: [{ type: "leg", id: "l0", mode: "walking", median_kmh: 4.2, start_ms: at(17, 36), end_ms: at(17, 45), mins: 9, routed_m: 1170, walked_m: 1170 }] },
  };
  const st = annotateDaySteps(d, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(17, 27), at(17, 57), 95), ...readings(at(23, 50), at(23, 55), 2)],
    null, { startMs: at(0), endMs: at(24) });
  const w = st.walks.find(x => x.steps > 2000);
  assert.equal(w.kind, "leg");
  assert.equal(w.leg_id, "l0");
  assert.equal(d.path.spine[0].walk_steps, w.steps);
  assert.ok(d.path.spine[0].walk_steps > d.path.spine[0].steps);
});
