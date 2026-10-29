// resolve-day-walk-lodging.test.mjs — two things the location resolver could
// not previously say (two questions about one day's summary):
//
//   "8 Impasse des Examples is less than 100m from our airbnb. why isn't it
//    categorized as our airbnb?"
//   "why is Restaurant Lavande a stop and not a continuation of the walk along the
//    coastline?"
//
// Both had the same root shape: the pipeline already held the answer and no code
// path connected it. `travel_segments` knew the user was lodging in Example Town all
// week, but only presence/timezone tools read it. `location-segment` had already
// classified both coastline clusters as `browse`, but browse only ever changed
// how hard a name was hedged — nothing merged adjacent clusters into one walk.
//
// Run: node --test tests/resolve-day-walk-lodging.test.mjs

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
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { mergeWalkChains, applyAccommodation, accommodationName } = _internal;
const { applyProvenance } = require(path.join(ROOT, "lib/daily-summary-confirm.js"));
const { _internal: render } = require(path.join(ROOT, "lib/daily-summary-render.js"));

const ms = (hhmm) => Date.parse(`2026-07-26T${hhmm}:00+02:00`);

// A coastline stretch with the shape location-segment emitted for a real day.
function coastlineStops() {
  return [
    { id: "s-1", start: "12:09", end: "12:45", duration_min: 36, start_ts_ms: ms("12:09"), end_ts_ms: ms("12:45"),
      ...LL(0.0, 0.0), pattern: "dwell", sample_count: 3, cluster_radius_km: 0.0257,
      place: { name: "Captain café", source: "osm_overpass", confidence: 0.5 }, photos: [], companions: [] },
    { id: "s-2", start: "12:49", end: "13:02", duration_min: 13, start_ts_ms: ms("12:49"), end_ts_ms: ms("13:02"),
      ...LL(-418.67, 0.35), pattern: "browse", sample_count: 12, cluster_radius_km: 0.1319,
      place: { name: "Cafe Equinox", source: "osm_overpass", confidence: 0.5 },
      alternatives: [{ name: "Pizza chain", distance_km: 0.05 }], photos: [{ uuid: "a" }], companions: ["Paige"] },
    { id: "s-3", start: "13:13", end: "13:27", duration_min: 14, start_ts_ms: ms("13:13"), end_ts_ms: ms("13:27"),
      ...LL(-71.58, -226.28), pattern: "browse", sample_count: 3, cluster_radius_km: 0.1652,
      place: { name: "Restaurant Lavande", source: "google_places", confidence: 0.5 },
      alternatives: [{ name: "Example Park", distance_km: 0.04 }], photos: [{ uuid: "b" }], companions: [] },
    { id: "s-4", start: "13:47", end: "14:02", duration_min: 15, start_ts_ms: ms("13:47"), end_ts_ms: ms("14:02"),
      ...LL(-392.47, 51.83), pattern: "dwell", sample_count: 6, cluster_radius_km: 0.038,
      place: { name: "Beach Bar Example", source: "user_confirmed", confidence: 1 }, photos: [], companions: [] },
  ];
}

test("two browse clusters joined at walking pace become one walk", () => {
  const merged = mergeWalkChains(coastlineStops());
  assert.equal(merged.length, 3, merged.map(s => s.start + "-" + s.end).join(" | "));
  const walk = merged.find(s => s.merged_walk);
  assert.ok(walk, "the coastline stretch should have merged");
  assert.equal(walk.start, "12:49");
  assert.equal(walk.end, "13:27");            // 415 m at ~2.3 km/h in between
  assert.equal(walk.duration_min, 38);
  assert.equal(walk.sample_count, 15);        // 12 + 3
  assert.deepEqual(walk.merged_walk.dropped_guesses, ["Cafe Equinox", "Restaurant Lavande"]);
  assert.equal(walk.place.name, null, "a walk has no venue");
  assert.deepEqual(walk.alternatives, []);
  assert.equal(walk.photos.length, 2, "photos from every member must survive the merge");
  assert.deepEqual(walk.companions, ["Paige"]);
  // Ids stay contiguous so downstream prose slots / photo maps line up.
  assert.deepEqual(merged.map(s => s.id), ["s-1", "s-2", "s-3"]);
});

