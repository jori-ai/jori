// resolve-day-photo-text.test.mjs — the Tremor Coffee Room stop that shipped
// as "8:30am · unlabeled" (Mason, 2026-09-06):
//
//   "why is the 8:30am stop yesterday unlabled?" ... "not to mention the photo
//    carries the cafe name..."
//
// It did. IMG_7001, taken 2026-09-05T08:40:30 ET from inside the stop, shows an
// awning reading TREMOR COFFEE ROOM and an A-frame reading @TREMORCOFFEE,
// and Apple Photos had OCR'd both on-device. `osxphotos query --json` returns
// them at search_info.detected_text. bin/photos read `labels_normalized`
// off that payload and nothing else, so "chalkboard, sign, door" was stored and
// the name on the sign was not.
//
// Two rungs are under test, and they fail differently:
//
//  * GEOMETRY. The tracker went silent for 40 of the 42 minutes — one usable fix
//    at 08:31 (still tagged `walking`) and a pair at 09:12. The rest that came
//    out of that is the mean of where he left from and where he came back to,
//    65 m from where he actually stood. The camera fix sat in the middle of the
//    silence and was used for nothing. photoPings folds it in.
//
//  * NAMING. Nearest saved place to the rest: 129 m (Gyros example). Nearest POI
//    guess: 116 m. Neither can reach it and neither should — the answer was not
//    nearby, it was in the frame. nameStopsFromPhotoText asks a model to read it,
//    and groundedInPhoto stops that model from ordering off the nearby list
//    instead, which is the exact failure mode ("Thought Coffee", 130 m) the
//    narrator fell into by hand.
//
// Run: node --test tests/resolve-day-photo-text.test.mjs

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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { _internal } = require(path.join(HERE, "..", "lib", "resolve-day.js"));
const { photoPings, RESOLVER_SETTLED } = _internal;
const { nameStopsFromPhotoText, groundedInPhoto, bestPhotoForStop } =
  require(path.join(HERE, "..", "lib", "photo-place-name.js"));
const { findRests } = require(path.join(HERE, "..", "lib", "stop-rests.js"));

const MIN = 60_000;
// 2026-09-05 08:30 ET.
const T0 = Date.parse("2026-09-05T12:30:00Z");

// Exactly what Photos returned for IMG_7001 — the venue name, a menu board, a
// joke on the sandwich sign, a NO SCHOOL ZONE street sign, and two words the
// OCR mangled. Alphabetically sorted, which is how osxphotos hands it over.
const TREMOR_BAG = ["are", "band", "be", "because", "better", "buy", "call",
  "camera", "coffee", "done", "drinks", "for", "hating", "hould", "ithusiasm",
  "job", "love", "on", "room", "sane", "school", "smile", "someone",
  "speakerphone", "stay", "tremor", "tremorcoffee", "the", "use", "with",
  "you", "your", "zone"];

// The real coordinates from that morning.
const PHOTO = { ...LL(0.0, 0.0) };   // IMG_7001
const FIX_0831 = { ...LL(45.82, -26.32), acc: 21 };
const FIX_0912 = { ...LL(11.28, -7.41), acc: 16 };

function stopFixture(photos) {
  return {
    id: "s-20260905-2", start: "08:30", end: "09:12",
    start_ts_ms: T0, end_ts_ms: T0 + 42 * MIN,
    ...LL(56.1, -48.33),
    place: { name: null, source: "unknown", confidence: 0,
             address: "256 Oak St, Example City, ZZ 00000, USA" },
    unnamed: true,
    // What the resolver actually offered that morning: both too far to name.
    alternatives: [
      { name: "Thought Coffee", source: "google_places", distance_km: 0.1297 },
      { name: "Artisan Bakery Example", source: "google_places", distance_km: 0.1741 },
    ],
    photos,
    photo_text_eligible: photos.map(p => p.uuid),
  };
}

const PHOTO_ROW = {
  uuid: "CFB23CB8", ts: "2026-09-05T12:40:30.701Z",
  lat: PHOTO.lat, lon: PHOTO.lon, self_captured: true,
};

const textFor = uuid =>
  uuid === "CFB23CB8" ? { tokens: TREMOR_BAG, labels: ["chalkboard", "sign", "door"] } : null;

// ---------------------------------------------------------------------------
// Geometry: the camera fix is a fix
// ---------------------------------------------------------------------------

test("a self-captured photo becomes a ping; a received one does not", () => {
  const pings = photoPings([
    { uuid: "mine", taken_at: "2026-09-05T12:40:30.701Z", latitude: PHOTO.lat,
      longitude: PHOTO.lon, self_captured: true },
    { uuid: "theirs", taken_at: "2026-09-05T12:41:00Z", latitude: 40.9, longitude: -73.9,
      self_captured: false },
    { uuid: "nogps", taken_at: "2026-09-05T12:42:00Z", latitude: null, longitude: null,
      self_captured: true },
  ]);
  assert.equal(pings.length, 1);
  assert.equal(pings[0].uuid, "mine");
  assert.equal(pings[0].kind, "photo");
  // `photos` has no accuracy column and we must not invent one. null already
  // reads as "unknown, not bad" in usablePings.
  assert.equal(pings[0].acc, null);
});

