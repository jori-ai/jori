// resolve-day-walking-venues.test.mjs — two evenings that vanished from the
// summary: the last drive of each day (to a store on one, to the beach on the
// other) never registered, though both were clearly visible on the map.
//
// Both were found, resolved, and then deleted by two rules that each assumed the
// user was on foot:
//
//   1. markMovementByPace — a stop whose average pace clears 1.8 km/h is
//      "walking through". Calibrated on places where you SIT (a flat
//      0.08, a brasserie 0.74, cocktails 0.91 km/h). A Store and a beach are
//      places you walk around for the whole visit, so both cleared it: 3.09 and
//      3.39 km/h. Supermarket cleared it too (3.23) and survived only because the user
//      had confirmed it by hand — the filter had narrowed to deleting exactly
//      the stops the user had not already told us about.
//
//   2. reconcileStopTimeline — charged the 5.9 km hop from home to the beach at
//      walking pace, demanded 96 minutes, found 78, and took the missing 18 out
//      of the beach. An 18-minute stop became 1 minute, which then failed the
//      renderer's 30-minute main-stop test. Deleted twice over.
//
// Run: node --test tests/resolve-day-walking-venues.test.mjs

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
const PT = (e, n) => { const p = fakeAt(e, n); return [p.lat, p.lon]; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { markMovementByPace, reconcileStopTimeline, crossingPaceMPerH,
        contradictedByTrace, widenToBackingVisits, dropShortStops, mergeSplitVisits,
        RECONCILE_PACE_M_PER_H } = _internal;
const { _internal: render } = require(path.join(ROOT, "lib/daily-summary-render.js"));

const ms = (hhmm) => Date.parse(`2026-08-15T${hhmm}:00-04:00`);

// A leg of the routed trace: a straight hop with a known time interval.
function leg(t0, t1, lat0, lon0, lat1, lon1, m) {
  return { t0: ms(t0), t1: ms(t1), lat0, lon0, lat1, lon1, m };
}

const HOME = [...PT(-5903.02, -356.28)];
const BEACH = [...PT(-55.62, -50.7)];

// The real 2026-08-15 evening: drive Example Park -> Beachtown, walk the beach,
// drive home. The walk covers ~1 km and ends where it began.
function beachEveningPath() {
  return {
    segments: [{
      legs: [
        // the drive out — 5.9 km in 11 minutes
        leg("17:50", "18:01", HOME[0], HOME[1], BEACH[0], BEACH[1], 6800),
        // the beach itself: out along the sand and back to the same spot
        leg("18:01", "18:11", BEACH[0], BEACH[1], ...PT(9.4, 404.08), 510),
        leg("18:11", "18:20", ...PT(9.4, 404.08), ...PT(-61.62, -45.14), 510),
        // the drive home
        leg("18:20", "18:33", BEACH[0], BEACH[1], HOME[0], HOME[1], 6800),
      ],
    }],
  };
}

function beachStop() {
  return {
    id: "s-beach", start: "18:01", end: "18:20",
    start_ts_ms: ms("18:01"), end_ts_ms: ms("18:20"), duration_min: 18,
    ...LL(0.0, 0.0), pattern: "browse",
    place: { name: "Venue Example", source: "osm_overpass", confidence: 0.8 },
    photos: [], companions: [],
  };
}

function homeStop() {
  return {
    id: "s-home", start: "07:25", end: "16:43",
    start_ts_ms: ms("07:25"), end_ts_ms: ms("16:43"), duration_min: 558,
    lat: HOME[0], lon: HOME[1], pattern: "dwell",
    place: { name: "Villa Example", source: "named_location", confidence: 0.95 },
    photos: [], companions: [],
  };
}

test("a walk that returns to where it started is a place, not a pass-through", () => {
  const stops = [beachStop()];
  const { demoted, kept } = markMovementByPace(stops, beachEveningPath());

  assert.equal(stops[0].is_movement, undefined, "the beach must survive the pace test");
  assert.equal(demoted.length, 0);
  assert.equal(kept.length, 1);
  // it really did clear the old threshold — this is not a pace that got quieter
  assert.ok(kept[0].kmh >= 1.8, `expected walking pace, got ${kept[0].kmh}`);
  assert.match(kept[0].reason, /returned to within|doubling back/);
});

test("a genuine pass-through is still deleted", () => {
  // The case the pace test was built for (a city day): a continuous walk
  // with a venue invented in the middle of it. Same pace, same duration as the
  // beach — but the user walks in, keeps walking, and comes out the far side.
  const through = {
    ...beachStop(), id: "s-through",
    place: { name: "Bistrot Example", source: "osm_overpass", confidence: 0.5 },
  };
  const dayPath = {
    segments: [{
      legs: [
        leg("17:50", "18:01", ...PT(-55.63, -1085.93), ...PT(-55.62, -50.7), 1100),
        leg("18:01", "18:11", ...PT(-55.62, -50.7), ...PT(-55.62, 470.8), 520),
        leg("18:11", "18:20", ...PT(-55.62, 470.8), ...PT(-55.62, 982.3), 520),
        leg("18:20", "18:33", ...PT(-55.62, 982.3), ...PT(-55.61, 2138.72), 1150),
      ],
    }],
  };
  const { demoted } = markMovementByPace([through], dayPath);
  assert.equal(through.is_movement, true, "walking that goes somewhere is still movement");
  assert.equal(demoted.length, 1);
});

test("gridlock between two drives is not promoted into a stop", () => {
  // 3 km/h average, bracketed by fast driving — but the window itself contains a
  // 40 km/h leg, so the user never left the car.
  const crawl = {
    ...beachStop(), id: "s-crawl", lat: 25.9, lon: -80.15,
    place: { name: "Some Shop", source: "osm_overpass", confidence: 0.5 },
  };
  const dayPath = {
    segments: [{
      legs: [
        leg("17:50", "18:01", HOME[0], HOME[1], 25.9, -80.15, 6000),
        leg("18:01", "18:18", 25.9, -80.15, ...PT(-2601.24, 1805.4), 300),
        leg("18:18", "18:20", ...PT(-2601.24, 1805.4), ...PT(-1800.92, 2694.82), 1400),  // 42 km/h
        leg("18:20", "18:33", ...PT(-1800.92, 2694.82), HOME[0], HOME[1], 6000),
      ],
    }],
  };
  markMovementByPace([crawl], dayPath);
  assert.equal(crawl.is_movement, true, "a traffic crawl must not become a venue");
});

test("a stop the user named is never demoted, whatever its pace", () => {
  // Supermarket, 2026-08-14: 3.23 km/h — faster than the stop that was deleted.
  const publix = {
    ...beachStop(), id: "s-publix",
    place: { name: "Supermarket", source: "user_confirmed", confidence: 1 },
  };
  markMovementByPace([publix], beachEveningPath());
  assert.notEqual(publix.is_movement, true);
});

test("the reconciler bills a drive at driving pace, not walking pace", () => {
  const path5900m = beachEveningPath();
  const pace = crossingPaceMPerH(path5900m, ms("16:43"), ms("18:01"));
  assert.ok(pace > RECONCILE_PACE_M_PER_H,
    `observed driving must beat the walking floor, got ${pace} m/h`);

  const stops = [homeStop(), beachStop()];
  reconcileStopTimeline(stops, path5900m);
  const beach = stops.find(s => s.id === "s-beach");
  assert.equal(beach.duration_min, 18,
    "78 minutes of slack covers a 5.9 km drive — nothing to reconcile");
  assert.equal(beach.start, "18:01");
});

test("with no trace in the gap the reconciler still assumes walking", () => {
  // Evidence, not optimism: silence must not buy a stop a free pass.
  const emptyPath = { segments: [{ legs: [] }] };
  assert.equal(crossingPaceMPerH(emptyPath, ms("16:43"), ms("18:01")),
               RECONCILE_PACE_M_PER_H);
});

test("a 3-second GPS artifact does not become the crossing speed", () => {
  // The real 2026-08-15 trace carries a 3s/195m leg (234 km/h) and a
  // zero-duration 510m one. Reading either as "how fast the user could travel" let the
  // reconciler wave through timelines that are actually impossible.
  const dayPath = {
    segments: [{
      legs: [
        { ...leg("17:00", "17:00", HOME[0], HOME[1], BEACH[0], BEACH[1], 510), t1: ms("17:00") },
        leg("17:00", "17:01", HOME[0], HOME[1], ...PT(-5802.96, -306.28), 195),   // 3s-equivalent artifact
        leg("17:10", "17:30", HOME[0], HOME[1], ...PT(-4802.27, 471.68), 1600),  // 4.8 km/h, real
      ],
    }],
  };
  // 195 m in 60 s is 11.7 km/h; the artifact leg is exactly at the minimum
  // duration, so what must NOT survive is the zero-duration 510 m leg.
  const pace = crossingPaceMPerH(dayPath, ms("17:00"), ms("17:30"));
  assert.ok(Number.isFinite(pace), "a zero-duration leg must not yield Infinity");
  assert.ok(pace <= 130_000, `capped at ground speed, got ${pace}`);
});

test("the overlap is paid by the stop the trace contradicts, not the weaker name", () => {
  // 2026-08-15 exactly: the home stop claimed until 22:32 while the beach ran
  // 18:01-18:20 with every fix 5.9 km away. "Villa Example" is the better-named
  // stop, so trust alone handed the whole 270-minute overlap to the beach and
  // crushed it to the 60-second floor.
  const home = { ...homeStop(), end_ts_ms: ms("22:32"), end: "22:32", duration_min: 907 };
  const beach = beachStop();
  const dayPath = beachEveningPath();

  assert.equal(contradictedByTrace(dayPath, home, beach), "a",
    "no fix supports home during 18:01-18:20; every fix supports the beach");

  const stops = [home, beach];
  reconcileStopTimeline(stops, dayPath);
  assert.equal(beach.start_ts_ms, ms("18:01"), "the beach keeps its full window");
  assert.equal(beach.end_ts_ms, ms("18:20"));
  assert.ok(home.end_ts_ms < ms("18:01"), "home gives up the end it could not support");
});

test("both rules together put the beach back in the narrative", () => {
  const stops = [homeStop(), beachStop()];
  const dayPath = beachEveningPath();
  markMovementByPace(stops, dayPath);
  reconcileStopTimeline(stops, dayPath);
  const beach = stops.find(s => s.id === "s-beach");
  assert.equal(render.isMainStop(beach), true,
    "the stop the summary said did not exist");
});

// ---------------------------------------------------------------------------
// The second Store — a cluster's span is a floor, not a measurement
// ---------------------------------------------------------------------------
//
// Two visits to stores of one chain, a fairly short time in each. iOS logged the Southvale visit 18:49:50-
// 19:04:10 (14 min); the clustering only saw fixes from 18:54 to 19:02 and
// produced 8, which fell under SHORT_STOP_MIN and was absorbed into its
// neighbour. The stop existed in two places at once and the shorter one won.

const branchStop = () => ({
  id: "s-branch", start: "18:54", end: "19:02",
  start_ts_ms: ms("18:54"), end_ts_ms: ms("19:02"), duration_min: 8,
  ...LL(-1997.88, 9732.6), pattern: "dwell",   // 176m from the CLVisit anchor
  place: { name: "Pancake House Example", source: "osm_overpass", confidence: 0.5 },
  photos: [], companions: [],
});
const branchVisit = {
  ...LL(-1877.94, 9603.37), name: "21211 Main Blvd", ptype: "address",
  start_ms: ms("18:49"), end_ms: ms("19:04"), mins: 14,
};

test("a CLVisit row widens the cluster it belongs to, and the stop survives", () => {
  const stops = [homeStop(), branchStop()];
  const widened = widenToBackingVisits(stops, { visits: [branchVisit] });
  const av = stops.find(s => s.id === "s-branch");

  assert.equal(widened.length, 1);
  assert.equal(av.start_ts_ms, ms("18:49"), "iOS knew when the user arrived");
  assert.equal(av.duration_min, 15);
  assert.equal(av.backed_by_visit, true);
  // and now it clears the short-stop floor instead of being absorbed
  assert.ok(dropShortStops(stops).includes(av), "the second Store survives");
});

test("176m of CLVisit anchor error does not count as a different place", () => {
  // The real gap between this cluster's centroid and iOS's anchor for the same
  // visit. A 150m radius rejected it; the anchor is a single raw coordinate
  // whose own accuracy has been measured at 106m, so 176m is noise.
  const { haversineMeters } = require(path.join(ROOT, "lib/known-stops.js"));
  const d = haversineMeters(...PT(-1997.88, 9732.6), branchVisit.lat, branchVisit.lon);
  assert.ok(d > 150 && d < 250, `expected ~176m, got ${Math.round(d)}m`);

  // ...but a genuinely different place still is one.
  const far = { ...branchVisit, ...LL(-2299.72, 10033.76) };
  const stops = [branchStop()];
  assert.equal(widenToBackingVisits(stops, { visits: [far] }).length, 0,
    "a row 500m away is not this stop's row");
});

test("an overnight container never widens an errand", () => {
  // The 2026-08-14 row ran 19:30 into the NEXT evening and overlapped the beach
  // stop. A row that covers a different stop is a container, not this window.
  const overnight = { lat: HOME[0], lon: HOME[1], name: "Villa Example", ptype: "named",
                      start_ms: ms("06:00"), end_ms: ms("23:59"), mins: 1079 };
  const stops = [homeStop(), beachStop()];
  const widened = widenToBackingVisits(stops, { visits: [overnight] });
  assert.equal(widened.length, 0, "a row spanning another stop may not widen anything");
  assert.equal(stops.find(s => s.id === "s-beach").duration_min, 18);
});

test("a flight is surfaced as a conflict, never trimmed away", () => {
  // 2026-08-12: "Somewhere else" -> "Airport Lounge, Example Airport", 1449 km
  // apart. Billed at walking pace the reconciler demanded 23,547 minutes of
  // travel and took 23,328 of them out of the earlier stop.
  const earlier = { ...homeStop(), id: "s-earlier" };
  const faraway = {
    id: "s-faraway", start: "18:00", end: "19:00",
    start_ts_ms: ms("18:00"), end_ts_ms: ms("19:00"), duration_min: 60,
    ...LL(5673705.21, 3483377.48), pattern: "dwell",
    place: { name: "Airport Lounge, Example Airport", source: "osm_overpass", confidence: 0.8 },
    photos: [], companions: [],
  };
  const stops = [earlier, faraway];
  const before = earlier.end_ts_ms;
  const { adjustments, conflicts } = reconcileStopTimeline(stops, beachEveningPath());

  assert.equal(adjustments.length, 0, "nothing may be trimmed across an ocean");
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].reason, /ground travel/);
  assert.equal(earlier.end_ts_ms, before, "the earlier stop keeps its hours");
});

