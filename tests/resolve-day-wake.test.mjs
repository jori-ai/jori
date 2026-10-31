// resolve-day-wake.test.mjs — wake-time selection. Anchored on the 2026-06-27
// "Woke 23:26" bug: phone_unlocks was empty and the old fallback returned the
// earliest phone_context row of the day — a single stray 23:26 reading — as
// wake. pickWake must (a) trust phone_unlocks at any hour, (b) otherwise take
// the earliest signal in the plausible morning window, (c) return null rather
// than fabricate when nothing plausible exists.
// Run: node --test tests/resolve-day-wake.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// The fixtures are a home-zone (US Eastern) day; pin the home zone so a host in
// another zone, or a fresh install, reads them the same.
process.env.JORI_TZ = "America/New_York";
const { _internal } = require("../lib/resolve-day.js");
const { pickWake } = _internal;
// ts_ms (the raw instant, for per-stop-zone re-statement) is checked elsewhere.
const strip = (w) => w && { at: w.at, source: w.source };

// ET helpers: a UTC ms for a given ET wall-clock on 2026-06-27 (EDT = UTC-4).
const et = (hh, mm = 0) => Date.parse(`2026-06-27T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`);

test("phone_unlocks is authoritative at any hour", () => {
  const w = pickWake({ unlockMs: et(7, 12), ctxMs: [et(6)], msgMs: [] });
  assert.deepEqual(strip(w), { at: "07:12", source: "phone_unlocks" });
});

test("the 2026-06-27 bug: a lone 23:26 phone_context never becomes wake", () => {
  // No unlock; the only phone_context is the stray 23:26 reading; user messages
  // are pre-sleep (00:39). Nothing in [04:00,13:00) -> null, not "23:26".
  const w = pickWake({ unlockMs: null, ctxMs: [et(23, 26)], msgMs: [et(0, 39), et(0, 41)] });
  assert.equal(w, null);
});

test("without unlock, earliest signal inside the morning window wins", () => {
  // A pre-dawn insomnia ping (02:10) is out of window; the real morning signal
  // (08:05 message) is picked over a later 09:30 context.
  const w = pickWake({
    unlockMs: null,
    ctxMs: [et(2, 10), et(9, 30)],
    msgMs: [et(8, 5)],
  });
  assert.deepEqual(strip(w), { at: "08:05", source: "first_user_message" });
});

test("earliest in-window across both sources is chosen", () => {
  const w = pickWake({ unlockMs: null, ctxMs: [et(7, 0)], msgMs: [et(6, 30)] });
  assert.deepEqual(strip(w), { at: "06:30", source: "first_user_message" });
});

test("an evening-only day (phone died, no morning signal) yields null", () => {
  const w = pickWake({ unlockMs: null, ctxMs: [et(19, 0), et(21, 15)], msgMs: [et(20, 0)] });
  assert.equal(w, null);
});

test("window boundaries: 04:00 included, 13:00 excluded", () => {
  assert.deepEqual(strip(pickWake({ ctxMs: [et(4, 0)] })), { at: "04:00", source: "phone_context" });
  assert.equal(pickWake({ ctxMs: [et(13, 0)] }), null);
});

test("empty input -> null", () => {
  assert.equal(pickWake({}), null);
  assert.equal(pickWake({ unlockMs: null, ctxMs: [], msgMs: [] }), null);
});

test("a photo or leaving the flat before the first message wins, and is 'up by', not 'woke' (2026-10-08)", () => {
  const w = pickWake({ msgMs: [et(8, 41)], extra: [
    { ms: et(8, 24), source: "first_photo" },
    { ms: et(8, 15), source: "left_overnight_place", detail: "the airbnb" },
  ] });
  assert.equal(w.source, "left_overnight_place");
  assert.equal(w.phone_use, false);
  const u = pickWake({ msgMs: [et(8, 41)], extra: [{ ms: et(7, 5), source: "phone_usage" }] });
  assert.equal(u.source, "phone_usage");
  assert.equal(u.phone_use, true);
});
