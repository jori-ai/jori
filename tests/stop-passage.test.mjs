// stop-passage.test.mjs — two questions the user got one afternoon, both
// answerable from the data before asking (synthetic coordinates, real geometry):
//
//   14:52–15:00  walk home from lunch → geometry alone: PASSAGE
//   18:05–18:29  sunset walk in a seaside park → geometry INCONCLUSIVE
//                (a 7-minute GPS silence), Jev reads the photos → walk
//
// Plus the guards: a real rest stays a stop, one photo + silence is not a rest.
// Run: node --test tests/stop-passage.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsFrom, classifyWindow, STOP_MIN } from "../lib/stop-passage.mjs";
import { buildState, judgeWindow } from "../lib/stop-passage-jev.mjs";

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };

const fix = (t, lat, lon, acc, activity) => ({ arrived_at: `2026-10-06T${t}Z`, latitude: lat, longitude: lon, accuracy_m: acc, activity });
const photo = (t, lat, lon, labels = []) => ({ taken_at: `2026-10-06T${t}Z`, latitude: lat, longitude: lon, self_captured: true, labels, media_type: "photo" });

// Raw rows from location_history (UTC; local = +3h). Duplicate uploads kept on purpose.
const LUNCH_TO_AIRBNB = [
  fix("11:43:15", ...fakePt(0, 0), 20, "stationary"),
  fix("11:45:18", ...fakePt(-12.25, -6.67), 23, "stationary"),
  fix("11:45:33", ...fakePt(-7.54, -5.56), 11, "stationary"),
  fix("11:48:59", ...fakePt(-132.88, -42.25), 22, "walking"),
  fix("11:49:18", ...fakePt(-154.56, -52.26), 19, "walking"),
  fix("11:49:21", ...fakePt(-154.56, -52.26), 14, "walking"),
  fix("11:52:53", ...fakePt(-306.29, -97.85), 15, "walking"),
  fix("11:56:44", ...fakePt(-362.84, -235.73), 15, "walking"),
  fix("12:00:55", ...fakePt(-536.25, -249.08), 12, "walking"),
  fix("12:00:55", ...fakePt(-536.25, -249.08), 12, "walking"),
  fix("12:18:45", ...fakePt(-549.44, -245.74), 5, "unknown"),
  fix("12:19:26", ...fakePt(-714.38, -354.71), 1414, "stationary"), // cell tower — ignored
];

const SUNSET_FIXES = [
  fix("14:43:45", ...fakePt(-469.34, -236.85), 15, "walking"),
  fix("14:49:53", ...fakePt(-408.07, -102.3), 16, "walking"),
  fix("14:53:41", ...fakePt(-358.12, 62.27), 23, "walking"),
  fix("14:55:59", ...fakePt(-451.41, 100.08), 17, "walking"),
  fix("14:57:55", ...fakePt(-455.18, 92.29), 8, "unknown"),
  fix("15:05:10", ...fakePt(133.81, 944.04), 135, "walking"), // too loose — ignored
  fix("15:10:22", ...fakePt(-203.56, 333.58), 41, "walking"),
  fix("15:10:25", ...fakePt(-188.48, 351.38), 10, "walking"),
  fix("15:10:29", ...fakePt(-185.65, 353.6), 5, "walking"),
  fix("15:11:29", ...fakePt(-187.53, 361.38), 5, "unknown"),
  fix("15:11:32", ...fakePt(-188.48, 363.61), 5, "unknown"),
  fix("15:14:24", ...fakePt(-20.73, 600.45), 63, "walking"),
  fix("15:24:34", ...fakePt(-117.8, 449.23), 5, "walking"),
  fix("15:31:04", ...fakePt(-332.67, 156.78), 50, "walking"),
  fix("15:34:32", ...fakePt(-407.12, 127.87), 49, "walking"),
  fix("15:37:14", ...fakePt(-433.51, 113.42), 4, "walking"),
  fix("15:43:21", ...fakePt(-410.9, -86.73), 19, "walking"),
  fix("15:49:00", ...fakePt(-535.31, -254.64), 16, "walking"),
];
const SUNSET = ["afterglow", "dusk", "horizon", "ocean", "pier", "sea", "sky", "sunset", "water"];
const SUNSET_PHOTOS = [
  photo("15:11:15", ...fakePt(-187.54, 359.16), SUNSET),
  photo("15:11:19", ...fakePt(-186.59, 360.27), SUNSET),
  photo("15:11:24", ...fakePt(-186.59, 359.16), SUNSET),
  photo("15:12:11", ...fakePt(-211.09, 382.51), [...SUNSET, "beach", "shore"]),
  photo("15:12:22", ...fakePt(-210.15, 384.73), [...SUNSET, "beach", "shore"]),
  photo("15:16:56", ...fakePt(-133.82, 509.27), []),
];

