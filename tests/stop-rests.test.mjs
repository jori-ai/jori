// stop-rests.test.mjs — a place is where the trace STOOD STILL, not where its
// averaged position landed (the requirement: check progress through the route,
// not single points). Fixtures are real traces' geometry around a fake origin.
//
// The afternoon that showed it: resolve-day produced ONE stop covering
// 17:03-17:39 with a 203 m cluster radius, spanning three separate CLVisit rows
// 700 m apart, and named it after a big-box store ("Target" below) because the
// blend's centroid sat 72 m from the store — inside its 80 m proximity. During
// the window that carried the store's name the user was 75-288 m away and
// walking. The real store visit was 17:26:55-17:38:02, at 31-38 m.
//
// Run: node --test tests/stop-rests.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The fixtures' clock is UTC-4 in summer (their -04:00 offsets); resolve-day prints
// local times in the home zone, so the home zone is pinned to one on that clock.
process.env.JORI_TZ = "America/Toronto";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { findRests, restAt, splitStopOnRests, haversineMeters, SPLIT_RADIUS_M } =
  require(path.join(ROOT, "lib/stop-rests.js"));
const { splitWideStopsOnRests } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };

const T = (hms) => Date.parse(`2026-08-31T${hms}-04:00`);
const TARGET = fakePt(86.94, 85.29);   // known-recurring entry, proximity 80 m

// Every raw fix that afternoon, verbatim from location_history.
const PINGS = [
  { ts: T("17:03:09"), ...fakeAt(0, 0), acc: 39, kind: "visit",   activity: "stationary high" },
  { ts: T("17:04:16"), ...fakeAt(-76.49, -129.99), acc: 9,  kind: "transit", activity: "walking" },
  { ts: T("17:06:28"), ...fakeAt(0, 0), acc: 32, kind: "transit", activity: "walking" },
  { ts: T("17:12:07"), ...fakeAt(79.69, 159.9), acc: 28, kind: "transit", activity: "walking" },
  { ts: T("17:14:13"), ...fakeAt(203.36, 348.6), acc: 48, kind: "visit",   activity: "stationary high" },
  { ts: T("17:18:45"), ...fakeAt(203.27, 348.71), acc: 48, kind: "transit", activity: "walking" },
  { ts: T("17:26:11"), ...fakeAt(85.34, 160.79), acc: 22, kind: "transit", activity: "walking" },
  { ts: T("17:26:55"), ...fakeAt(52.99, 68.83), acc: 32, kind: "visit",   activity: "stationary high" },
  { ts: T("17:31:49"), ...fakeAt(56.36, 75.06), acc: 14, kind: "transit", activity: "walking" },
  { ts: T("17:38:02"), ...fakeAt(-14.66, -50.93), acc: 14, kind: "transit", activity: "walking" },
  { ts: T("17:43:26"), ...fakeAt(-152.4, -273.09), acc: 41, kind: "transit", activity: "unknown" },
];

// The blend, exactly as resolve-day had it after widenToBackingVisits.
const BLEND = {
  id: "s-20260831-2", start: "17:03", end: "17:39",
  start_ts_ms: T("17:03:00"), end_ts_ms: T("17:39:00"),
  duration_min: 36, ...fakeAt(27.46, 44.37),
  cluster_radius_km: 0.2029, sample_count: 7,
  place: { name: "Example Store", source: "known_recurring", confidence: 0.92, distance_m: 72 },
};

test("the afternoon holds exactly ONE rest: Target", () => {
  const rests = findRests(PINGS, BLEND.start_ts_ms, BLEND.end_ts_ms);
  assert.equal(rests.length, 1);
  assert.equal(rests[0].minutes, 11);
  assert.ok(haversineMeters(rests[0].lat, rests[0].lon, ...TARGET) < 45);
});

