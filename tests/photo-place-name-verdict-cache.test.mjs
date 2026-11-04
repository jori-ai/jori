// photo-place-name-verdict-cache.test.mjs — one answer per question.
// A day is resolved on every live-day refresh and again for the daily summary,
// and each pass used to ask about every photo stop afresh: one bakery
// storefront photo was asked seven times in 19 hours and
// logged as a new Jev disagreement each time. An identical input now gets the
// answer it already got; a changed one, or a failed call, is asked again.
// Run: node --test tests/photo-place-name-verdict-cache.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { nameStopsFromPhotoText } = require("../lib/photo-place-name.js");

const HE = "מאפיית דוגמה";
const stop = (current) => ({
  id: "s1", start: "07:11", end: "08:24", lat: 23.456706, lon: -54.321089, photo_text_eligible: ["P1"],
  photos: [{ uuid: "P1", self_captured: true, lat: 23.45671, lon: -54.32109, ts: "2026-10-12T04:40:44Z" }],
  place: current ? { name: current, source: "user_confirmed", confidence: 1 } : null,
});
const text = () => ({ tokens: ["bakery", "example", "house", "market"], labels: ["storefront"] });
const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ppn-cache-")), "verdicts.json");
const counting = (verdict) => {
  const fn = async () => { fn.calls += 1; if (verdict instanceof Error) throw verdict; return verdict; };
  fn.calls = 0;
  return fn;
};

test("the same photo, stop and nearby list is asked once across passes", async () => {
  const file = tmpCache();
  const ask = counting({ name: "Example Market House Bakery", listed: HE, confidence: 0.6, evidence: "sign" });
  const a = await nameStopsFromPhotoText([stop(HE)], text, { ask, verdictCache: file });
  const b = await nameStopsFromPhotoText([stop(HE)], text, { ask, verdictCache: file });
  assert.equal(ask.calls, 1);
  assert.deepEqual(b.declined, a.declined);
  assert.equal(b.declined[0].reason, "below the 0.8 bar — left as a question");
});

test("a kept answer names a fresh stop exactly as the first pass did", async () => {
  const file = tmpCache();
  const ask = counting({ name: "Example", listed: HE, confidence: 0.9, evidence: "sign" });
  const s1 = stop(null), s2 = stop(null);
  await nameStopsFromPhotoText([s1], text, { ask, verdictCache: file });
  await nameStopsFromPhotoText([s2], text, { ask, verdictCache: file });
  assert.equal(ask.calls, 1);
  assert.equal(s1.place.name, "Example");
  assert.equal(s2.place.name, "Example");
});

test("a renamed stop is a new question", async () => {
  const file = tmpCache();
  const ask = counting({ name: "Example", listed: HE, confidence: 0.6, evidence: "sign" });
  await nameStopsFromPhotoText([stop(HE)], text, { ask, verdictCache: file });
  await nameStopsFromPhotoText([stop("Market House")], text, { ask, verdictCache: file });
  assert.equal(ask.calls, 2);
});

test("a failed call is not kept: the next pass asks again", async () => {
  const file = tmpCache();
  const fail = counting(new Error("claude -p: Not logged in"));
  const r = await nameStopsFromPhotoText([stop(HE)], text, { ask: fail, verdictCache: file });
  assert.equal(r.declined[0].reason, "model call failed: claude -p: Not logged in");
  const ok = counting({ name: "Example", listed: HE, confidence: 0.6, evidence: "sign" });
  await nameStopsFromPhotoText([stop(HE)], text, { ask: ok, verdictCache: file });
  assert.equal(ok.calls, 1);
});

test("an empty answer is not kept", async () => {
  const file = tmpCache();
  const ask = counting(null);
  await nameStopsFromPhotoText([stop(HE)], text, { ask, verdictCache: file });
  await nameStopsFromPhotoText([stop(HE)], text, { ask, verdictCache: file });
  assert.equal(ask.calls, 2);
});

test("an answer older than three weeks is asked again", async () => {
  const file = tmpCache();
  const ask = counting({ name: "Example", listed: HE, confidence: 0.6, evidence: "sign" });
  await nameStopsFromPhotoText([stop(HE)], text, { ask, verdictCache: file });
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const v of Object.values(kept)) v.at = new Date(Date.now() - 22 * 86400000).toISOString();
  fs.writeFileSync(file, JSON.stringify(kept));
  await nameStopsFromPhotoText([stop(HE)], text, { ask, verdictCache: file });
  assert.equal(ask.calls, 2);
});

test("an injected reader with no cache file named stays uncached", async () => {
  const ask = counting({ name: "Example", listed: HE, confidence: 0.6, evidence: "sign" });
  await nameStopsFromPhotoText([stop(HE)], text, { ask });
  await nameStopsFromPhotoText([stop(HE)], text, { ask });
  assert.equal(ask.calls, 2);
});