test("walk home from lunch (14:52–15:00) is a passage on geometry alone", () => {
  const points = pointsFrom({ fixes: LUNCH_TO_AIRBNB });
  const r = classifyWindow({ points, start: "2026-10-06T11:52:34Z", end: "2026-10-06T12:00:34Z" });
  assert.equal(r.verdict, "passage", r.reason);
  assert.ok(r.features.longest_hidden_min < STOP_MIN);
  assert.equal(r.features.moving_share, 1);
});

test("sunset walk (18:05–18:29) is inconclusive on geometry: a 7-min silence could hide a stop", () => {
  const points = pointsFrom({ fixes: SUNSET_FIXES, photos: SUNSET_PHOTOS });
  const r = classifyWindow({ points, start: "2026-10-06T15:05:25Z", end: "2026-10-06T15:29:50Z" });
  assert.equal(r.verdict, "inconclusive", r.reason);
  assert.ok(r.features.longest_rest_min < 2, "the photo stop at 18:11 is a pause, not a rest");
  assert.ok(r.features.longest_hidden_min >= STOP_MIN);
  assert.equal(r.features.photos_in_window, 6);
});

test("one photo followed by silence is not an observed rest", () => {
  // Photo 110 m past the last fix, then 8 quiet minutes ending 55 m further on.
  const points = pointsFrom({ fixes: [fix("10:00:00", 32.0, 34.0, 5, "walking"), fix("10:09:00", 32.0015, 34.0, 5, "walking")],
    photos: [photo("10:01:00", 32.001, 34.0)] });
  const r = classifyWindow({ points, start: "2026-10-06T10:00:30Z", end: "2026-10-06T10:08:30Z" });
  assert.equal(r.features.longest_rest_min, 0);
  assert.notEqual(r.verdict, "rest");
});

test("a real 20-minute sit stays a stop", () => {
  const fixes = [fix("09:00:00", 32.0, 34.0, 10, "walking")];
  for (let m = 2; m <= 22; m += 4) fixes.push(fix(`09:${String(m).padStart(2, "0")}:00`, 32.03, 34.02, 8, "stationary"));
  fixes.push(fix("09:26:00", 32.04, 34.03, 10, "walking"));
  const r = classifyWindow({ points: pointsFrom({ fixes }), start: "2026-10-06T09:02:00Z", end: "2026-10-06T09:22:00Z" });
  assert.equal(r.verdict, "rest");
});

test("too few points is inconclusive, never a passage", () => {
  const r = classifyWindow({ points: pointsFrom({ fixes: [fix("09:00:00", 32, 34, 5, "walking")] }), start: "2026-10-06T09:00:00Z", end: "2026-10-06T09:10:00Z" });
  assert.equal(r.verdict, "inconclusive");
});