// The requirement: no stops made up while passing through, not even an
// unlabeled one at a favorited place. The 17:14
// turnaround reads exactly like standing still — two fixes 0.8 m apart over
// 4½ minutes — until you look at the accuracy on both: 48 m. At that precision
// the reading cannot tell standing from walking a block.
test("two loose fixes sitting on top of each other are not a rest", () => {
  const pair = PINGS.filter(p => p.ts === T("17:14:13") || p.ts === T("17:18:45"));
  assert.ok(haversineMeters(pair[0].lat, pair[0].lon, pair[1].lat, pair[1].lon) < 2,
    "precondition: they look motionless");
  assert.ok(pair.every(p => p.acc > 35), "precondition: and neither can prove it");
  assert.ok(pair.some(p => p.kind === "visit"),
    "precondition: iOS's own visit detector DID fire here");
  assert.deepEqual(findRests(pair, T("17:14:00"), T("17:26:30")), [],
    "corroboration cannot rescue fixes too loose to locate the user — the accuracy "
    + "gate runs first, and a 0.8 m spread inside a 48 m error bar is nothing");
});

// Same shape, 12 minutes later, at a precision that resolves the question.
test("the same shape at 14-32 m accuracy IS a rest", () => {
  const pair = PINGS.filter(p => p.ts === T("17:26:55") || p.ts === T("17:31:49"));
  const rests = findRests(pair, T("17:26:30"), T("17:38:10"));
  assert.equal(rests.length, 1);
  assert.equal(rests[0].minutes, 11);
});

// Silence is stillness: the rest runs to the fix that proves the user left, not to
// its own last ping.
test("a rest ends when the user turns up elsewhere, not at its own last fix", () => {
  const [rest] = findRests(PINGS, BLEND.start_ts_ms, BLEND.end_ts_ms);
  assert.equal(rest.start_ms, T("17:26:55"), "starts at the first fix of the group");
  assert.equal(rest.end_ms, T("17:38:02"), "ends at the first fix that proves the user was elsewhere");
  assert.ok(rest.end_ms > T("17:31:49"),
    "measuring to the group's own last fix would report 5 min instead of 11");
});

test("walking past a place is not a visit to it", () => {
  // The window that actually shipped under the store's name.
  const passing = restAt(PINGS, T("17:06:00"), T("17:21:00"), TARGET, 80);
  assert.equal(passing, null, "the user was 75-288 m away and moving the whole time");
  // Its centroid, meanwhile, matched comfortably — which is the bug.
  assert.ok(haversineMeters(...fakePt(27.46, 44.37), ...TARGET) < 80,
    "precondition: the blended centroid is inside Target's proximity radius");
});

test("the real Target visit is found, and it is later and closer", () => {
  const rest = restAt(PINGS, BLEND.start_ts_ms, BLEND.end_ts_ms, TARGET, 80);
  assert.ok(rest, "the trace did rest at Target");
  assert.equal(rest.start_ms, T("17:26:55"));
  assert.equal(rest.minutes, 11);
  assert.ok(rest.distance_m <= 40, `rest sat ${rest.distance_m} m out, vs 72 m for the blend`);
});

test("a 36-minute blend holding one 11-minute rest is tightened onto it", () => {
  const pieces = splitStopOnRests(BLEND, PINGS);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].minutes, 11);
  assert.equal(pieces[0].start_ms, T("17:26:55"));
  // The 33 minutes of walking either side are dropped, not folded in.
  assert.ok(pieces[0].start_ms > BLEND.start_ts_ms);
  assert.ok(pieces[0].end_ms < BLEND.end_ts_ms);
});

test("a tight cluster is never re-cut", () => {
  const tight = { ...BLEND, cluster_radius_km: 0.03 };
  assert.ok(0.03 * 1000 < SPLIT_RADIUS_M);
  assert.equal(splitStopOnRests(tight, PINGS), null);
});

