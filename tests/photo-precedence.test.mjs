// photo-precedence.test.mjs — the photo always takes precedence: an 11:37 café
// stop was still titled with the office before it (an answer that spilled
// over) while the user's photo showed the café's sign. Synthetic venue and spot.
// Run: node --test tests/photo-precedence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { nameStopsFromPhotoText } = require("../lib/photo-place-name.js");
const { planNameWriteBack } = require("../lib/stop-name-writeback.js");

const cafeStop = () => ({
  id: "s5", start: "11:37", end: "12:23", lat: 12.34565, lon: -65.43215, photo_text_eligible: ["P1"],
  photos: [{ uuid: "P1", self_captured: true, lat: 12.34569, lon: -65.43211, ts: "2026-10-07T08:45:43Z" }],
  place: { name: "משרד דוגמה", source: "user_confirmed", confidence: 1 },
  alternatives: [{ name: "קפה דוגמה", source: "google_places", distance_km: 0.0158 }],
});
const text = () => ({ tokens: ["br", "come", "knows", "dugma", "t", "to"], labels: ["restaurant", "table"] });
// Jev read "dugma" as the Hebrew-named café on the list.
const jevPicks = (name, distance_m) => async () => ({ name, confidence: 0.95, evidence: "jev", from_list: true, distance_m });

test("a sign naming somewhere else replaces even a user_confirmed name, and keeps the old one", async () => {
  const s = cafeStop();
  const r = await nameStopsFromPhotoText([s], text, { decide: jevPicks("קפה דוגמה", 16) });
  assert.equal(s.place.name, "קפה דוגמה");
  assert.equal(s.place.source, "photo_text");
  assert.deepEqual(s.photo_overrode, { name: "משרד דוגמה", source: "user_confirmed" });
  assert.equal(r.named[0].was, "משרד דוגמה");
});

test("a non-Latin listed name is grounded by distance, not spelling — and only when close", async () => {
  const far = cafeStop();
  await nameStopsFromPhotoText([far], text, { decide: jevPicks("קפה דוגמה", 140) });
  assert.equal(far.place.name, "משרד דוגמה");
});

test("a sign that spells the current name changes nothing", async () => {
  const s = cafeStop();
  s.place = { name: "Cafe Dugma", source: "user_confirmed" };
  const r = await nameStopsFromPhotoText([s], text, { decide: async () => ({ name: "Cafe Dugma", confidence: 0.95, from_list: true }) });
  assert.equal(s.place.source, "user_confirmed");
  assert.equal(r.named.length, 0);
});

test("the photo's name is written over a verdict row, but never over a non-stop", () => {
  const s = { ...cafeStop(), start_ts_ms: Date.parse("2026-10-07T08:37:33Z"), end_ts_ms: Date.parse("2026-10-07T09:23:15Z"),
    place: { name: "קפה דוגמה", source: "photo_text" }, photo_overrode: { name: "משרד דוגמה", source: "user_confirmed" } };
  const pings = [0, 5, 10, 15].map((m) => ({ ts: s.start_ts_ms + m * 60000, lat: 12.34565, lon: -65.43215, acc: 10, kind: "fix" }));
  const row = (id, type) => ({ id, latitude: 12.34565, longitude: -65.43215, arrived_at: "2026-10-07T08:37:33Z",
    departed_at: "2026-10-07T09:23:15Z", place_name: "משרד דוגמה", place_type: type });
  const plan = planNameWriteBack([s], [row("a", "user-confirmed"), row("b", "non-stop")], pings);
  assert.deepEqual(plan.writes.map((w) => w.row), ["a"]);
});