test("Jev state carries the photos and movement in words, not raw coordinates", () => {
  const points = pointsFrom({ fixes: SUNSET_FIXES, photos: SUNSET_PHOTOS });
  const { features } = classifyWindow({ points, start: "2026-10-06T15:05:25Z", end: "2026-10-06T15:29:50Z" });
  const st = buildState({ start: "2026-10-06T15:05:25Z", end: "2026-10-06T15:29:50Z", tz: "Asia/Jerusalem", features,
    areaName: "פארק צ'ארלס קלור", photos: SUNSET_PHOTOS, calendar: [], messages: [] });
  assert.equal(st.window.from, "18:05");
  assert.equal(st.photos.length, 6);
  assert.ok(st.photos[0].shows.includes("sunset"));
  assert.match(st.movement.motion_sensor, /moving/);
  assert.ok(!JSON.stringify(st).includes("32.05"), "no raw coordinates");
});

const fakeDecide = (pick, confidence, threshold = 0.9) => async (o) => {
  const it = o.interpret({ kind: { choice: pick } });
  if (confidence >= threshold) return { value: it.value, used: "jev", jev: { confidence } };
  return { value: await o.legacy(), used: "legacy", jev: { confidence } };
};

test("Jev walk at or above threshold → passage; stop/unclear/low confidence → ask", async () => {
  assert.equal((await judgeWindow({ id: "x", state: {}, decideImpl: fakeDecide("walk", 0.95) })).decision, "passage");
  assert.equal((await judgeWindow({ id: "x", state: {}, decideImpl: fakeDecide("walk", 0.7) })).decision, "ask");
  assert.equal((await judgeWindow({ id: "x", state: {}, decideImpl: fakeDecide("stop", 0.97) })).decision, "ask");
  assert.equal((await judgeWindow({ id: "x", state: {}, decideImpl: fakeDecide("unclear", 0.97) })).decision, "ask");
});

test("a window that runs straight into a stay reports it, so the caller can require it be recorded", () => {
  // The walk home: the Airbnb stay starts at 15:00:55, 21 s after the asked window.
  const points = pointsFrom({ fixes: LUNCH_TO_AIRBNB });
  const r = classifyWindow({ points, start: "2026-10-06T11:52:34Z", end: "2026-10-06T12:00:34Z" });
  assert.equal(r.verdict, "passage");
  assert.ok(r.features.arrival_stay, "arrival stay at the Airbnb reported");
  assert.equal(r.features.arrival_stay.start, "2026-10-06T12:00:55.000Z");
  // Leaving lunch ends ~7 min before the window: not an edge.
  assert.equal(r.features.departure_stay, null);
});

// One evening 18:51–19:21, answered "Just passing through": two untagged
// fixes 22 s apart mid-walk, then 9.5 quiet minutes ending 143 m on. The old
// rule stretched that pair across the silence into "rested 8.1 min".
const fix7 = (t, lat, lon, acc, activity) => ({ arrived_at: `2026-10-07T${t}Z`, latitude: lat, longitude: lon, accuracy_m: acc, activity });
const EVENING_WALK = [
  fix7("15:41:51", ...fakePt(-549.92, -245.52), 11, "unknown"),
  fix7("15:41:54", ...fakePt(-549.92, -245.52), 10, "stationary"),
  fix7("15:51:05", ...fakePt(-356.34, -203.6), 20, "unknown"),
  fix7("15:55:25", ...fakePt(-262.57, -278.54), 16, "walking"),
  fix7("15:56:34", ...fakePt(-245.7, -294.33), 92, "walking"),
  fix7("15:56:38", ...fakePt(-231.94, -314.57), 7, "unknown"),
  fix7("15:57:00", ...fakePt(-227.98, -310.12), 7, "unknown"),
  fix7("16:06:31", ...fakePt(-137.69, -420.87), 9, "walking"),
  fix7("16:14:22", ...fakePt(-318.36, -234.18), 9, "walking"),
  fix7("16:14:26", ...fakePt(-320.15, -232.06), 5, "walking"),
  fix7("16:16:43", ...fakePt(-364.44, -188.81), 24, "unknown"),
  fix7("16:16:48", ...fakePt(-356.24, -190.59), 11, "stationary"),
  fix7("16:18:54", ...fakePt(-417.12, -179.91), 21, "walking"),
  fix7("16:21:01", ...fakePt(-470.37, -240.96), 18, "walking"),
  fix7("16:23:02", ...fakePt(-539.27, -251.75), 16, "walking"),
];