test("a wide cluster whose trace shows one long rest is left alone", () => {
  const sitting = [
    { ts: T("17:00:00"), ...fakeAt(86.69, 83.95), acc: 20 },
    { ts: T("17:15:00"), ...fakeAt(88.37, 86.18), acc: 20 },
    { ts: T("17:29:00"), ...fakeAt(85.84, 85.06), acc: 20 },
  ];   // three precise fixes: stands without corroboration
  const wide = { ...BLEND, start_ts_ms: T("17:00:00"), end_ts_ms: T("17:30:00") };
  assert.equal(splitStopOnRests(wide, sitting), null,
    "a wide radius from indoor drift is not a walk with a mean");
});

test("a fix with no usable position never anchors a rest", () => {
  const noisy = [
    { ts: T("17:00:00"), ...fakeAt(86.69, 83.95), acc: 20, kind: "visit" },
    { ts: T("17:05:00"), ...fakeAt(8327.25, 6144.08), acc: 1414 },  // cell-tower fix
    { ts: T("17:20:00"), ...fakeAt(85.84, 85.06), acc: 20 },
  ];
  const rests = findRests(noisy, T("17:00:00"), T("17:30:00"));
  assert.equal(rests.length, 1, "the 1414 m fix is dropped, so the rest stays whole");
  assert.equal(rests[0].minutes, 30);
});

// ---------------------------------------------------------------------------
// The guard: a split has to change the answer.
// ---------------------------------------------------------------------------

// Naming a piece normally shells out to location-segment; stub it so these test
// the DECISION, not the resolver.
const nameBy = (fn) => (piece) => { piece.place = { name: fn(piece), address: null, source: "neighborhood", confidence: 0.6, distance_m: null }; };

test("the 203 m blend is retimed onto the one rest it actually holds", () => {
  const ctx = { date: "2026-08-31", knownStopsEntries: [], nameRest: nameBy(() => "Example Store") };
  const { stops, splits } = splitWideStopsOnRests([BLEND], PINGS, ctx);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].start, "17:26");
  assert.equal(stops[0].end, "17:38");
  assert.equal(splits[0].retimed_to, "17:26-17:38");
});

test("a blend holding two rests at two different places IS cut in two", () => {
  const twoPlaces = [
    { ts: T("17:00:00"), ...fakeAt(-5.98, -82.84), acc: 12, kind: "visit" },
    { ts: T("17:09:00"), ...fakeAt(-6.82, -81.73), acc: 12 },
    { ts: T("17:12:00"), ...fakeAt(204.62, 250.74), acc: 12, kind: "visit" },
    { ts: T("17:22:00"), ...fakeAt(203.78, 251.86), acc: 12 },
    { ts: T("17:30:00"), ...fakeAt(-174.48, -305.23), acc: 12 },
  ];
  const blend = { ...BLEND, start_ts_ms: T("17:00:00"), end_ts_ms: T("17:30:00"),
                  place: { name: null, source: "unknown", confidence: 0 } };
  const ctx = { date: "2026-08-31", knownStopsEntries: [],
    nameRest: nameBy(p => (p.lat > fakePt(0, 83.95)[0] ? "North place" : "South place")) };
  const { stops, splits } = splitWideStopsOnRests([blend], twoPlaces, ctx);
  assert.equal(stops.length, 2);
  assert.ok(splits[0].apart_m > 150, `rests ${splits[0].apart_m} m apart`);
  assert.deepEqual(splits[0].into.map(p => p.name), ["South place", "North place"]);
});