test("two branches of the same chain are two stops, not one split visit", () => {
  // 2026-08-14: Store North then Store South, 8 km and 16 minutes
  // apart. mergeSplitVisits matched on the name alone and folded them into one.
  const t1 = {
    id: "s-t1", start: "18:11", end: "18:34",
    start_ts_ms: ms("18:11"), end_ts_ms: ms("18:34"), duration_min: 23,
    ...LL(-3481.31, 2358.24),
    place: { name: "Store", source: "user_confirmed", confidence: 1 },
    photos: [], companions: [],
  };
  const t2 = {
    ...t1, id: "s-t2", start: "18:50", end: "19:04",
    start_ts_ms: ms("18:50"), end_ts_ms: ms("19:04"), duration_min: 14,
    ...LL(-1877.94, 9603.37),
  };
  assert.equal(mergeSplitVisits([t1, t2]).length, 2, "8 km apart is two stores");

  // ...but a genuine split visit (same place, recorded twice) still merges.
  const near = { ...t2, ...LL(-3491.31, 2372.7) };
  assert.equal(mergeSplitVisits([t1, near]).length, 1, "same place, one visit");
});

test("two visits to one place are NOT merged across a stop somewhere else (2026-10-07 Airbnb/bakery)", () => {
  const { mergeSplitVisits } = require("../lib/resolve-day.js")._internal;
  const at = (h, m) => Date.parse(`2026-10-07T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+03:00`);
  const st = (id, name, a, b, [lat, lon]) => ({ id, place: { name, source: "user_confirmed" }, start_ts_ms: a, end_ts_ms: b, lat, lon, photos: [], companions: [] });
  const out = mergeSplitVisits([
    st("a1", "the airbnb", at(7, 0), at(8, 13), PT(0.0, 0.0)),
    st("mb", "מאפיית דוגמה", at(8, 39), at(9, 23), PT(217.7, 134.55)),
    st("pt", "Print shop", at(9, 25), at(9, 41), PT(447.66, -97.84)),
    st("a2", "the airbnb", at(9, 41), at(10, 41), PT(0.0, 0.0)),
  ]);
  assert.deepEqual(out.map(s => s.id), ["a1", "mb", "pt", "a2"]);
  assert.equal(out[0].end_ts_ms, at(8, 13));
});