test("two fixes seconds apart do not stretch across a long silence into a rest", () => {
  const r = classifyWindow({ points: pointsFrom({ fixes: EVENING_WALK }), start: "2026-10-07T15:51:04Z", end: "2026-10-07T16:21:35Z" });
  assert.equal(r.verdict, "inconclusive", r.reason);
  assert.ok(r.features.longest_rest_min < STOP_MIN, `rest ${r.features.longest_rest_min}`);
  assert.ok(r.features.longest_hidden_min >= STOP_MIN, "the silence goes to Jev as possible standing time");
});

test("a stationary tag inside the run still lets the silence after it count as rest", () => {
  const fixes = EVENING_WALK.map((f) => (f.arrived_at.endsWith("15:57:00Z") ? { ...f, activity: "stationary" } : f));
  const r = classifyWindow({ points: pointsFrom({ fixes }), start: "2026-10-07T15:51:04Z", end: "2026-10-07T16:21:35Z" });
  assert.equal(r.verdict, "rest", r.reason);
});

test("a lone point between two silences can hide a stop across both (2026-10-07 print shop)", () => {
  // 09:23:42 walking 160 m out, one fix at the counter 09:30:15, 09:37:04
  // walking 184 m on. Pairwise each silence is 4.6 min; across the fix it is ~9.
  const fx = (t, lat, lon, acc, a) => ({ arrived_at: `2026-10-07T${t}Z`, latitude: lat, longitude: lon, accuracy_m: acc, activity: a });
  const points = pointsFrom({ fixes: [
    fx("06:23:42", ...fakePt(-255.4, -112.31), 14, "walking"),
    fx("06:30:15", ...fakePt(-92.36, -332.47), 16, "unknown"),
    fx("06:37:04", ...fakePt(-217.7, -195.7), 16, "walking"),
    fx("06:45:44", ...fakePt(-538.13, -234.62), 4, "walking"),
  ] });
  const r = classifyWindow({ points, start: "2026-10-07T06:25:01Z", end: "2026-10-07T06:41:24Z" });
  assert.notEqual(r.verdict, "passage", r.reason);
  assert.ok(r.features.longest_hidden_min >= STOP_MIN, JSON.stringify(r.features));
});

// ---------------------------------------------------------------------------
// The routine walk from home (2026-11-21): a 13-minute iOS visit in the middle
// of a short loop out of the house and back on foot was asked about ("where was
// this?"). homeLoopVerdict calls it part of the walk; while the walk is still
// out it holds, so nobody is asked mid-walk.
// ---------------------------------------------------------------------------
import { homeLoopVerdict } from "../lib/stop-passage.mjs";
import { createRequire } from "node:module";
const { homeLoopConfig } = createRequire(import.meta.url)("../lib/day-excursions.js");