// 2026-08-29: a 173 m cluster at Little Island held two rests of 8 and 9 min,
// 87 m apart, both resolving to Meatpacking District — because they ARE the
// same place. Cutting it produced two identical halves and lost "Little Island".
test("a walk around inside one place is not two places", () => {
  const inside = [
    { ts: T("10:18:00"), ...fakeAt(-974.82, -216.27), acc: 20, kind: "visit" },
    { ts: T("10:26:00"), ...fakeAt(-975.66, -215.16), acc: 20 },
    { ts: T("10:30:00"), ...fakeAt(-1008.5, -138.44), acc: 20, kind: "visit" },
    { ts: T("10:38:00"), ...fakeAt(-1007.66, -137.33), acc: 20 },
    { ts: T("10:40:00"), ...fakeAt(-764.17, 28.35), acc: 20 },
  ];
  const park = { id: "s-1", start: "10:18", end: "10:40",
    start_ts_ms: T("10:18:00"), end_ts_ms: T("10:40:00"), duration_min: 22,
    ...fakeAt(-991.66, -194.04), cluster_radius_km: 0.173,
    place: { name: "Little Island", source: "osm_overpass", confidence: 0.5 } };
  const ctx = { date: "2026-08-29", knownStopsEntries: [], nameRest: nameBy(() => "Meatpacking District") };
  const { stops, splits } = splitWideStopsOnRests([park], inside, ctx);
  assert.equal(stops.length, 1, "the stop survives whole");
  assert.equal(stops[0].place.name, "Little Island", "and keeps its name");
  assert.equal(splits[0].kept_whole, true);
  assert.match(splits[0].reason, /same place/);
});

test("a stop the user confirmed is never re-cut", () => {
  const his = { ...BLEND, place: { name: "Example Dim Sum", source: "user_confirmed", confidence: 1 } };
  const ctx = { date: "2026-08-31", knownStopsEntries: [], nameRest: nameBy(() => "somewhere") };
  const { stops, splits } = splitWideStopsOnRests([his], PINGS, ctx);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].place.name, "Example Dim Sum");
  assert.equal(splits.length, 0);
});

// A closing at a law office was followed by lunch at a restaurant 167 m away
// on the same block. The raw trace shows it plainly -- a 52-minute rest at
// the office, a 43-minute silence, then a real ~20-minute rest 145.7 m away
// ("at least 20 minutes", per the user) -- but the blend's own cluster radius
// (107.4 m) sat under the old 120 m SPLIT_RADIUS_M bar by 12.6 m, and even had
// it cleared that bar, the two rests' 145.7 m separation sat under the old
// 150 m SPLIT_SEPARATION_M bar by 4.3 m. Two distinct storefronts a block
// apart on a dense urban avenue are closer together than either bar had ever
// been tested against.
//
// In production this specific stop is ALSO protected by a
// `place.source === "user_confirmed"` write from an automated calendar match
// (never an actual answer from the user) — a separate, deeper conflation that
// skips splitWideStopsOnRests outright regardless of geometry, tracked on its
// own. This test covers the geometric half: the same raw trace, if it ever
// reaches splitStopOnRests, now correctly reads as two places instead of one.
const T29 = (hms) => Date.parse(`2026-09-29T${hms}-04:00`);

// Verbatim from location_history, duplicates and all -- the table holds some
// of these rows twice or three times (two writers; see mergeDuplicateStops'
// own comment above), and that duplication is load-bearing here: it is what
// gives the restaurant-adjacent rest enough INDEPENDENT precise fixes to stand
// without a corroborating CLVisit/stationary tag (REST_UNCORROBORATED_PRECISE).
// A cleaned-up, de-duplicated version of this same trace has only 2 precise
// fixes there and correctly does NOT qualify as a rest on its own — de-duping
// before testing would have hidden the real shape of the evidence.
const CLOSING_LUNCH_PINGS = [
  { ts: T29("11:40:55"), ...fakeAt(3144.07, -18575.16), acc: 46.585333799818, activity: "stationary", kind: "visit" },
  { ts: T29("11:40:55"), ...fakeAt(3144.07, -18575.16), acc: 46.585333799818, activity: "stationary", kind: "visit" },
  { ts: T29("11:42:08"), ...fakeAt(3176.29, -18581.37), acc: 14, kind: "transit", activity: "driving" },
  { ts: T29("11:42:08"), ...fakeAt(3176.29, -18581.37), acc: 14, kind: "transit", activity: "driving" },
  { ts: T29("11:49:59"), ...fakeAt(3138.41, -18571.07), acc: 16.5720212426999, kind: "transit", activity: "unknown" },
  { ts: T29("11:50:08"), ...fakeAt(3141.51, -18575.52), acc: 19.9835117557905, kind: "transit", activity: "unknown" },
  { ts: T29("11:50:11"), ...fakeAt(3141.52, -18575.51), acc: 19.9990898629028, kind: "transit", activity: "unknown" },
  { ts: T29("12:33:16"), ...fakeAt(3305.54, -18531.09), acc: 8.62833277321661, kind: "transit", activity: "unknown" },
  { ts: T29("12:33:16"), ...fakeAt(3305.54, -18531.09), acc: 8.62833277321661, kind: "transit", activity: "unknown" },
  { ts: T29("12:33:16"), ...fakeAt(3305.54, -18531.09), acc: 8.62833277321661, kind: "transit", activity: "unknown" },
  { ts: T29("12:46:08"), ...fakeAt(3250.22, -18550.84), acc: 14.2459545905753, kind: "transit", activity: "walking" },
  { ts: T29("12:53:06"), ...fakeAt(3375.98, -18456.09), acc: 30.8567655458119, kind: "transit", activity: "unknown" },
];