// ---------------------------------------------------------------------------
// vehicleBracketed: a real stop between two city drives was called traffic.
//
// Two measured defects on one real day, both of which read a stop as movement
// and sent its photos to the stop before it:
//   (a) the drive in was ONE city-street leg, 1647 m in 4 min 18 s = 23.0 km/h,
//       under the 25 km/h vehicle line, so "arrived by vehicle" was false;
//   (b) the drive away began ~33 s before the window's end, and legsIn() hands
//       back every leg that merely OVERLAPS the window, so that departure was
//       counted as the user driving inside the window ("gridlock") before the
//       bracket was even looked at.
// ---------------------------------------------------------------------------
const msS = (hms) => Date.parse(`2026-08-15T${hms}-04:00`);
const legS = (t0, t1, a, b, m) => ({ t0: msS(t0), t1: msS(t1), lat0: a[0], lon0: a[1], lat1: b[0], lon1: b[1], m });
const W0 = "11:03:11", W1 = "11:22:00";             // the ~19-minute window
const bracketStop = () => ({
  id: "s-bracket", start: "11:03", end: "11:22", start_ts_ms: msS(W0), end_ts_ms: msS(W1),
  duration_min: 19, ...LL(0.0, 0.0), pattern: "browse",
  place: { name: "Cafe Example", source: "osm_overpass", confidence: 0.6 },
  photos: [], companions: [],
});
// On foot inside the window: 256 m at 5.1 km/h, then 390 m at 2.3 km/h.
const footB = () => legS("11:03:30", "11:06:31", PT(0, 0), PT(150, 180), 256);
const footC = (end = "11:21:10", m = 390) => legS("11:11:00", end, PT(150, 180), PT(260, 420), m);
// The real day's drive in: a 2 s artifact leg, then 1647 m in 258 s = 23.0 km/h.
const slowCityDriveIn = () => [
  legS("10:58:28", "10:58:30", PT(-1700, -800), PT(-1500, -800), 199),
  legS("10:58:30", "11:02:48", PT(-1500, -800), PT(0, 0), 1647),
];
const fastDriveIn = () => [legS("10:58:00", "11:02:00", PT(-2000, -1000), PT(0, 0), 2667)];   // 40 km/h
const pathOf = (...legs) => ({ segments: [{ legs: legs.flat() }] });
const runBracket = (dayPath) => {
  const s = bracketStop();
  const out = markMovementByPace([s], dayPath);
  return { s, out };
};
const assertSpared = ({ s, out }) => {
  assert.notEqual(s.is_movement, true, "a real stop between two drives must stay a stop");
  assert.match(s.movement_spared_reason, /arrived by vehicle and left by vehicle/);
  assert.equal(out.kept.length, 1);
  assert.equal(out.demoted.length, 0);
};
const assertDemoted = ({ s, out }) => {
  assert.equal(s.is_movement, true);
  assert.equal(s.movement_spared_reason, undefined);
  assert.equal(out.demoted.length, 1);
};