{
  const LOOP_CFG = homeLoopConfig({ routineWalk: { homes: ["Home (Example)"], companion: "Dog" },
    entries: [{ name: "Home (Example)", kind: "home", ...fakeAt(-70, 20) }] });
  const z = (hms) => `2026-11-20T${hms}Z`;
  const fx = (hms, e, n, acc, activity) => ({ arrived_at: z(hms), ...fakeRow(e, n), accuracy_m: acc, activity });
  const vr = (id, hms, dep, e, n, acc, place_type) => ({ id, arrived_at: z(hms), departed_at: dep ? z(dep) : null, ...fakeRow(e, n), accuracy_m: acc, place_type });
  const FIXES = [
    fx("21:46:59", 4.2, 7.2, 3, "unknown"), fx("21:47:54", 0, 0, 13, "unknown"), fx("21:50:10", 1.5, -2, 10, "stationary"),
    fx("22:26:31", 93, 18.3, 26, "walking"), fx("22:29:07", 164.3, 70.5, 15, "walking"), fx("22:38:07", 590, 84.6, 21, "walking"),
    fx("22:45:24", 329.7, -15.8, 14, "walking"), fx("22:48:05", 185.7, -19.9, 28, "walking"),
    fx("22:50:34", 71.9, 6, 25, "walking"), fx("22:53:20", 12.3, 3, 17, "unknown"),
  ];
  const VISITS = [
    vr("home-1", "21:33:38", "22:29:32", -4.7, -12.7, 2, "named"),
    vr("walk-1", "22:29:55", "22:43:07", 380.8, 53.2, 119, "address"),
    vr("home-2", "22:49:16", null, -2.3, -25.5, 21, "named"),
  ];
  const W = { start: z("22:29:55"), end: z("22:43:07"), visitId: "walk-1", cfg: LOOP_CFG };

  test("home loop: a visit on the routine walk is part of it (passage)", () => {
    const r = homeLoopVerdict({ ...W, fixes: FIXES, visits: VISITS, now: Date.parse(z("23:30:00")) });
    assert.equal(r && r.verdict, "passage", JSON.stringify(r));
    assert.match(r.reason, /walk from Home \(Example\) and back/);
    assert.ok(r.loop.away_m > 580 && r.loop.away_m < 610);
  });

  test("home loop: still out on the walk, the question waits (hold)", () => {
    const soFar = FIXES.filter(f => f.arrived_at <= z("22:45:30"));
    const r = homeLoopVerdict({ ...W, fixes: soFar, visits: VISITS.slice(0, 2), now: Date.parse(z("22:46:00")) });
    assert.equal(r && r.verdict, "hold", JSON.stringify(r));
    const late = homeLoopVerdict({ ...W, fixes: soFar, visits: VISITS.slice(0, 2), now: Date.parse(z("23:59:00")) });
    assert.equal(late, null, "past what a routine walk could be, it is judged as before");
  });

  test("home loop: a row out there that names its place, or no config, is not the walk", () => {
    const named = VISITS.concat([vr("cafe", "22:40:00", "22:42:00", 500, 80, 10, "user-confirmed")]);
    assert.equal(homeLoopVerdict({ ...W, fixes: FIXES, visits: named, now: Date.parse(z("23:30:00")) }), null);
    assert.equal(homeLoopVerdict({ ...W, cfg: null, fixes: FIXES, visits: VISITS }), null);
    const driven = FIXES.map(f => f.activity === "walking" ? { ...f, activity: "driving" } : f);
    assert.equal(homeLoopVerdict({ ...W, fixes: driven, visits: VISITS, now: Date.parse(z("23:30:00")) }), null);
  });
}