// The blend exactly as location-segment's anchor-walk produced it (radius
// widened to the backing visit row's own 11:40:55-12:53:06 span, name not
// yet resolved).
const CLOSING_BLEND = {
  id: "s-20260929-2", start: "11:40", end: "12:53",
  start_ts_ms: T29("11:40:55"), end_ts_ms: T29("12:53:06"),
  duration_min: 72, ...fakeAt(3144.07, -18575.16),
  cluster_radius_km: 0.1074, sample_count: 11,
  place: { name: null, source: "reverse_geocode", confidence: 0.4 },
};

test("the closing and the lunch after it are two rests, not one", () => {
  const rests = findRests(CLOSING_LUNCH_PINGS, CLOSING_BLEND.start_ts_ms, CLOSING_BLEND.end_ts_ms);
  assert.equal(rests.length, 2);
  assert.equal(rests[0].minutes, 52);
  assert.equal(rests[1].minutes, 20);
  const apartM = haversineMeters(rests[0].lat, rests[0].lon, rests[1].lat, rests[1].lon);
  // 130 mirrors resolve-day.js's SPLIT_SEPARATION_M (not imported here to avoid
  // a cross-file constant coupling in a stop-rests-focused test).
  assert.ok(apartM > 130 && apartM < 150,
    `${apartM} m apart -- clears the new bar, still under the retired 150 m one`);
});

test("107.4 m sat under the retired 120 m radius bar", () => {
  const radiusM = CLOSING_BLEND.cluster_radius_km * 1000;
  assert.ok(radiusM < 120 && radiusM > SPLIT_RADIUS_M - 20,
    "under the old bar, comfortably above a single-building drift");
});

test("splitStopOnRests now finds both rests in the real trace", () => {
  const pieces = splitStopOnRests(CLOSING_BLEND, CLOSING_LUNCH_PINGS);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].minutes, 52);
  assert.equal(pieces[1].minutes, 20);
});

test("splitWideStopsOnRests keeps the two apart once they resolve to different venues", () => {
  const ctx = { date: "2026-09-29", knownStopsEntries: [],
    nameRest: nameBy(p => (p.lon < fakePt(3245.53, -18560)[1] ? "Example Law Office" : "Example Restaurant")) };
  const { stops, splits } = splitWideStopsOnRests([{ ...CLOSING_BLEND }], CLOSING_LUNCH_PINGS, ctx);
  assert.equal(stops.length, 2);
  assert.deepEqual(splits[0].into.map(p => p.name), ["Example Law Office", "Example Restaurant"]);
});

// ---------------------------------------------------------------------------
// Two points is a weak sample.
// ---------------------------------------------------------------------------
//
// Two points might be just a random pause. The count can't simply be raised —
// a still phone stops emitting, so a 40-minute dinner routinely lands two fixes
// — so the bar scales with what else vouches for the window.

