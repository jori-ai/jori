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