test("the surrounding dwell stops are untouched", () => {
  const merged = mergeWalkChains(coastlineStops());
  assert.equal(merged[0].place.name, "Captain café");   // 36 min, 26 m radius
  assert.equal(merged[2].place.name, "Beach Bar Example");         // user-confirmed
});

test("a settled identity is never absorbed into a walk", () => {
  const stops = coastlineStops();
  // Same geometry, but the user said what the middle cluster was.
  stops[2].place = { name: "Example Beach", source: "user_confirmed", confidence: 1 };
  const merged = mergeWalkChains(stops);
  assert.equal(merged.length, 4, "nothing should merge into a confirmed place");
});

test("a drive between clusters is not a walk", () => {
  const stops = coastlineStops();
  Object.assign(stops[2], LL(7000, 0));   // ~7 km away, same 11-minute gap -> ~38 km/h
  const merged = mergeWalkChains(stops);
  assert.equal(merged.length, 4, "a vehicle leg must not merge two clusters");
});

test("a merged walk is titled as movement, hedged — we inferred it, the user didn't say it", () => {
  const merged = mergeWalkChains(coastlineStops());
  const walk = merged.find(s => s.merged_walk);
  applyProvenance([walk], {});
  // No area label to borrow, so there is no place to name — the header says
  // only what we know: the user was moving.
  assert.equal(walk.provenance.title_kind, "movement");
  assert.equal(walk.provenance.title, null);
  assert.equal(walk.provenance.certainty, "none", "nothing to be certain OF");
  const html = render.stopHeaderHtml(walk).replace(/<[^>]+>/g, "");
  assert.match(html, /moving, not a stop/);
  assert.doesNotMatch(html, /Cafe Equinox|Restaurant Lavande/);
});

test("but the user's own words win when they answered about any part of it", () => {
  const merged = mergeWalkChains(coastlineStops());
  const walk = merged.find(s => s.merged_walk);
  assert.equal(walk.user_non_stop, false);       // nothing answered yet
  walk.user_non_stop = true;                     // as if the 12:49 ask was answered
  applyProvenance([walk], { confirmed: { [walk.id]: "We were walking along the coastline" } });
  assert.equal(walk.provenance.certainty, "answered");
  assert.equal(walk.provenance.title, "Coastline");
  assert.equal(walk.provenance.movement_note, "We were walking along the coastline");
});

// --- accommodation -----------------------------------------------------------

const LODGING = {
  metro: "example-town",
  place_label: "Example Town, France — Maison 10min Bay City - 4 pers cosy (host Nina)",
  source: "lodging", ref: "lodging:EXAMPLE0001",
};

test("the trip's lodging record names the stop, not a reverse-geocoded address", () => {
  const base = { ...LL(4173.73, 4950.6) };
  const stops = [
    { id: "a", start: "06:15", end: "11:36", ...base, place: { name: "8 Impasse des Examples", source: "confirmed_stop", confidence: 0.95 } },
    { id: "b", start: "12:09", end: "12:45", ...LL(0.0, 0.0), place: { name: "Captain café", source: "osm_overpass", confidence: 0.5 } },
    { id: "c", start: "15:04", end: "16:35", ...base, place: { name: "8 Impasse des Examples", source: "confirmed_stop", confidence: 0.95 } },
    { id: "d", start: "22:31", end: "02:32", ...base, place: { name: "8 Impasse des Examples", source: "confirmed_stop", confidence: 0.95 } },
  ];
  applyAccommodation(stops, LODGING);
  for (const id of ["a", "c", "d"]) {
    const s = stops.find(x => x.id === id);
    assert.equal(s.place.name, "our Airbnb in Example Town (host Nina)");
    assert.equal(s.place.source, "accommodation");
    assert.equal(s.accommodation.was, "8 Impasse des Examples", "keep what it used to say");
  }
  // A stop 5 km away is not the accommodation.
  assert.equal(stops.find(x => x.id === "b").place.name, "Captain café");

  // And it renders as a settled place, not a hedge.
  applyProvenance(stops, {});
  assert.equal(stops[0].provenance.certainty, "known");
  assert.match(render.stopHeaderHtml(stops[0]), /<b>our Airbnb in Example Town \(host Nina\)<\/b>/);
});