const at = (hms, lat, lon, extra = {}) => ({ ts: T(hms), lat, lon, acc: 12, ...extra });

test("two precise fixes alone are a pause, not a rest", () => {
  const pause = [
    at("12:00:00", ...fakePt(-5.98, -82.84)),
    at("12:05:00", ...fakePt(-5.98, -82.84)),
    at("12:20:00", ...fakePt(752.16, 584.33)),
  ];
  assert.deepEqual(findRests(pause, T("12:00:00"), T("12:30:00")), [],
    "nothing but the GPS positions agrees of a stop");
});

test("a third precise fix makes it a sample", () => {
  const sampled = [
    at("12:00:00", ...fakePt(-5.98, -82.84)),
    at("12:05:00", ...fakePt(-5.98, -82.84)),
    at("12:11:00", ...fakePt(-5.98, -82.84)),
    at("12:20:00", ...fakePt(752.16, 584.33)),
  ];
  const rests = findRests(sampled, T("12:00:00"), T("12:30:00"));
  assert.equal(rests.length, 1);
  assert.equal(rests[0].precise_count, 3);
  assert.deepEqual(rests[0].corroborated_by, []);
});

test("two fixes stand when a different instrument agrees of a stop", () => {
  const withVisit = [
    at("12:00:00", ...fakePt(-5.98, -82.84), { kind: "visit", activity: "stationary high" }),
    at("12:05:00", ...fakePt(-5.98, -82.84)),
    at("12:20:00", ...fakePt(752.16, 584.33)),
  ];
  const rests = findRests(withVisit, T("12:00:00"), T("12:30:00"));
  assert.equal(rests.length, 1, "iOS's own visit detector is not a third GPS sample");
  assert.deepEqual(rests[0].corroborated_by, ["clvisit", "stationary"]);
});

test("the accelerometer alone is enough corroboration", () => {
  const withMotion = [
    at("12:00:00", ...fakePt(-5.98, -82.84), { activity: "stationary" }),
    at("12:05:00", ...fakePt(-5.98, -82.84)),
    at("12:20:00", ...fakePt(752.16, 584.33)),
  ];
  assert.deepEqual(findRests(withMotion, T("12:00:00"), T("12:30:00"))[0].corroborated_by,
    ["stationary"]);
});

// Target survives on exactly this: two precise fixes, plus a CLVisit row and a
// stationary tag. It is the case the rule had to keep.
test("Target's rest is a two-fix rest that corroboration saves", () => {
  const [rest] = findRests(PINGS, BLEND.start_ts_ms, BLEND.end_ts_ms);
  assert.equal(rest.precise_count, 2);
  assert.deepEqual(rest.corroborated_by, ["clvisit", "stationary"]);
});

// Carried, not gated: a still phone witnessing 5 of 11 minutes is normal.
test("a rest reports how much of itself its fixes actually saw", () => {
  const [rest] = findRests(PINGS, BLEND.start_ts_ms, BLEND.end_ts_ms);
  assert.equal(rest.minutes, 11);
  assert.equal(rest.witnessed_min, 5, "the other 6 minutes are inferred from silence");
});

// ---------------------------------------------------------------------------
// Passing through is not a stop, however the phone labelled it.
// ---------------------------------------------------------------------------

const { dropUnrestedStops } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const turnaround = {
  id: "s-2", start: "17:14", end: "17:26",
  start_ts_ms: T("17:14:00"), end_ts_ms: T("17:26:30"), duration_min: 13,
  ...fakeAt(203.36, 348.6), photos: [],
  place: { name: "340 Example Ave", source: "address", confidence: 0.4 },
};

test("an unnamed window the fixes cannot support is not a stop", () => {
  const { stops, dropped } = dropUnrestedStops([turnaround], PINGS);
  assert.equal(stops.length, 0);
  assert.match(dropped[0].reason, /passing through/);
  assert.equal(dropped[0].precise_fixes, 1, "one precise fix is not two");
});

