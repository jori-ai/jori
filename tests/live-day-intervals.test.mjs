// live-day-intervals.test.mjs — a geofence may fill the gaps BETWEEN recorded
// visits; it may not blanket them.
//
// Regression fixture: a real archive's shape, with synthetic places
// (tests/fixtures/fake-geo.mjs keeps the metres between points). It held
// exactly ONE interval — the house, named_location, conf 0.95, 04:00Z to 02:11Z
// the next morning, 1332 minutes — while location_history held three visit
// rows for that evening's walk, all written to the DB hours before the
// midnight archive ran, each 190-720 m from the house. The 150 m home geofence
// absorbed all three, so a day that contained a walk was archived as a day
// spent indoors. Same class as "the daily summary missed the evening dog walk".

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const { computeAccuracy, _internal } = require("../lib/live-day.js");
const { normalizeVisits, splitOnNamedVisits, GEOFENCE_YIELD_M, REMAINDER_MIN_MS } = _internal;

const ms = (iso) => Date.parse(iso);

// The house, as the archive recorded it.
const HOME = at(0, 0);
// A visit row's coordinate, `e` metres east and `n` north of the house.
const ll = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon }; };

function host({
  start = "2026-08-24T04:00:00.000Z",
  end = "2026-08-25T02:11:54.000Z",
  source = "named_location",
  name = "Home Example",
} = {}) {
  return {
    id: `iv-gps-${ms(start)}`,
    start, end,
    start_ts_ms: ms(start),
    end_ts_ms: ms(end),
    open: false,
    type: "stop",
    place: { name, source, confidence: 0.95, ...HOME, address: "1 Example St" },
    calendar: null,
    gps_status: "supports",
    companions: [],
    photos: [],
    duration_min: Math.round((ms(end) - ms(start)) / 60_000),
    pattern: "dwell",
    activity_hint: null,
    evidence_log: [{ ts: "2026-08-25T02:20:10.812Z", source: "gps_dwell", claim: "1332min cluster", outcome: "interval_created" }],
  };
}

const row = (o) => ({ place_type: "address", accuracy_m: 30, ...o });

// The three street stops of that evening's walk, as location_history held them.
const WALK = [
  row({ arrived_at: "2026-08-24T22:30:44+00:00", departed_at: "2026-08-24T22:38:07+00:00", ...ll(321.27, -529.18), place_name: "101 Main St", accuracy_m: 34.688162373714 }),
  row({ arrived_at: "2026-08-24T22:38:12+00:00", departed_at: "2026-08-24T22:48:08+00:00", ...ll(165.55, -695.83), place_name: "202 Oak Ct", accuracy_m: 117.541160386141 }),
  row({ arrived_at: "2026-08-24T22:48:19+00:00", departed_at: "2026-08-24T22:48:32+00:00", ...ll(112.93, -153.13), place_name: "303 Oak Ct", accuracy_m: 28.6721675106434 }),
];

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

test("a day whose visits resolve to several distinct venues is never one interval", () => {
  const visits = normalizeVisits(WALK);
  assert.equal(visits.length, 3, "all three walk rows must survive normalization");

  const { intervals, splits } = splitOnNamedVisits([host()], visits);

  assert.ok(intervals.length > 1,
    "a day containing three distinct named venues must not archive as a single interval");
  assert.equal(intervals.length, 5, "home, three stops, home");

  const names = intervals.map(i => i.place.name);
  for (const r of WALK) assert.ok(names.includes(r.place_name), `${r.place_name} must have its own interval`);
  assert.equal(splits.length, 1);
  assert.equal(splits[0].yielded_to.length, 3);
  // Provenance is the point of the record: it must say how far away each was.
  assert.deepEqual(splits[0].yielded_to.map(y => y.away_m), [620, 716, 190]);
});

