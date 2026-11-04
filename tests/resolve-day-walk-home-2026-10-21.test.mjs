// resolve-day-walk-home-2026-10-21.test.mjs — the walk home from הקוסם, one block.
//
// 2026-10-21, Portside. He wrote at 16:16: "After Falafel Example we simply walked back to the
// apartment stopping for a few minutes at different places along the way." The summary
// still showed a 14:29-14:44 "Coffee stand example" stop between the lunch and the walk:
// dropUnrestedStops had dropped that window (seven precise fixes strolling through the
// market, no rest), and addSpineDwells rebuilt it from the spine's dwell. With it gone,
// the walk opened at 14:44, where the first "not a stop" row began, 25 minutes after
// he left lunch; day-statements read his words as a stretch from 14:22.
//
// Run: node --test tests/resolve-day-walk-home-2026-10-21.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at as fakeAt } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { addSpineDwells, dropUndescribedNonStops, applyFixCompanions, extendThroughSilence } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const T = (hm) => Date.parse(`2026-10-21T${hm}:00+03:00`);
const hm = (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);
const MARKET = { ...LL(0.0, 0.0) };

function stop(id, s, e, extra = {}) {
  return { id, start: s, end: e, start_ts_ms: T(s), end_ts_ms: T(e), duration_min: (T(e) - T(s)) / 60000,
           ...LL(512.18, 671.17), place: { name: id, source: "osm_overpass" }, photos: [], companions: [], ...extra };
}

const marketDwell = (tier = "recorded") => ({ type: "dwell", id: "d6", major: true, start_ms: T("14:29"), end_ms: T("14:44"),
  witnessed_min: 10, place: { name: "Coffee stand example", tier, lat: MARKET.lat, lon: MARKET.lon } });
const noRest = () => [{ start: "14:29", end: "14:43", start_ts_ms: T("14:29"), end_ts_ms: T("14:43"), minutes: 14,
  fixes: 7, precise_fixes: 7, reason: "no rest the fixes can support — passing through" }];
const lunch = () => stop("s-4", "13:24", "14:19", { place: { name: "הקוסם", source: "user_confirmed" } });

test("a dwell over a window found to be passing through is not rebuilt as a stop", () => {
  const stops = [lunch()];
  const dropped = noRest();
  const added = addSpineDwells(stops, { spine: [marketDwell()] }, null, [], dropped);
  assert.deepEqual(added, []);
  assert.deepEqual(stops.map(s => s.id), ["s-4"]);
  assert.equal(dropped[0].spine_dwell_not_restored, "d6");
});

test("without that verdict the dwell is still restored (unchanged behaviour)", () => {
  const stops = [lunch()];
  const added = addSpineDwells(stops, { spine: [marketDwell()] }, null, [], []);
  assert.equal(added.length, 1);
  assert.equal(stops.length, 2);
});

test("a dwell he answered for is a stop whatever the rest check said", () => {
  const stops = [lunch()];
  const added = addSpineDwells(stops, { spine: [marketDwell("user-confirmed")] }, null, [], noRest());
  assert.equal(added.length, 1);
});

test("a stop kept as unlabeled by the rest check is not a passing-through verdict", () => {
  const stops = [lunch()];
  const dropped = noRest().map(r => ({ ...r, kept_as_unknown: true }));
  assert.equal(addSpineDwells(stops, { spine: [marketDwell()] }, null, [], dropped).length, 1);
});

test("kill switch: JORI_SPINE_NO_REST=0", () => {
  process.env.JORI_SPINE_NO_REST = "0";
  try {
    assert.equal(addSpineDwells([lunch()], { spine: [marketDwell()] }, null, [], noRest()).length, 1);
  } finally { delete process.env.JORI_SPINE_NO_REST; }
});

// The walk home, as the rows have it: two "not a stop" windows, then the flat.
function walkDay() {
  const flat = stop("s-7", "16:02", "20:36", { ...LL(-1608.18, -1948.46), place: { name: "The Harbor Flat", source: "confirmed_stop" } });
  return [lunch(), stop("s-5", "14:44", "15:00", { user_non_stop: true }), stop("s-6", "15:45", "16:02", { user_non_stop: true, companions: ["Paige", "Yuri"] }), flat];
}
const userConfirmed = [
  { place_type: "non-stop", place_name: null, arrived_at: "2026-10-21T11:44:27+00:00", departed_at: "2026-10-21T12:17:36+00:00", notes: "" },
  { place_type: "non-stop", place_name: null, arrived_at: "2026-10-21T12:45:55+00:00", departed_at: "2026-10-21T13:02:56+00:00", notes: "[passage-auto jev] jev: walk (0.96)" },
];
const statements = (from) => ({ _meta: { tz: "Asia/Jerusalem" }, non_stops: [
  { evidence: "After Falafel Example we simply walked back to the apartment stopping for a few minutes at different places along the way.",
    from, to: null, companions: [] },
  { evidence: "Just passing through", from: "14:44", to: "15:17", companions: [] }] });
const walkPath = { segments: [{ legs: [{ t0: T("14:22"), t1: T("16:02"), m: 2800, ...LL(399.12, 504.38, "0"), ...LL(-1608.18, -1952.91, "1") }] }] };
const run = (stops, st) => dropUndescribedNonStops(stops, {
  userConfirmed, dayPath: walkPath, statements: st, dateStr: "2026-10-21",
  resolvePoint: () => ({ neighborhood: "Portside" }), features: async () => [], hm,
});