// ---------------------------------------------------------------------------
// A short stop must not be withdrawn on the strength of the leg in or out of it.
// 2026-11-27, a short errand: the phone's visit row said stationary 9.6 min, one fix
// sat at the shop, and the first driving fix OF THE DRIVE AWAY landed on the row's
// closing second 170 m on. Counted inside the window it read "covered 170 m, 100%
// moving" and the stop was withdrawn as a passage. Synthetic geometry again.
// ---------------------------------------------------------------------------
{
  const WIN = { start: "2026-10-06T09:00:00Z", end: "2026-10-06T09:09:30Z" };
  const CENTER = fakeAt(3, 2); // where the visit detector put the stay
  const SHOP_RUN = [
    fix("08:59:46", ...fakePt(-290, 0), 2, "driving"),   // the way in (as far back as the real trace: the silences stay under 5 min)
    fix("09:04:40", ...fakePt(0, 0), 23, "unknown"),     // the window's own fix, at the shop
    fix("09:09:30", ...fakePt(170, 0), 5, "driving"),    // the way out, on the closing second
  ];

  test("short stop: without the visit's centre the geometry reads it as before (nothing else changes)", () => {
    const r = classifyWindow({ points: pointsFrom({ fixes: SHOP_RUN }), ...WIN });
    assert.equal(r.verdict, "passage", "the old shape, kept for callers that have no centre");
    assert.equal(r.features.dwell_at_row, false);
    assert.equal(r.features.edge_fixes_set_aside, 0);
  });

  test("short stop: a fix of its own at the visit's spot makes the fix on the way out the leg, not the window", () => {
    const r = classifyWindow({ points: pointsFrom({ fixes: SHOP_RUN }), ...WIN, center: CENTER });
    assert.equal(r.verdict, "inconclusive", r.reason);
    assert.equal(r.features.dwell_at_row, true);
    assert.equal(r.features.edge_fixes_set_aside, 1);
    assert.equal(r.features.points_in_window, 1);
    assert.equal(r.features.spread_m, 0, "the drive away is not ground covered inside the stop");
    assert.equal(r.features.moving_share, null);
  });

  test("a drive is still a passage: its inside fix is a driving one, so there is no dwell", () => {
    const drive = [
      fix("08:59:50", ...fakePt(-400, 0), 5, "driving"),
      fix("09:04:40", ...fakePt(0, 0), 8, "driving"),
      fix("09:09:30", ...fakePt(400, 0), 5, "driving"),
    ];
    const r = classifyWindow({ points: pointsFrom({ fixes: drive }), ...WIN, center: CENTER });
    assert.equal(r.features.dwell_at_row, false);
    assert.equal(r.verdict, "passage", r.reason);
  });

  test("a walk past the spot is still a passage: a walking fix there is the walk itself", () => {
    const walk = [
      fix("09:00:10", ...fakePt(-250, 0), 10, "walking"),
      fix("09:04:40", ...fakePt(0, 0), 10, "walking"),
      fix("09:08:30", ...fakePt(250, 0), 10, "walking"),
    ];
    const r = classifyWindow({ points: pointsFrom({ fixes: walk }), ...WIN, center: CENTER });
    assert.equal(r.features.dwell_at_row, false);
    assert.equal(r.verdict, "passage", r.reason);
  });

  test("a walk in does not turn a dwell into a passage (2026-11-13 restaurant, confirmed by the user)", () => {
    const shop = [
      fix("09:00:00", ...fakePt(-420, 0), 15, "walking"),
      fix("09:02:20", ...fakePt(-90, 30), 16, "walking"),  // on the way in, 90 m off: a moving fix inside the window
      fix("09:05:55", ...fakePt(20, 10), 32, "unknown"),   // at the shop
      fix("09:09:30", ...fakePt(170, 80), 22, "walking"),  // leaving, on the closing second
    ];
    const old = classifyWindow({ points: pointsFrom({ fixes: shop }), ...WIN });
    assert.equal(old.verdict, "passage", "geometry alone reads 100% of the tags moving");
    const r = classifyWindow({ points: pointsFrom({ fixes: shop }), ...WIN, center: CENTER });
    assert.equal(r.verdict, "inconclusive", r.reason);
    assert.match(r.reason, /visit detector/);
  });

  test("a rest the geometry observes is still a rest, centre or not", () => {
    const sit = [fix("09:00:30", ...fakePt(0, 0), 8, "stationary"), fix("09:04:30", ...fakePt(2, 1), 8, "stationary"),
      fix("09:08:30", ...fakePt(1, 0), 8, "stationary"), fix("09:12:00", ...fakePt(300, 0), 10, "walking")];
    const r = classifyWindow({ points: pointsFrom({ fixes: sit }), ...WIN, center: CENTER });
    assert.equal(r.verdict, "rest");
  });

  test("Jev is told about the dwell only when there is one", () => {
    const withDwell = classifyWindow({ points: pointsFrom({ fixes: SHOP_RUN }), ...WIN, center: CENTER }).features;
    const without = classifyWindow({ points: pointsFrom({ fixes: SHOP_RUN }), ...WIN }).features;
    const a = buildState({ ...WIN, features: withDwell });
    const b = buildState({ ...WIN, features: without });
    assert.match(a.movement.phones_own_visit_detector, /recorded a stay here/);
    assert.equal(b.movement.phones_own_visit_detector, undefined);
  });
}
