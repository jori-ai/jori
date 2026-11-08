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
const { buildSkeleton, buildMarkdown, _internal } = require("../lib/daily-summary-render.js");

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

test("a walk with only a step count is given the day's stride, and the header counts it", () => {
  // The header's miles are the lines summed; a step-only walk line used to add
  // nothing, so a day of many short walks read a few miles short of its steps.
  const d = { ...day(), map_url: "https://example.invalid/map.png" };
  annotateDaySteps(d, [
    ...readings(at(0, 5), at(0, 10), 2),
    ...readings(at(8, 30), at(9), 90),      // the morning walk GPS missed: 2,700 steps
    ...readings(at(12), at(12, 20), 100),   // the mapped walk to the cafe: 1,500 m over 2,000 steps
    ...readings(at(23, 50), at(23, 55), 2),
  ], 9000, { startMs: at(0), endMs: at(24) });
  const html = buildSkeleton(d);
  // 2,700 steps at the mapped walk's 0.75 m a step is about 2,025 m
  assert.match(html, /Walk 8:30 to 9:00am · 30 min · about 1\.3 mi · 2,700 steps/);
  // 1,500 m to the cafe plus that estimate, marked as partly estimated
  assert.match(html, /about 2\.2 miles walked/);
  assert.match(buildMarkdown(d), /Walk 8:30 to 9:00am · 30 min · about 1\.3 mi · 2,700 steps/);
});

test("the stride comes from walk blocks first, and a stride no walker has is left out", () => {
  const { dayStrideM } = _internal;
  const spine = [
    { type: "leg", mode: "walking", walked_m: 1500, steps: 2000 },
    { type: "leg", mode: "walking", walked_m: 11000, steps: 1500 },   // a ride the pace called walking
  ];
  assert.equal(dayStrideM({ stops: [], path: { spine } }), 0.75);
  assert.equal(dayStrideM({ stops: [{ excursion: { routed_m: 2000, steps: 4000 } }], path: { spine } }), 0.5);
  // too few steps to measure a stride: the line keeps no distance
  assert.equal(dayStrideM({ stops: [], path: { spine: [{ type: "leg", mode: "walking", walked_m: 300, steps: 400 }] } }), null);
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
  assert.ok(d.path.spine[0].walk_steps >= d.path.spine[0].steps);
});

test("a walk that starts too long before GPS saw the user leave keeps the leg's own steps and never prints a clock that overlaps the stops beside it", () => {
  // On foot from 17:00, 36 min before the home stop ends: past the 20-minute limit,
  // so that edge stays and the walk still runs past the stretch.
  const d = {
    date: "2026-03-02", tz: "America/New_York",
    stops: [
      { id: "h", start: "00:00", end: "17:36", start_ts_ms: at(0), end_ts_ms: at(17, 36), duration_min: 1056, place: { name: "Home" } },
      { id: "v", start: "17:50", end: "19:45", start_ts_ms: at(17, 50), end_ts_ms: at(19, 45), duration_min: 115, place: { name: "Venue" } },
    ],
    path: { spine: [{ type: "leg", id: "l0", mode: "walking", median_kmh: 4.2, start_ms: at(17, 36), end_ms: at(17, 45), mins: 9,
      routed_m: 700, straight_m: 650, walked_m: 700, geometry: "map_matched", fixes: 3, streets: ["Main Street"] }] },
  };
  annotateDaySteps(d, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(17, 0), at(17, 57), 95), ...readings(at(23, 50), at(23, 55), 2)],
    null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.stops[0].end, "17:36");
  const html = buildSkeleton(d);
  assert.doesNotMatch(html, /on foot/);
  assert.doesNotMatch(html, /5,415 steps/);
  assert.match(html, /Walked [\d.]+ miles[^<]*, [\d,]+ steps\./);
});

test("a walk line whose walk sits inside the stretch carries the whole walk's steps", () => {
  const d = {
    date: "2026-03-02", tz: "America/New_York",
    stops: [
      { id: "h", start: "00:00", end: "17:30", start_ts_ms: at(0), end_ts_ms: at(17, 30), duration_min: 1050, place: { name: "Home" } },
      { id: "v", start: "17:58", end: "19:45", start_ts_ms: at(17, 58), end_ts_ms: at(19, 45), duration_min: 107, place: { name: "Venue" } },
    ],
    path: { spine: [{ type: "leg", id: "l0", mode: "walking", median_kmh: 4.2, start_ms: at(17, 36), end_ms: at(17, 45), mins: 9,
      routed_m: 1900, straight_m: 1700, walked_m: 1900, geometry: "map_matched", fixes: 3, streets: ["Main Street"] }] },
  };
  annotateDaySteps(d, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(17, 31), at(17, 57), 95), ...readings(at(23, 50), at(23, 55), 2)],
    null, { startMs: at(0), endMs: at(24) });
  const html = buildSkeleton(d);
  assert.match(html, /2,4\d\d steps\./);
});