test("the walk stops become askable instead of hiding inside a confident name", () => {
  const day = { date: "2026-08-24", tz: "America/New_York", intervals: [host()] };
  const before = computeAccuracy(day, []);
  assert.equal(before.interval_count, 1);
  assert.equal(before.resolution_rate, 1, "the bug scored a perfect coverage rate");
  assert.equal(before.resolution_gaps.length, 0);

  const { intervals } = splitOnNamedVisits([host()], normalizeVisits(WALK));
  const after = computeAccuracy({ ...day, intervals }, []);

  assert.ok(after.interval_count >= 5);
  assert.ok(after.resolution_rate < 1,
    "a reverse-geocoded street number is a location, not a venue — it must not score as resolved");
  assert.equal(after.resolution_gaps.length, 3, "each walk stop is now a location-confirm candidate");
  // Splitting redistributes minutes; it must never invent or lose them.
  assert.equal(after.covered_min, before.covered_min);
});

// The pieces do NOT tile the host exactly, and the honest bound is worth more
// than a false invariant. A remainder under REMAINDER_MIN_MS is dropped, so a
// split loses under 60s per boundary. `covered_min` rounds to whole minutes and
// HIDES that; these assertions look at the milliseconds.
test("splitting never gains time, and loses only sub-floor remainders", () => {
  const h = host();
  const { intervals, splits } = splitOnNamedVisits([h], normalizeVisits(WALK));

  for (let i = 0; i < intervals.length - 1; i++) {
    assert.ok(intervals[i].end_ts_ms <= intervals[i + 1].start_ts_ms,
      "intervals must not overlap — that is how covered_min exceeds a day");
  }
  assert.ok(intervals[0].start_ts_ms >= h.start_ts_ms, "no piece may start before the host");
  assert.ok(intervals[intervals.length - 1].end_ts_ms <= h.end_ts_ms, "nor end after it");

  const hostMs = h.end_ts_ms - h.start_ts_ms;
  const pieceMs = intervals.reduce((s, i) => s + (i.end_ts_ms - i.start_ts_ms), 0);
  const lostMs = hostMs - pieceMs;
  assert.ok(lostMs >= 0, "splitting must never invent time");
  // The 5s gap between the first two walk rows and the 11s gap before the
  // third. Exactly the two sub-floor remainders, and nothing else.
  assert.equal(lostMs, 16_000);
  assert.equal(splits[0].dropped_sec, 16, "the loss is recorded, not hidden");
  // The general bound: at most one sub-floor remainder per boundary.
  assert.ok(lostMs < REMAINDER_MIN_MS * (splits[0].yielded_to.length + 1));
  // And this is precisely what covered_min's rounding conceals.
  assert.equal(Math.round(hostMs / 60_000), Math.round(pieceMs / 60_000));
});

// ---------------------------------------------------------------------------
// A quiet day must stay quiet
// ---------------------------------------------------------------------------

test("a genuine all-day stay at home still yields one interval", () => {
  // The quiet day's rows: photo coordinates at the house, nothing else.
  const rows = [
    { place_type: "photo-synthesized", arrived_at: "2026-08-23T17:35:16.686+00:00", departed_at: "2026-08-23T17:40:16.686+00:00", ...ll(0.6, -0.33), place_name: "(photo-inferred)", accuracy_m: null },
    { place_type: "photo-synthesized", arrived_at: "2026-08-23T23:25:53+00:00", departed_at: "2026-08-23T23:44:45.339+00:00", ...ll(0.6, -0.33), place_name: "(photo-inferred)", accuracy_m: null },
  ];
  const h = host({ start: "2026-08-23T12:23:03.000Z", end: "2026-08-23T21:12:52.000Z" });
  const { intervals, splits } = splitOnNamedVisits([h], normalizeVisits(rows));
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0], h, "an untouched day keeps the very same object");
  assert.equal(splits.length, 0);
});

test("a visit INSIDE the geofence is the same place and does not split it", () => {
  // The house's own `named` row, 0.5 m from the cluster centroid.
  const same = [row({ place_type: "named", arrived_at: "2026-08-24T15:00:00+00:00", departed_at: "2026-08-24T16:00:00+00:00", ...ll(0.33, -0.48), place_name: "Home Example", accuracy_m: 5 })];
  assert.equal(splitOnNamedVisits([host()], normalizeVisits(same)).intervals.length, 1);
});