test("a stop between a 23 km/h city drive in and a drive away that starts ~33 s before the window ends is kept", () => {
  // The real day: one slow street leg in, on-foot legs inside, then a 989 m leg at
  // 29.4 km/h from 11:21:27 (33 s before the end) and a 752 m leg at 25.5 km/h.
  const dayPath = pathOf(
    slowCityDriveIn(), footB(), footC(),
    legS("11:21:27", "11:23:28", PT(260, 420), PT(880, 1160), 989),
    legS("11:23:28", "11:25:14", PT(880, 1160), PT(1300, 1760), 752),
  );
  const r = runBracket(dayPath);
  assertSpared(r);
  assert.ok(r.s.pace_kmh >= 1.8, "it really did clear the walking-pace test");
  assert.equal(_internal.vehicleBracketed(dayPath, msS(W0), msS(W1)), true);
});

test("only the departure rule is needed: a fast drive in, a departure leg that starts in the window's last seconds", () => {
  // Old failure (b) alone: the 29.4 km/h departure counted as a leg INSIDE the window.
  const dayPath = pathOf(
    fastDriveIn(), footB(), footC(),
    legS("11:21:27", "11:23:28", PT(260, 420), PT(880, 1160), 989),
  );
  assertSpared(runBracket(dayPath));
});