test("stop edges move to the walk the steps found, so the travel line carries the whole walk", () => {
  // Steps 17:27-17:57; GPS: home until 17:36, leg 17:36-17:45, venue from 17:50.
  const d = {
    date: "2026-03-02", tz: "America/New_York",
    stops: [
      { id: "h", start: "00:00", end: "17:36", start_ts_ms: at(0), end_ts_ms: at(17, 36), duration_min: 1056, place: { name: "Home" } },
      { id: "v", start: "17:50", end: "19:45", start_ts_ms: at(17, 50), end_ts_ms: at(19, 45), duration_min: 115, place: { name: "Venue" } },
    ],
    travel_legs: [{ from: "h", to: "v", duration_min: 14 }],
    path: { spine: [
      { type: "dwell", id: "d0", start_ms: at(0), end_ms: at(17, 36), start: "00:00", end: "17:36", mins: 1056, place: { name: "Home" } },
      { type: "leg", id: "l0", mode: "walking", median_kmh: 4.2, start_ms: at(17, 36), end_ms: at(17, 45), mins: 9,
        routed_m: 2300, straight_m: 2100, walked_m: 2300, geometry: "map_matched", fixes: 3, streets: ["Main Street"] },
      { type: "dwell", id: "d1", start_ms: at(17, 50), end_ms: at(19, 45), start: "17:50", end: "19:45", mins: 115, place: { name: "Venue" } },
    ] },
  };
  const st = annotateDaySteps(d, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(17, 27), at(17, 57), 95), ...readings(at(23, 50), at(23, 55), 2)],
    null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.stops[0].end, "17:27");
  assert.equal(d.stops[1].start, "17:57");
  assert.equal(d.path.spine[0].end, "17:27");
  assert.equal(d.path.spine[2].start, "17:57");
  assert.equal(d.travel_legs[0].duration_min, 30);
  assert.equal(st.stops_aligned.length, 2);
  const html = buildSkeleton(d);
  assert.match(html, /5:27pm · Walked [\d.]+ miles along Main Street, about 30 min, 2,850 steps\./);
});

// A walk of 17:27-17:57 whose middle three minutes the phone did not see: the
// router bridged them (519 m) faster than a walker goes, so day-path left them
// out of walked_m (588 of 1,170 m).
function walkWithHole() {
  return {
    date: "2026-03-02", tz: day().tz,
    stops: [
      { id: "h", start: "00:00", end: "17:27", start_ts_ms: at(0), end_ts_ms: at(17, 27), duration_min: 1047, place: { name: "Home" } },
      { id: "v", start: "17:57", end: "19:45", start_ts_ms: at(17, 57), end_ts_ms: at(19, 45), duration_min: 108, place: { name: "Venue" } },
    ],
    path: { spine: [{ type: "leg", id: "l0", mode: "walking", median_kmh: 4.2, start_ms: at(17, 27), end_ms: at(17, 57), mins: 30,
      routed_m: 1170, straight_m: 1078, walked_m: 588, hole_m: 519, geometry: "map_matched", fixes: 3, streets: ["Main Street"],
      holes: [{ t0: "17:42", t1: "17:45", m: 519, min: 3, start_ms: at(17, 42), end_ms: at(17, 45) }] }] },
  };
}

test("a hole bridged faster than a walk is walked ground when the steps in it are a walker's", () => {
  const d = walkWithHole();
  const samples = [...readings(at(0, 5), at(0, 10), 2), ...readings(at(17, 27), at(17, 57), 95), ...readings(at(23, 50), at(23, 55), 2)];
  annotateDaySteps(d, samples, null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.path.spine[0].walked_m, 1107);
  assert.match(buildSkeleton(d), /Walked 0\.7 miles along Main Street, about 30 min, 2,850 steps\./);
  annotateDaySteps(d, samples, null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.path.spine[0].walked_m, 1107, "a second pass recomputes rather than adds");
});

test("a hole the steps show was not walked stays out of the walked metres", () => {
  const d = walkWithHole();
  annotateDaySteps(d, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(17, 27), at(17, 42), 95), ...readings(at(17, 42), at(17, 45), 2),
    ...readings(at(17, 45), at(17, 57), 95), ...readings(at(23, 50), at(23, 55), 2)], null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.path.spine[0].walked_m, 588);
});

test("an edge is never moved further than 20 minutes, nor past a stop's own start", () => {
  const d = day();
  // A walk starting 40 min before the leg: the home stop's edge stays put.
  annotateDaySteps(d, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(11, 20), at(12, 20), 95), ...readings(at(23, 50), at(23, 55), 2)],
    null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.stops[0].end_ts_ms, at(12));
});