test("only a geofence yields — a stop resolved on its own evidence is left alone", () => {
  for (const source of ["osm_overpass", "google_places", "user_confirmed", "accommodation", "neighborhood"]) {
    const h = host({ source });
    assert.equal(splitOnNamedVisits([h], normalizeVisits(WALK)).intervals.length, 1,
      `${source} is not a radius drawn around a place we already knew`);
  }
  for (const source of ["named_location", "known_recurring"]) {
    assert.equal(splitOnNamedVisits([host({ source })], normalizeVisits(WALK)).intervals.length, 5);
  }
});

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

// THE ORDERING REGRESSION. This is the one that matters.
//
// location_history really held a home row running 2026-08-22T18:40
// -> 2026-08-24T22:21, and it IS fetched for 2026-08-24. It misses that
// evening's walk by nine minutes. The first version of this fix passed only
// because of those nine minutes: the nested-row dedup in normalizeVisits ran
// BEFORE any container guard, so a container that reached the walk would have
// eaten all three rows on its way through — and splitOnNamedVisits, which knows
// perfectly well how to reject a container, would never have been shown one.
// Extend that row to 23:59 and the whole fix must still hold.
const CONTAINER_TO_2359 = row({
  place_type: "named",
  arrived_at: "2026-08-22T18:40:13+00:00",
  departed_at: "2026-08-24T23:59:00+00:00",
  ...ll(9.92, -4.77),
  place_name: "Home Example", accuracy_m: 31.3444959597879,
});

test("a container reaching the walk cannot swallow the rows it contains", () => {
  const rows = [CONTAINER_TO_2359, ...WALK];
  const visits = normalizeVisits(rows);

  assert.equal(visits.length, 3, "the three walk rows must survive normalization");
  assert.deepEqual(visits.map(v => v.name),
    ["101 Main St", "202 Oak Ct", "303 Oak Ct"]);
  assert.ok(!visits.some(v => v.name === "Home Example"),
    "the container is not evidence about any single stop");

  // And the day still splits exactly as it does without the container.
  const { intervals } = splitOnNamedVisits([host()], visits);
  assert.equal(intervals.length, 5);
  for (const r of WALK) {
    assert.ok(intervals.some(i => i.place.name === r.place_name), `${r.place_name} must survive`);
  }
});

test("nested containers collapse to the most specific row in one pass", () => {
  // A ⊃ B ⊃ C: only C is about a place.
  const A = row({ arrived_at: "2026-08-24T10:00:00+00:00", departed_at: "2026-08-24T20:00:00+00:00", ...ll(1101.17, -1395.78), place_name: "A" });
  const B = row({ arrived_at: "2026-08-24T12:00:00+00:00", departed_at: "2026-08-24T18:00:00+00:00", ...ll(1101.17, -1395.78), place_name: "B" });
  const C = row({ arrived_at: "2026-08-24T14:00:00+00:00", departed_at: "2026-08-24T15:00:00+00:00", ...ll(1101.17, -1395.78), place_name: "C" });
  assert.deepEqual(normalizeVisits([A, B, C]).map(v => v.name), ["C"]);
  // Order of arrival must not change the answer.
  assert.deepEqual(normalizeVisits([C, A, B]).map(v => v.name), ["C"]);
});

test("a container row spanning the whole host is a blanket, not a stop", () => {
  // location_history really held this: one home row 2026-08-22
  // 18:40 -> 2026-08-24 22:21, two and a half days long.
  const container = [row({ place_type: "named", arrived_at: "2026-08-22T18:40:13+00:00", departed_at: "2026-08-24T22:21:31+00:00", ...ll(-11902.52, 1945.41), place_name: "somewhere else", accuracy_m: 30 })];
  assert.equal(splitOnNamedVisits([host()], normalizeVisits(container)).intervals.length, 1);
});

