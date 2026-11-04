// photo-place-name-cross-script.test.mjs — one café, two scripts.
// A café is listed in Hebrew ("קפה דוגמה") and signed in Latin letters. Jev
// picks the list's name, the legacy model read spells the sign ("Cafe Dugma")
// and says which listed place it means in `listed`. Synthetic venue and spot. Same place:
// no disagreement, and a re-read never renames the stop to its own other
// spelling.
// Run: node --test tests/photo-place-name-cross-script.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { nameStopsFromPhotoText } = require("../lib/photo-place-name.js");

const HE = "קפה דוגמה";
const stop = (current) => ({
  id: "s5", start: "11:37", end: "12:23", lat: 12.34565, lon: -65.43215, photo_text_eligible: ["P1"],
  photos: [{ uuid: "P1", self_captured: true, lat: 12.34569, lon: -65.43211, ts: "2026-10-07T08:45:43Z" }],
  place: current ? { name: current, source: "photo_text", confidence: 0.85 } : null,
  alternatives: [{ name: HE, source: "google_places", distance_km: 0.0158 }],
});
const text = () => ({ tokens: ["br", "come", "knows", "cafe", "t", "to", "dugma"], labels: ["restaurant", "table"] });
const sonnetSays = (name, listed) => async () => ({ name, listed, confidence: 0.85, evidence: "sign reads CAFE / dugma" });

test("a Latin read of the Hebrew name the stop already has confirms it, not renames it", async () => {
  const s = stop(HE);
  const r = await nameStopsFromPhotoText([s], text, { ask: sonnetSays("Cafe Dugma", HE) });
  assert.equal(s.place.name, HE);
  assert.equal(s.photo_overrode, undefined);
  assert.equal(r.named.length, 0);
  assert.equal(r.declined[0].reason, "the photo confirms the name the stop already has");
});

test("without `listed` the old behaviour holds: a grounded Latin name replaces the Hebrew one", async () => {
  const s = stop(HE);
  const r = await nameStopsFromPhotoText([s], text, { ask: sonnetSays("Cafe Dugma", null) });
  assert.equal(s.place.name, "Cafe Dugma");
  assert.deepEqual(s.photo_overrode, { name: HE, source: "photo_text" });
  assert.equal(r.named.length, 1);
});

test("a pick of the stop's own (distance-less) name is a confirmation, not 'not grounded'", async () => {
  const s = stop(HE);
  const decide = async () => ({ name: HE, confidence: 0.86, evidence: "jev", from_list: true, distance_m: null });
  const r = await nameStopsFromPhotoText([s], text, { decide });
  assert.equal(s.place.name, HE);
  assert.equal(r.declined[0].reason, "the photo confirms the name the stop already has");
});

test("`listed` naming a DIFFERENT place than the current one still renames", async () => {
  const s = stop("משרד דוגמה");
  const r = await nameStopsFromPhotoText([s], text, { ask: sonnetSays("Cafe Dugma", HE) });
  assert.equal(s.place.name, "Cafe Dugma");
  assert.deepEqual(s.photo_overrode, { name: "משרד דוגמה", source: "photo_text" });
});