test("only the slow-leg rule is needed: a 23 km/h street leg in, a plain fast drive away", () => {
  // Old failure (a) alone: 1647 m at 23.0 km/h is under the 25 km/h line.
  const dayPath = pathOf(
    slowCityDriveIn(), footB(), footC(),
    legS("11:22:00", "11:26:00", PT(260, 420), PT(1700, 1700), 3000),     // 45 km/h, after the window
  );
  assertSpared(runBracket(dayPath));
});

test("an arrival leg that ends seconds inside the window is the arrival, not the window", () => {
  // Mirror of (b): the drive in ends 30 s after the window's start.
  const dayPath = pathOf(
    legS("11:00:00", "11:03:41", PT(-2000, -1000), PT(0, 0), 2300),       // 37 km/h, 30 s of it inside
    footB(), footC(),
    legS("11:22:00", "11:26:00", PT(260, 420), PT(1700, 1700), 3000),
  );
  assertSpared(runBracket(dayPath));
});

test("a drive in that is short and slow (600 m at 20 km/h) is not a vehicle leg", () => {
  // Under 25 km/h AND under a kilometre: a jog or a crowded pavement, not a car.
  const dayPath = pathOf(
    legS("11:00:00", "11:01:48", PT(-500, -300), PT(0, 0), 600),
    footB(), footC(),
    legS("11:22:00", "11:26:00", PT(260, 420), PT(1700, 1700), 3000),
  );
  const r = runBracket(dayPath);
  assertDemoted(r);
  assert.equal(_internal.vehicleBracketed(dayPath, msS(W0), msS(W1)), false);
});

