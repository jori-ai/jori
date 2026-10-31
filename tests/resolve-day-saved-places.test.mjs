// resolve-day-saved-places.test.mjs — a pizzeria dinner that shipped as
// "7:34pm · unlabeled" (2026-09-03). The root cause: the resolver should have
// known the place, or asked.
//
// It should have known. The user has 2328 places saved in Google Maps and the day's
// resolver never looked at one of them: `location-segment`'s ladder runs
// named_location → confirmed_stop → known_recurring → wifi_ssid → OSM/Google,
// so the best it could reach for a 34-minute sit on Main Street was the nearest
// POI ("SHOP ZERO | NORTH VILLAGE"), which unnameGuesses then correctly
// stripped as a guess. day-segments had the right answer on the visit row the
// whole time, as `place_type='segment-derived'` — a type this file ignores.
//
// The reason the rung has to match at the REST and not the stop's centroid is
// the entire test below: the two are 63 m apart and they name different
// restaurants. The centroid averages in the walk down Main Street.
//
// Run: node --test tests/resolve-day-saved-places.test.mjs

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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { _internal } = require(path.join(HERE, "..", "lib", "resolve-day.js"));
const { nameFromSavedPlaces, savedPlacesNear, SAVED_PLACE_MATCH_M } = _internal;

// The two saved places that matter (synthetic places, the real geometry).
const SAVED = [
  { name: "Pizzeria Alpha North Village", ...LL(0.0, 0.0),
    address: "325 Main St, Example City, ZZ 00000, USA" },
  { name: "Pizzeria Beta", ...LL(-61.68, 23.57),
    address: "104 Elm St, Example City, ZZ 00000, USA" },
];

const MIN = 60_000;
const T0 = Date.parse("2026-09-02T23:34:51Z");   // 19:34 local (UTC-4)

// The real trace: walk down Main Street, then fourteen fixes inside ten metres
// from 19:49 to 20:08, two of them tagged `stationary` by CoreMotion.
function dinnerPings() {
  const walk = [
    [0.0, ...PT(-66.31, 177.58)], [3.6, ...PT(-56.2, 15.23)],
  ].map(([m, lat, lon]) => ({ ts: T0 + m * MIN, lat, lon, acc: 19, kind: "transit", activity: "walking" }));
  const sat = [];
  for (let i = 0; i < 14; i++) {
    // 19:49 → 20:08, clustered on the table.
    const m = 14.7 + i * 1.4;
    sat.push({
      ts: T0 + m * MIN,
      ...LL(-5.22 + (i % 2 - 0.5) * 2.53, -4.23 + (i % 3 - 1) * 2.23),
      acc: 15, kind: "transit",
      activity: i === 3 || i === 6 ? "stationary" : "unknown",
    });
  }
  return [...walk, ...sat];
}

function dinnerStop() {
  return {
    id: "s-20260902-2", start: "19:34", end: "20:13",
    start_ts_ms: T0, end_ts_ms: T0 + 38 * MIN,
    duration_min: 38,
    // The visit centroid — pulled up Main Street by the walk in.
    ...LL(-59.57, 13.01),
    place: { name: null, address: "326-328 Main St, Example City, ZZ 00000, USA",
             source: "unknown", confidence: 0, distance_m: null },
    photos: [],
  };
}

test("the centroid and the rest name different restaurants", () => {
  const s = dinnerStop();
  const fromCentroid = savedPlacesNear(s.lat, s.lon, SAVED_PLACE_MATCH_M, SAVED);
  const fromRest = savedPlacesNear(...PT(-5.22, -4.23), SAVED_PLACE_MATCH_M, SAVED);

  // This is the whole reason the rung matches at the rest. Matching on the
  // centroid would have shipped a confident wrong answer, which is worse than
  // "unlabeled".
  assert.equal(fromCentroid.length, 1);
  assert.equal(fromCentroid[0].name, "Pizzeria Beta");
  assert.equal(fromRest.length, 1);
  assert.equal(fromRest[0].name, "Pizzeria Alpha North Village");
});