test("annotating a day twice gives the same counts as once", () => {
  const d = day();
  const rs = [...readings(at(0, 5), at(0, 10), 2), ...readings(at(11, 55), at(12, 25), 95), ...readings(at(23, 50), at(23, 55), 2)];
  annotateDaySteps(d, rs, 9000, { startMs: at(0), endMs: at(24) });
  const once = JSON.stringify(d.path.spine);
  annotateDaySteps(d, rs, 9000, { startMs: at(0), endMs: at(24) });
  assert.equal(JSON.stringify(d.path.spine), once);
});

// 2026-11-07: home to the coffee stop. The spine joined the two stops with no leg (the
// phone took no fix on the hop), the steps ran 7:48-8:04, and the phone's first rest at
// the venue began 7:52. The line printed the walk under the venue from before it began.
function hopDay() {
  return {
    date: "2026-03-02", tz: day().tz,
    stops: [
      { id: "h", start: "00:00", end: "07:48", start_ts_ms: at(0), end_ts_ms: at(7, 48), duration_min: 468, place: { name: "Home" } },
      { id: "v", start: "07:52", end: "09:43", start_ts_ms: at(7, 52), end_ts_ms: at(9, 43), duration_min: 111, place: { name: "Cafe" } },
    ],
    travel_legs: [{ from: "h", to: "v", duration_min: 4 }],
    path: { spine: [
      { type: "dwell", id: "d0", start_ms: at(0), end_ms: at(7, 52), start: "00:00", end: "07:52", mins: 472, place: { name: "Home" } },
      { type: "dwell", id: "d1", start_ms: at(7, 52), end_ms: at(9, 43), start: "07:52", end: "09:43", mins: 111, place: { name: "Cafe" } },
    ] },
  };
}
const hopSteps = () => [...readings(at(0, 5), at(0, 10), 2), ...readings(at(7, 48), at(8, 4), 77), ...readings(at(23, 50), at(23, 55), 2)];

test("a walk from one stop's end into the next stop's first minutes, with no leg between them, starts that stop at the last stride", () => {
  const d = hopDay();
  const st = annotateDaySteps(d, hopSteps(), null, { startMs: at(0), endMs: at(24) });
  assert.equal(d.stops[1].start, "08:04");
  assert.equal(d.stops[1].start_ts_ms, at(8, 4));
  assert.equal(d.stops[1].duration_min, 99);
  assert.equal(d.path.spine[1].start, "08:04");
  assert.equal(d.travel_legs[0].duration_min, 16);
  assert.deepEqual(st.stops_aligned.map(m => [m.stop_id, m.edge]), [["v", "start"]]);
  assert.equal(st.walks[0].kind, "between", "the walk is the way there, not a walk inside the venue");
});

test("a hop walk that does not begin as the first stop ends, or leaves the next stop too little, moves nothing", () => {
  const early = hopDay();
  annotateDaySteps(early, [...readings(at(0, 5), at(0, 10), 2), ...readings(at(7, 30), at(8, 4), 77)], null, { startMs: at(0), endMs: at(24) });
  assert.equal(early.stops[1].start_ts_ms, at(7, 52), "begins 18 min before the first stop ends: not its walk");
  const brief = hopDay();
  brief.stops[1].end_ts_ms = at(8, 6); brief.stops[1].end = "08:06"; brief.stops[1].duration_min = 14;
  annotateDaySteps(brief, hopSteps(), null, { startMs: at(0), endMs: at(24) });
  assert.equal(brief.stops[1].start_ts_ms, at(7, 52), "would leave the stop 2 minutes");
});

test("a walk with a leg under it is left to the leg's rule, and JORI_STEPS_ALIGN_HOPS=0 leaves the hop as the phone saw it", () => {
  const off = hopDay();
  process.env.JORI_STEPS_ALIGN_HOPS = "0";
  try { annotateDaySteps(off, hopSteps(), null, { startMs: at(0), endMs: at(24) }); }
  finally { delete process.env.JORI_STEPS_ALIGN_HOPS; }
  assert.equal(off.stops[1].start_ts_ms, at(7, 52));
  const withLeg = hopDay();
  withLeg.path.spine.splice(1, 0, { type: "leg", id: "l0", mode: "riding", start_ms: at(7, 50), end_ms: at(7, 52), mins: 2 });
  annotateDaySteps(withLeg, hopSteps(), null, { startMs: at(0), endMs: at(24) });
  assert.equal(withLeg.stops[1].start_ts_ms, at(7, 52), "a leg of another mode under the walk: not a bare hop");
});