test("a fast leg just under a kilometre (990 m at 17.8 km/h) is not a vehicle leg either", () => {
  const dayPath = pathOf(
    legS("10:59:00", "11:02:20", PT(-800, -500), PT(0, 0), 990),          // 990 m in 200 s = 17.8 km/h
    footB(), footC(),
    legS("11:22:00", "11:26:00", PT(260, 420), PT(1700, 1700), 3000),
  );
  assert.equal(_internal.vehicleBracketed(dayPath, msS(W0), msS(W1)), false);
});

test("a long leg below the slow line (13 km/h over 2 km) is not a vehicle leg", () => {
  const dayPath = pathOf(
    legS("10:53:56", "11:03:10", PT(-1500, -1300), PT(0, 0), 2000),       // 12.99 km/h
    footB(), footC(),
    legS("11:22:00", "11:26:00", PT(260, 420), PT(1700, 1700), 3000),
  );
  const r = runBracket(dayPath);
  assertDemoted(r);
});

test("a slow vehicle leg only on one side is not a bracket", () => {
  // Arrived by a 23 km/h street drive, but nothing vehicle-like leaves.
  const dayPath = pathOf(
    slowCityDriveIn(), footB(), footC(),
    legS("11:22:00", "11:30:00", PT(260, 420), PT(700, 900), 700),        // 5.3 km/h: walking on
  );
  assertDemoted(runBracket(dayPath));
});