test("a row sticking out of EITHER end of the host is a container", () => {
  const h = host({ start: "2026-08-24T04:00:00.000Z", end: "2026-08-24T20:00:00.000Z" });
  // Ends after the host. This is the shape that broke the first cut of this
  // fix: clipping it to the host's window turned a 2.7-day blanket into a
  // plausible-looking 1101-minute "stop".
  const trailing = [row({ arrived_at: "2026-08-24T10:00:00+00:00", departed_at: "2026-08-25T06:00:00+00:00", ...ll(-11902.52, 1945.41), place_name: "spills out the end" })];
  assert.equal(splitOnNamedVisits([h], normalizeVisits(trailing)).intervals.length, 1);
  // Starts before it.
  const leading = [row({ arrived_at: "2026-08-23T20:00:00+00:00", departed_at: "2026-08-24T06:00:00+00:00", ...ll(-11902.52, 1945.41), place_name: "spills out the start" })];
  assert.equal(splitOnNamedVisits([h], normalizeVisits(leading)).intervals.length, 1);
});

test("the timestamps PostgREST actually returns are strict ISO and parse", () => {
  // Verified against the live REST endpoint: location_history comes back as
  // "2026-08-22T18:40:13+00:00" — T-separated, full "+00:00" offset, strict
  // ISO 8601. (The space-separated "2026-08-22 18:40:13+00" form is psql's
  // console rendering, not the wire; an earlier draft of these fixtures wrongly
  // encoded it as verbatim and aimed a fragility warning at a shape that never
  // occurs.)
  for (const wire of ["2026-08-22T18:40:13+00:00", "2026-08-24T12:59:39.914+00:00"]) {
    assert.ok(Number.isFinite(Date.parse(wire)), `${wire} must parse`);
  }
  assert.equal(normalizeVisits(WALK).length, 3);
});

test("a timestamp we cannot parse complains instead of going quietly inert", () => {
  // If the wire format ever moves, EVERY row fails identically, the split stops
  // happening, and the blob returns with nothing in the record to say why.
  // That failure has to be audible.
  const orig = process.stderr.write;
  const warnings = [];
  process.stderr.write = (s) => { warnings.push(String(s)); return true; };
  try {
    assert.equal(normalizeVisits([row({ arrived_at: "24/08/2026 18:30", departed_at: "24/08/2026 18:38", ...ll(1101.17, -1395.78), place_name: "somewhere" })]).length, 0);
  } finally { process.stderr.write = orig; }
  assert.equal(warnings.length, 1);
  // Substring over a string WE emit — not a pattern applied to anything the user
  // wrote, so no model is owed here (Rule #0b).
  assert.ok(warnings[0].includes("unparseable visit arrived_at"));

  // An open row (departed_at null) is ordinary and must stay silent — only a
  // broken format talks, or the warning becomes noise nobody reads.
  const quiet = [];
  process.stderr.write = (s) => { quiet.push(String(s)); return true; };
  try {
    normalizeVisits([row({ arrived_at: "2026-08-24T22:30:44+00:00", departed_at: null, ...ll(1101.17, -1395.78), place_name: "still there" })]);
  } finally { process.stderr.write = orig; }
  assert.equal(quiet.length, 0);
});

test("a row overlapping more than one interval cannot re-cut either of them", () => {
  const a = host({ start: "2026-08-24T04:00:00.000Z", end: "2026-08-24T12:00:00.000Z" });
  const b = host({ start: "2026-08-24T12:30:00.000Z", end: "2026-08-24T20:00:00.000Z" });
  const straddling = [row({ arrived_at: "2026-08-24T11:00:00+00:00", departed_at: "2026-08-24T13:00:00+00:00", ...ll(1101.17, -1395.78), place_name: "straddler" })];
  assert.equal(splitOnNamedVisits([a, b], normalizeVisits(straddling)).intervals.length, 2);
});

test("duplicate rows under different ids produce one interval, not three", () => {
  // The 303 Oak Ct row landed three times, three ids, identical window.
  const triplicate = [WALK[2], { ...WALK[2] }, { ...WALK[2] }];
  assert.equal(normalizeVisits(triplicate).length, 1);
  const { intervals } = splitOnNamedVisits([host()], normalizeVisits(triplicate));
  assert.equal(intervals.filter(i => i.place.name === "303 Oak Ct").length, 1);
});