test("the walk starts where he said it began, not where the rows did", async () => {
  const stops = walkDay();
  const { walks } = await run(stops, statements("14:22"));
  assert.equal(walks.length, 1);
  assert.equal(walks[0].start, "14:22");
  assert.equal(walks[0].end, "16:02");
  assert.deepEqual(stops.map(s => s.id), ["s-4", "s-5-walk", "s-7"]);
});

test("never before the stop that precedes it", async () => {
  const { walks } = await run(walkDay(), statements("14:15"));   // he said 14:15; lunch ran to 14:19
  assert.equal(walks[0].start, "14:19");
});

test("a stretch that began long before the walk is not this walk", async () => {
  const stops = walkDay();
  stops[0] = stop("s-4", "12:00", "12:50", { place: { name: "הקוסם", source: "user_confirmed" } });
  const { walks } = await run(stops, statements("12:55"));
  assert.equal(walks[0].start, "14:44");
});

test("no statements, or the kill switch: the rows decide, as before", async () => {
  assert.equal((await run(walkDay(), null)).walks[0].start, "14:44");
  process.env.JORI_DESCRIBED_WALK_START = "0";
  try {
    assert.equal((await run(walkDay(), statements("14:22"))).walks[0].start, "14:44");
  } finally { delete process.env.JORI_DESCRIBED_WALK_START; }
});

// 2026-10-22 06:19Z the phone re-sent the evening's fixes; the twins carry no tags.
test("a re-sent twin of a tagged fix does not take the tag away", () => {
  const FLAT = { ...LL(-1608.18, -1948.46) };
  const at = (hms) => new Date(Date.parse(`2026-10-21T${hms}Z`)).toISOString();
  const fix = (hms, companions) => ({ arrived_at: at(hms), latitude: FLAT.lat, longitude: FLAT.lon, companions });
  const s = { id: "s-9", start_ts_ms: Date.parse("2026-10-21T19:39:30Z"), end_ts_ms: Date.parse("2026-10-21T20:16:08Z"),
              lat: FLAT.lat, lon: FLAT.lon, place: { name: "The Harbor Flat" }, companions: [] };
  const fixes = [fix("19:40:47", ["Paige"]), fix("19:42:12", ["Paige"]), fix("19:42:15", ["Paige"]),
    fix("19:44:49", null), fix("19:44:49", ["Paige"]),          // the re-sent twin sorts first
    fix("19:50:03", ["Paige"]), fix("19:50:39", ["Paige"]), fix("19:53:32", ["Paige"]), fix("19:53:32", ["Paige"]),
    fix("20:16:05", null)];
  const added = applyFixCompanions([s], fixes);
  assert.deepEqual(s.companions, ["Paige"]);
  assert.equal(added[0].fixes, 8);
});

// The day's last stop at the flat ended on its last fix, 23:16:08, though the next
// one, at 00:54, was at the same spot: the pass saw only the day's own fixes, and
// the 11:34pm call with Otis sat after the day's last stop.
test("the day's last stop runs on to midnight when the phone, next heard from, was still there", () => {
  const FLAT = { ...LL(-1608.18, -1948.46) };
  const U = (iso) => Date.parse(iso);
  const dayEnd = U("2026-10-21T21:00:00Z");                     // midnight in Portside
  const last = () => ({ id: "s-9", start_ts_ms: U("2026-10-21T19:39:00Z"), end_ts_ms: U("2026-10-21T20:16:08Z"),
    start: "22:39", end: "23:16", ...FLAT, place: { name: "The Harbor Flat", source: "confirmed_stop" } });
  const day = [{ ts: U("2026-10-21T20:16:05Z"), ...FLAT, acc: 18 }, { ts: U("2026-10-21T20:16:08Z"), ...FLAT, acc: 18 }];
  const night = [{ ts: U("2026-10-21T21:54:01Z"), ...FLAT, acc: 14 }];

  const a = [last()];
  extendThroughSilence(a, [...day, ...night], null, dayEnd);
  assert.equal(a[0].end_ts_ms, dayEnd, "not past the day's end");

  const b = [last()];
  extendThroughSilence(b, day, null, dayEnd);
  assert.equal(b[0].end_ts_ms, U("2026-10-21T20:16:08Z"), "with only the day's fixes, as before");

  // he went out after midnight: the stay still runs to midnight, never past it
  const c = [last()];
  extendThroughSilence(c, [...day, { ts: U("2026-10-21T21:30:00Z"), ...LL(-128.54, -930.04), acc: 10 }], null, dayEnd);
  assert.equal(c[0].end_ts_ms, dayEnd);

  // ...and a fix elsewhere before midnight still ends it there, as before
  const d = [last()];
  const away = { ts: U("2026-10-21T20:40:00Z"), ...LL(-128.54, -930.04), acc: 10 };
  extendThroughSilence(d, [...day, away], null, dayEnd);
  assert.ok(d[0].end_ts_ms > U("2026-10-21T20:30:00Z") && d[0].end_ts_ms < away.ts);
});