test("gridlock inside the window is still not a stop, even with a slow-vehicle arrival", () => {
  // A 42 km/h leg WHOLLY inside the window means the user never left the car.
  const dayPath = pathOf(
    slowCityDriveIn(),
    footB(),
    legS("11:07:00", "11:09:00", PT(150, 180), PT(600, 1400), 1400),      // 42 km/h, wholly inside
    legS("11:11:00", "11:21:10", PT(600, 1400), PT(700, 1750), 390),
    legS("11:22:00", "11:26:00", PT(700, 1750), PT(1700, 1700), 3000),
  );
  const r = runBracket(dayPath);
  assertDemoted(r);
  assert.equal(_internal.vehicleBracketed(dayPath, msS(W0), msS(W1)), false);
});

test("a departure leg with 60% of it inside the window is the window's own driving: gridlock, not a stop", () => {
  // 300 s leg at 45 km/h starting 180 s before the end: most of it is INSIDE.
  const dayPath = pathOf(
    fastDriveIn(), footB(), footC("11:18:30"),
    legS("11:19:00", "11:24:00", PT(260, 420), PT(1700, 1700), 3750),
  );
  const r = runBracket(dayPath);
  assertDemoted(r);
  assert.equal(_internal.vehicleBracketed(dayPath, msS(W0), msS(W1)), false);
});

test("the same departure with only 40% inside the window is the departure: the stop is kept", () => {
  // 300 s leg starting 120 s before the end.
  const dayPath = pathOf(
    fastDriveIn(), footB(), footC("11:19:30"),
    legS("11:20:00", "11:25:00", PT(260, 420), PT(1700, 1700), 3750),
  );
  assertSpared(runBracket(dayPath));
});

test("a window whose only on-foot leg is mostly outside it is read as before, not abstained on", () => {
  // No leg of the window's own (the one walking leg is 27% inside): the guard falls
  // back to what overlaps, so a slow leg still lets the bracket decide...
  const dayPath = pathOf(
    fastDriveIn(),
    legS("11:19:00", "11:30:00", PT(0, 0), PT(300, 500), 700),            // 3.8 km/h walk, 180 s of 660 s inside
    legS("11:30:00", "11:35:00", PT(300, 500), PT(1700, 1700), 3750),
  );
  assert.equal(_internal.vehicleBracketed(dayPath, msS(W0), msS(W1)), true);
  // ...and a fast fringe leg with nothing on foot is still driving, not a stop.
  const drivingOnly = pathOf(
    fastDriveIn(),
    legS("11:20:00", "11:25:00", PT(0, 0), PT(1700, 1700), 3750),         // 45 km/h, 40% inside
  );
  assert.equal(_internal.vehicleBracketed(drivingOnly, msS(W0), msS(W1)), false);
});