test("a nested row beats the row containing it — specificity wins", () => {
  const nested = [
    row({ arrived_at: "2026-08-24T22:00:00+00:00", departed_at: "2026-08-24T23:00:00+00:00", ...ll(1101.17, -1395.78), place_name: "long" }),
    row({ arrived_at: "2026-08-24T22:30:00+00:00", departed_at: "2026-08-24T22:40:00+00:00", ...ll(1101.17, -1395.78), place_name: "inner" }),
  ];
  // The container is the thing that hides places; the row inside it is the
  // place. This is the same judgement the walk rows depend on.
  assert.deepEqual(normalizeVisits(nested).map(v => v.name), ["inner"]);
});

test("rows that merely overlap are cut to one, so minutes are not double-counted", () => {
  // Neither contains the other, so there is no specificity to prefer — first
  // and longest wins, and the survivors must not overlap.
  const straddled = [
    row({ arrived_at: "2026-08-24T22:00:00+00:00", departed_at: "2026-08-24T22:40:00+00:00", ...ll(1101.17, -1395.78), place_name: "earlier" }),
    row({ arrived_at: "2026-08-24T22:30:00+00:00", departed_at: "2026-08-24T23:10:00+00:00", ...ll(1101.17, -1395.78), place_name: "later" }),
  ];
  const visits = normalizeVisits(straddled);
  assert.deepEqual(visits.map(v => v.name), ["earlier"]);
  for (let i = 0; i < visits.length - 1; i++) {
    assert.ok(visits[i].end_ms <= visits[i + 1].start_ms);
  }
});

test("recorded evidence keeps its length; our own arithmetic must earn its place", () => {
  const { intervals } = splitOnNamedVisits([host()], normalizeVisits(WALK));
  // The 13-second visit row survives — iOS deciding "this was a visit" IS
  // evidence, and a floor here would delete the smallest real stops.
  const tiny = intervals.find(i => i.place.name === "303 Oak Ct");
  assert.ok(tiny);
  assert.equal(tiny.end_ts_ms - tiny.start_ts_ms, 13_000);
  // The 5s and 11s slivers of "home" BETWEEN the walk stops do not: those are
  // gaps between two rows, not moments he was indoors.
  const homes = intervals.filter(i => i.place.name === "Home Example");
  assert.equal(homes.length, 2, "leading and trailing home only");
  for (const h of homes) assert.ok(h.end_ts_ms - h.start_ts_ms >= REMAINDER_MIN_MS);
});

test("a row too imprecise to place cannot move a 150m boundary", () => {
  const fuzzy = [row({ arrived_at: "2026-08-24T22:00:00+00:00", departed_at: "2026-08-24T22:30:00+00:00", ...ll(1101.17, -1395.78), place_name: "cell tower guess", accuracy_m: 1414 })];
  assert.equal(normalizeVisits(fuzzy).length, 0);
  // His own answer is absolute regardless of what the phone thought of the fix.
  const his = [{ ...fuzzy[0], place_type: "user-confirmed", place_name: "the barber" }];
  assert.equal(normalizeVisits(his).length, 1);
});

test("place_type is an allowlist of strings we generate, never a shape match", () => {
  const base = { arrived_at: "2026-08-24T22:00:00+00:00", departed_at: "2026-08-24T22:30:00+00:00", ...ll(1101.17, -1395.78), place_name: "x", accuracy_m: 30 };
  // Our own guess written back, a photo's coordinate, and him saying it was not
  // a stop at all — none of these may cut a day apart.
  for (const place_type of ["segment-derived", "photo-synthesized", "non-stop", null, undefined, "made-up"]) {
    assert.equal(normalizeVisits([{ ...base, place_type }]).length, 0, `${place_type} must not qualify`);
  }
  for (const place_type of ["address", "named", "poi", "user-confirmed"]) {
    assert.equal(normalizeVisits([{ ...base, place_type }]).length, 1, `${place_type} must qualify`);
  }
  // An open row has no window to cut with.
  assert.equal(normalizeVisits([{ ...base, place_type: "named", departed_at: null }]).length, 0);
  // A row with no name asserts no venue.
  assert.equal(normalizeVisits([{ ...base, place_type: "address", place_name: null }]).length, 0);
});

test("the yield radius matches the geofence that caused the absorption", () => {
  // Both answer the same question. If NAMED_LOCATION_MATCH_KM in
  // bin/location-segment moves, this must move with it.
  assert.equal(GEOFENCE_YIELD_M, 150);
});