test("a 34-minute sit inside 30m of a saved place takes its name", () => {
  const stops = [dinnerStop()];
  const { named } = nameFromSavedPlaces(stops, dinnerPings(), { savedPlaces: SAVED });

  assert.equal(named.length, 1);
  assert.equal(stops[0].place.name, "Pizzeria Alpha North Village");
  assert.equal(stops[0].place.source, "saved_place");
  assert.ok(stops[0].place.distance_m <= SAVED_PLACE_MATCH_M);
  // The name is only as good as the rest under it — carry the evidence.
  assert.ok(stops[0].rest_verified.minutes >= 15);
  assert.ok(stops[0].rest_verified.corroborated_by.includes("stationary"));
});

test("a resolver guess is replaced, a real label is not", () => {
  const guessed = dinnerStop();
  guessed.place = { name: "SHOP ZERO | NORTH VILLAGE", address: null,
                    source: "google_places", confidence: 0.4, distance_m: 40 };
  nameFromSavedPlaces([guessed], dinnerPings(), { savedPlaces: SAVED });
  assert.equal(guessed.place.name, "Pizzeria Alpha North Village");

  // A calendar match is evidence of its own kind and outranks proximity.
  const cal = dinnerStop();
  cal.place = { name: "Dinner with Paige", address: null,
                source: "calendar_corroborated", confidence: 0.98, distance_m: null };
  nameFromSavedPlaces([cal], dinnerPings(), { savedPlaces: SAVED });
  assert.equal(cal.place.name, "Dinner with Paige");
});

test("walking past a saved place never earns its name", () => {
  // Mason, 2026-09-01: "we're still making up stops while passing through. it
  // shouldn't be an unlabeled stop even if it's a favorited place."
  //
  // Six fixes straight down the block at an amble. Note what does NOT save this:
  // findRests is greedy against a RUNNING centroid inside 75 m, so this chains
  // into a single "rest" whose mean lands within 30 m of the door — the first
  // draft of this rung named it. What rejects it is restSatAt: of the six fixes
  // strung along 220 m, only one is actually AT the place. The window keeps no
  // name and falls to dropUnrestedStops on its own evidence.
  const passing = [];
  for (let i = 0; i < 6; i++) {
    passing.push({ ts: T0 + i * 2 * MIN, ...LL(-10.7 - i * 8.44, 35.25 - i * 44.53),
                   acc: 18, kind: "transit", activity: "walking" });
  }
  const s = dinnerStop();
  s.end_ts_ms = T0 + 12 * MIN;
  const { named } = nameFromSavedPlaces([s], passing, { savedPlaces: SAVED });
  assert.equal(named.length, 0);
  assert.equal(s.place.name, null);
});

test("two saved places at the rest is a question, not a pick", () => {
  const twins = [
    { name: "Pizzeria Alpha North Village", ...LL(0.0, 0.0), address: null },
    { name: "The place next door", ...LL(-2.27, 1.89), address: null },
  ];
  const s = dinnerStop();
  const { named, ambiguous } = nameFromSavedPlaces([s], dinnerPings(), { savedPlaces: twins });

  assert.equal(named.length, 0);
  assert.equal(s.place.name, null);
  assert.equal(ambiguous.length, 1);
  // ...and the stop carries the shortlist, so the follow-up is a tap.
  assert.equal(s.saved_place_candidates.length, 2);
});

test("no rest-worthy saved place still yields candidates to ask with", () => {
  // Nothing within 30m of the rest, but his own labels are 60-70m up the block:
  // the summary's "I didn't capture a label. Tell me?" gets a shortlist instead
  // of nothing at all.
  const s = dinnerStop();
  const far = [{ name: "Pizzeria Beta", ...LL(-61.68, 23.57), address: null }];
  const { named } = nameFromSavedPlaces([s], dinnerPings(), { savedPlaces: far });
  assert.equal(named.length, 0);
  assert.equal(s.place.name, null);
  assert.equal(s.saved_place_candidates[0].name, "Pizzeria Beta");
});