test("a resolver guess does not protect a window from that test", () => {
  // "340 Example Ave" is the nearest address to a window whose existence is the
  // question; keeping the stop because the guesser filled it in is circular.
  assert.equal(turnaround.place.name, "340 Example Ave");
  assert.equal(dropUnrestedStops([turnaround], PINGS).stops.length, 0);
});

test("a stop the user named is never dropped, rest or no rest", () => {
  const his = { ...turnaround, place: { name: "the beach", source: "user_confirmed", confidence: 1 } };
  assert.equal(dropUnrestedStops([his], PINGS).stops.length, 1);
});

test("a window with photos is never dropped", () => {
  const shot = { ...turnaround, photos: [{ uuid: "x", taken_at: "2026-08-31T21:16:00Z" }] };
  assert.equal(dropUnrestedStops([shot], PINGS).stops.length, 1);
});

// Silence is evidence of stillness, not of absence: a phone that went quiet
// indoors must never cost the user a real stop.
test("a window we cannot see at all is left alone", () => {
  const unseen = { ...turnaround, start_ts_ms: T("19:00:00"), end_ts_ms: T("19:40:00") };
  assert.equal(dropUnrestedStops([unseen], PINGS).stops.length, 1);
});

// ---------------------------------------------------------------------------
// A substantial no-rest window is a question, not a hole in the day.
// ---------------------------------------------------------------------------
//
// The user visited someone at a hospital for 38 minutes, right before an
// evening show. Six fixes
// drifted ~250m across the hospital campus with a 26-minute silent gap in the
// middle, every one tagged `transit` by iOS's own CLVisit — so no group ever
// reached a 75m rest, same evidential conclusion as the 17:14 turnaround
// above. But 38 minutes is not a sliver: deleting it left the daily summary
// describing "walked 2.0 miles ... about 1h19m" straight through a real
// hospital visit with no trace anywhere, not even a correction question.

const T14 = (hms) => Date.parse(`2026-09-14T${hms}-04:00`);

const HOSPITAL_PINGS = [
  { ts: T14("18:28:47"), ...fakeAt(1888.47, -566.76), acc: 22, kind: "transit", activity: "unknown" },
  { ts: T14("18:30:02"), ...fakeAt(1800.05, -731), acc: 45, kind: "transit", activity: "unknown" },
  { ts: T14("18:33:07"), ...fakeAt(1886.87, -560.64), acc: 30, kind: "transit", activity: "unknown" },
  { ts: T14("18:37:32"), ...fakeAt(2039.32, -684.29), acc: 20, kind: "transit", activity: "unknown" },
  { ts: T14("18:40:03"), ...fakeAt(2074.7, -687.52), acc: 50, kind: "transit", activity: "unknown" },
  { ts: T14("19:06:21"), ...fakeAt(1965.32, -588.55), acc: 25, kind: "transit", activity: "unknown" },
];

const hospitalStop = {
  id: "s-20260914-4", start: "18:28", end: "19:06",
  start_ts_ms: T14("18:28:47"), end_ts_ms: T14("19:06:21"), duration_min: 38,
  ...fakeAt(1942.5, -636.48), photos: [],
  place: { name: "Proof Coffee Roasters", source: "osm_overpass", confidence: 0.83 },
};

test("precondition: the hospital window really has no rest", () => {
  assert.equal(findRests(HOSPITAL_PINGS, hospitalStop.start_ts_ms, hospitalStop.end_ts_ms).length, 0);
});

test("a substantial no-rest window survives unnamed instead of vanishing", () => {
  const { stops, dropped } = dropUnrestedStops([hospitalStop], HOSPITAL_PINGS);
  assert.equal(stops.length, 1, "38 minutes is too much to just delete");
  assert.equal(stops[0].place.name, null);
  assert.equal(stops[0].unnamed, true);
  assert.equal(stops[0].unrested, true);
  assert.equal(dropped[0].kept_as_unknown, true);
});