test("a day that starts and ends somewhere else renames nothing", () => {
  const stops = [
    { id: "a", start: "08:00", end: "09:00", ...LL(4176.5, 4950.82), place: { name: "8 Impasse des Examples", source: "confirmed_stop", confidence: 0.95 } },
    { id: "b", start: "20:00", end: "23:00", ...LL(257389.93, 307770.5), place: { name: "Inn", source: "osm_overpass", confidence: 0.5 } },
  ];
  applyAccommodation(stops, LODGING);
  assert.equal(stops[0].place.source, "confirmed_stop", "no base -> no renaming");
});

test("a listing headline becomes 'our Airbnb in <city>'; a real hotel name is kept", () => {
  assert.equal(accommodationName(LODGING), "our Airbnb in Example Town (host Nina)");
  assert.equal(accommodationName({ metro: "rivertown", place_label: "Rivertown, France — Apartment agreable et spacieux avec parking (host Lena)" }),
    "our Airbnb in Rivertown (host Lena)");
  // Not listing-shaped -> use it verbatim.
  assert.equal(accommodationName({ metro: "bigcity", place_label: "Hotel Sixty Example" }), "Hotel Sixty Example");
});

// --- short stops -------------------------------------------------------------

test("stops under 10 minutes are dropped, but never a stop we actually know", () => {
  const { dropShortStops } = _internal;
  const at = (hhmm) => Date.parse(`2026-07-26T${hhmm}:00+02:00`);
  const mk = (id, a, b, name, source, photos = []) => ({
    id, start: a, end: b, duration_min: Math.round((at(b) - at(a)) / 60000),
    start_ts_ms: at(a), end_ts_ms: at(b), ...LL(0, 0),
    place: { name, source, confidence: 0.5 }, photos,
  });
  const stops = [
    mk("s-1", "15:04", "16:35", "our Airbnb", "accommodation"),
    mk("s-2", "17:22", "17:27", "Pont Example", "neighborhood", [{ uuid: "p1" }, { uuid: "p2" }]),
    mk("s-3", "17:55", "18:09", "Example-sur-Mer", "neighborhood"),
    mk("s-4", "19:14", "19:20", "CAPSULE", "google_places", [{ uuid: "p3" }]),
    // 6 minutes, but the user said what it was — keep it.
    mk("s-5", "20:00", "20:06", "Chez Example", "user_confirmed"),
    mk("s-6", "22:31", "23:59", "our Airbnb", "accommodation"),
  ];
  const kept = dropShortStops(stops);
  assert.deepEqual(kept.map(s => s.place.name), ["our Airbnb", "Example-sur-Mer", "Chez Example", "our Airbnb"]);
  // Photos move to the nearest surviving stop rather than vanishing.
  const all = kept.flatMap(s => (s.photos || []).map(p => p.uuid));
  assert.deepEqual(all.sort(), ["p1", "p2", "p3"]);
  const absorbed = kept.flatMap(s => s.absorbed_short_stops || []).map(a => a.was);
  assert.deepEqual(absorbed.sort(), ["CAPSULE", "Pont Example"]);
  assert.deepEqual(kept.map(s => s.id), ["s-1", "s-2", "s-3", "s-4"]);
});

test("a walk is judged on its merged length, not its parts", () => {
  const { dropShortStops, mergeWalkChains } = _internal;
  // Two 13-minute browse clusters -> one 38-minute walk, which must survive.
  const merged = mergeWalkChains(coastlineStops());
  const kept = dropShortStops(merged);
  assert.ok(kept.some(s => s.merged_walk), "the merged walk must not be dropped");
});