test("the photo lands inside the 40-minute silence and corroborates the rest", () => {
  const pings = [
    { ts: T0 + 1 * MIN, ...FIX_0831, kind: "transit", activity: "walking" },
    ...photoPings([{ uuid: "CFB23CB8", taken_at: "2026-09-05T12:40:30.701Z",
                     latitude: PHOTO.lat, longitude: PHOTO.lon, self_captured: true }]),
    { ts: T0 + 42 * MIN, ...FIX_0912, kind: "transit", activity: null },
  ];
  const rests = findRests(pings, T0, T0 + 42 * MIN);
  assert.equal(rests.length, 1, "the window is one rest, not two");
  assert.ok(rests[0].corroborated_by.includes("photo"),
    "a photo is independent evidence he stopped — that is what corroboration means here");
  // And it is load-bearing, not decoration. Two precise fixes with nothing to
  // corroborate them are not a rest (REST_UNCORROBORATED_PRECISE = 3) — raising
  // that count instead would delete the long quiet stops, so the rule has always
  // been "two fixes plus an independent witness". The photo IS that witness.
  const withoutPhoto = findRests(pings.filter(p => p.kind !== "photo"), T0, T0 + 42 * MIN);
  assert.equal(withoutPhoto.length, 0,
    "without the camera fix this window supports no rest at all");
  // It also moves where the rest is: the GPS pair alone averages the walk-out
  // and the walk-back, which is how the stop ended up 65 m from the café.
  assert.ok(Math.abs(rests[0].lon - FIX_0831.lon) > 0,
    "the camera fix pulls the rest toward where he actually stood");
});

// ---------------------------------------------------------------------------
// Naming: read the sign, do not order off the nearby list
// ---------------------------------------------------------------------------

test("groundedInPhoto accepts a name the OCR supports", () => {
  assert.equal(groundedInPhoto("Tremor Coffee Room", TREMOR_BAG), true);
  // "Tremor" alone is still quoted from the bag.
  assert.equal(groundedInPhoto("Tremor", TREMOR_BAG), true);
});

test("groundedInPhoto rejects the nearby list — this is the 2026-09-05 miss", () => {
  // The narrator's own guess that morning, 130 m away. Nothing in the frame
  // says "Thought", and the model must not be able to launder the hint list into
  // an answer.
  assert.equal(groundedInPhoto("Thought Coffee", TREMOR_BAG), false);
  assert.equal(groundedInPhoto("Artisan Bakery Example", TREMOR_BAG), false);
  assert.equal(groundedInPhoto("Gyros example", TREMOR_BAG), false);
});

test("names the stop from the sign, at photo_text", async () => {
  const asked = [];
  const res = await nameStopsFromPhotoText([stopFixture([PHOTO_ROW])], textFor, {
    savedPlacesNear: () => [{ name: "Gyros example", distance_m: 143 }],
    ask: async payload => {
      asked.push(payload);
      return { name: "Tremor Coffee Room", confidence: 0.94,
               evidence: "terremoto + terremotocoffee + coffee + room" };
    },
  });
  assert.equal(res.named.length, 1);
  assert.equal(res.named[0].name, "Tremor Coffee Room");
  assert.equal(res.calls, 1, "one stop, one model call");

  // The model sees words and names — never coordinates. Geometry stays in code.
  const [payload] = asked;
  assert.deepEqual(payload.photo_words, TREMOR_BAG);
  assert.ok(!JSON.stringify(payload).includes("40.74"), "no coordinates reach the model");
  assert.ok(payload.nearby_places.some(p => p.name === "Thought Coffee"),
    "the POI guesses are offered as spellings to confirm");
});

test("a settled source survives the whole ladder", () => {
  assert.ok(RESOLVER_SETTLED.has("photo_text"));
  assert.ok(RESOLVER_SETTLED.has("saved_place"));
});

test("declines rather than guesses: low confidence, no name, ungrounded name", async () => {
  const cases = [
    [{ name: "Tremor Coffee Room", confidence: 0.5, evidence: "" }, "below the"],
    [{ name: null, confidence: 0.9, evidence: "" }, "do not name a venue"],
    [{ name: "Thought Coffee", confidence: 0.99, evidence: "" }, "not grounded"],
  ];
  for (const [verdict, expect] of cases) {
    const stop = stopFixture([PHOTO_ROW]);
    const res = await nameStopsFromPhotoText([stop], textFor, {
      savedPlacesNear: () => [], ask: async () => verdict,
    });
    assert.equal(res.named.length, 0, `should decline: ${JSON.stringify(verdict)}`);
    assert.match(res.declined[0].reason, new RegExp(expect));
    assert.equal(stop.place.name, null, "the stop is left as a question for him");
    assert.equal(stop.unnamed, true);
  }
});

test("a model failure leaves the day intact", async () => {
  const stop = stopFixture([PHOTO_ROW]);
  const res = await nameStopsFromPhotoText([stop], textFor, {
    savedPlacesNear: () => [],
    ask: async () => { throw new Error("Anthropic 529: overloaded"); },
  });
  assert.equal(res.named.length, 0);
  assert.match(res.declined[0].reason, /model call failed/);
  assert.equal(stop.unnamed, true);
});

test("only photos taken inside the rest are eligible", () => {
  const outside = { uuid: "OTHER", ts: "2026-09-05T12:29:00Z", lat: 40.74, lon: -74.0,
                    self_captured: true };
  const stop = stopFixture([PHOTO_ROW, outside]);
  stop.photo_text_eligible = ["CFB23CB8"];      // the caller's geometry verdict
  const both = uuid => ({ tokens: TREMOR_BAG, labels: [] });
  assert.equal(bestPhotoForStop(stop, both).uuid, "CFB23CB8",
    "a photo from the walk in is a picture of somewhere he passed");
});

test("no OCR, no call", async () => {
  const stop = stopFixture([PHOTO_ROW]);
  let called = 0;
  const res = await nameStopsFromPhotoText([stop], () => ({ tokens: [], labels: [] }), {
    savedPlacesNear: () => [], ask: async () => { called += 1; return {}; },
  });
  assert.equal(called, 0, "an image with no legible text costs nothing");
  assert.equal(res.named.length, 0);
});