// The 13-minute turnaround above still drops silently — this isn't a blanket
// reprieve, only substantial windows earn the question.
test("a short no-rest window still drops with no trace", () => {
  const { stops, dropped } = dropUnrestedStops([turnaround], PINGS);
  assert.equal(stops.length, 0);
  assert.equal(dropped[0].kept_as_unknown, undefined);
});

// ---------------------------------------------------------------------------
// A path when the map-matcher is down.
// ---------------------------------------------------------------------------
//
// 2026-09-01: the public Valhalla instance day-path snaps fixes to streets with
// timed out (`curl 28` after 30 s) and the OSRM fallback returned nothing —
// `matched_km: 0`, `match_pct: 0`, zero legs — while the day's raw fixes sat in
// the database as usual. Everything that asks "how far, and which direction"
// reads those legs, so a third-party outage silently deleted the walk block and
// every distance from the day.

const { ensurePathGeometry, straightLineLegs, pathHasLegs, GEOMETRY_STRAIGHT, GEOMETRY_MATCHED } =
  require(path.join(ROOT, "lib/resolve-day.js"))._internal;
const { geometryEstimated } = require(path.join(ROOT, "lib/daily-summary-render.js"))._internal;

const DEAD_MATCHER = {
  segments: [{ kind: "observed", start_ms: T("00:00:00"), end_ms: T("21:12:00"),
               matched_m: 0, streets: [], legs: [] }],
  stats: { matched_km: 0, match_pct: 0 },
};

test("straight lines stand in when the matcher returns nothing", () => {
  const out = ensurePathGeometry(structuredClone(DEAD_MATCHER), PINGS);
  assert.equal(out.stats.geometry_source, GEOMETRY_STRAIGHT);
  assert.ok(pathHasLegs(out));
  assert.equal(out.segments.length, 1, "the empty matched segment is replaced, not joined");
});

test("the stand-in is a floor on the real distance, never an inflation", () => {
  const straight = straightLineLegs(PINGS).reduce((t, l) => t + l.m, 0);
  const MATCHED_M = 2590;   // what Valhalla returned for the same day when it was up
  assert.ok(straight > 0);
  assert.ok(straight < MATCHED_M,
    `straight lines cut corners: ${straight} m vs ${MATCHED_M} m matched`);
});

// Direction is what the guards actually test — displacement from base, the
// turnaround — and straight lines preserve it exactly.
test("direction survives the outage intact", () => {
  const legs = straightLineLegs(PINGS);
  const first = legs[0], last = legs[legs.length - 1];
  assert.equal(first.lat0, PINGS[0].lat);
  assert.equal(last.lat1, PINGS[PINGS.length - 1].lat);
});

test("a working matcher is left completely alone", () => {
  const good = { segments: [{ legs: [{ t0: 1, t1: 2, lat0: 1, lon0: 1, lat1: 1, lon1: 1, m: 5 }],
                              matched_m: 5 }], stats: {} };
  const out = ensurePathGeometry(good, PINGS);
  assert.equal(out.stats.geometry_source, GEOMETRY_MATCHED);
  assert.equal(out.segments[0].matched_m, 5, "matched geometry is not overwritten");
});

test("too few fixes to draw anything leaves the path as it was", () => {
  const out = ensurePathGeometry(structuredClone(DEAD_MATCHER), PINGS.slice(0, 1));
  assert.equal(pathHasLegs(out), false);
  assert.equal(out.stats.geometry_source, undefined);
});

test("an estimated day says 'at least', a matched day states the figure", () => {
  assert.equal(geometryEstimated({ path: { stats: { geometry_source: GEOMETRY_STRAIGHT } } }), true);
  assert.equal(geometryEstimated({ path: { stats: { geometry_source: GEOMETRY_MATCHED } } }), false);
  assert.equal(geometryEstimated({}), false);
});
