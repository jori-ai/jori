// day-window.test.mjs — which UTC window is "date X", and which zone cuts it.
//
// The case: a day spent seven hours east of home opened its summary at 07:00
// with the user still asleep until 07:29, because every such day was cut at
// midnight HOME time (07:00 local): the zone lookup matched only country names
// in the travel label (a bare street address names none), and the harvest and
// chat fetch carried their own hard-wired home-zone windows, so the first seven
// hours of each day's chat, commits, mail and notes were never read. One window
// helper now serves all of them. The home zone here is a synthetic one.
//
// Run: node --test tests/day-window.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
process.env.JORI_TZ = "America/Chicago"; // the synthetic home zone, before the libs load
const W = require("../lib/day-window.js");
const TZ = require("../lib/travel-timezone.js");
const H = require("../lib/daily-summary-harvest.js");

test("a day abroad starts at local midnight, not home midnight", () => {
  assert.equal(new Date(W.zonedMidnightMs("2026-10-14", "Asia/Jerusalem")).toISOString(), "2026-10-13T21:00:00.000Z");
  assert.equal(new Date(W.zonedMidnightMs("2026-10-14", "America/Chicago")).toISOString(), "2026-10-14T05:00:00.000Z");
  // the eight hours between the two are exactly the ones that would go missing
  assert.equal((W.zonedMidnightMs("2026-10-14", "America/Chicago") - W.zonedMidnightMs("2026-10-14", "Asia/Jerusalem")) / 3600000, 8);
  // and with no zone, the home zone
  assert.equal(W.zonedMidnightMs("2026-10-14"), W.zonedMidnightMs("2026-10-14", "America/Chicago"));
});

test("half-hour zones and winter London", () => {
  assert.equal(new Date(W.zonedMidnightMs("2026-10-14", "Asia/Kolkata")).toISOString(), "2026-10-13T18:30:00.000Z");
  assert.equal(new Date(W.zonedMidnightMs("2026-01-15", "Europe/London")).toISOString(), "2026-01-15T00:00:00.000Z");
  assert.equal(new Date(W.zonedMidnightMs("2026-07-15", "UTC")).toISOString(), "2026-07-15T00:00:00.000Z");
});

test("the two clock-change days a year land on the true midnight", () => {
  // US Eastern: spring forward 2026-03-08 (midnight is still standard time), fall back 2026-11-01 (still daylight time)
  assert.equal(new Date(W.zonedMidnightMs("2026-03-08", "America/New_York")).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(new Date(W.zonedMidnightMs("2026-11-01", "America/New_York")).toISOString(), "2026-11-01T04:00:00.000Z");
  // Israel falls back 2026-10-25 at 02:00: midnight that day is still IDT (UTC+3)
  assert.equal(new Date(W.zonedMidnightMs("2026-10-25", "Asia/Jerusalem")).toISOString(), "2026-10-24T21:00:00.000Z");
  // so the day itself is 25 hours long
  const w = W.dayWindow("2026-10-25", "Asia/Jerusalem");
  assert.equal((w.endMs - w.startMs) / 3600000, 25);
});

test("dayWindow(date, tz, 2) runs through the end of the next day", () => {
  const w = W.dayWindow("2026-10-14", "Asia/Jerusalem", 2);
  assert.equal(w.start, "2026-10-13T21:00:00.000Z");
  assert.equal(w.end, "2026-10-15T21:00:00.000Z");
});

test("boundaryTzOf: the day-path's zone, then the display zone, then the fallback", () => {
  assert.equal(W.boundaryTzOf({ path: { tz: "Asia/Jerusalem" }, tz: "America/Chicago" }), "Asia/Jerusalem");
  assert.equal(W.boundaryTzOf({ path: null, tz: "Europe/Paris" }), "Europe/Paris");
  assert.equal(W.boundaryTzOf({}), "America/Chicago", "the home zone");
  assert.equal(W.boundaryTzOf(null, "UTC"), "UTC");
});

// ---- the travel timeline -> zone --------------------------------------------

test("a bare street address is placed by the metro slug, read before the label", () => {
  assert.equal(TZ.tzFromWhere({ metro: "athens", label: "Odos Example 4, Old Town" }), "Europe/Athens");
  assert.equal(TZ.tzFromWhere({ metro: "chicago", label: "123 Example Ave" }), "America/Chicago");
});

test("an unmapped metro still falls back to a country named in the label", () => {
  assert.equal(TZ.tzFromWhere({ metro: "lakeside", label: "Lakeside, France — rental" }), "Europe/Paris");
  assert.equal(TZ.tzFromWhere({ metro: "hill_town", label: "Hill Town, India" }), "Asia/Kolkata");
});

test("transit, ambiguity and nothing at all name no zone", () => {
  assert.equal(TZ.tzFromWhere({ metro: "transit", label: "AAA→BBB (Example Air)" }), null);
  assert.equal(TZ.tzFromWhere({ metro: null, ambiguous: true, label: "City A/City B (ambiguous)" }), null);
  assert.equal(TZ.tzFromWhere(null), null);
});

test("the installation's own metro keys come from config, as ISO codes", () => {
  const G = require("../lib/geo-timezone.js");
  const m = G.metroTzFrom({ home_town: "US-NV", seaside: "PT", nowhere: "ZZ" });
  assert.equal(G.timezoneForMetro("home_town", null, m), "America/Los_Angeles");
  assert.equal(G.timezoneForMetro("seaside", null, m), "Europe/Lisbon");
  assert.equal(G.timezoneForMetro("nowhere", null, m), null, "an unknown code places nothing");
  assert.equal(G.timezoneForMetro("paris", null, m), "Europe/Paris", "the built-in cities stay");
});

test("a flight day belongs to the zone it began in", () => {
  // `travel where <date>` answers for 19:00 home time; on a flight day that instant is mid-air
  const answers = {
    "2026-10-31": { metro: "transit", label: "BBB→AAA (Example Air)" },
    "2026-10-31T13:00:00Z": { metro: "athens", label: "Odos Example 4, Old Town" }, // 08:00 home (CDT)
    "2026-10-31T05:00:00Z": { metro: "athens", label: "Odos Example 4, Old Town" }, // home midnight
  };
  const asked = [];
  const tz = TZ.getDisplayTzForDate("2026-10-31", (when) => { asked.push(when); return answers[when]; });
  assert.equal(tz, "Europe/Athens");
  assert.deepEqual(asked, ["2026-10-31", "2026-10-31T13:00:00Z"], "stops at the first probe that names a zone");
});

test("an unreadable timeline is home, never a throw", () => {
  assert.equal(TZ.getDisplayTzForDate("2026-10-31", () => { throw new Error("boom"); }), "America/Chicago");
  assert.equal(TZ.getDisplayTzForDate("2026-10-31", () => null), "America/Chicago");
});

// ---- the harvest follows the same window ------------------------------------

test("the harvest window for a day abroad is that day", () => {
  const w = H.dayWindow("2026-10-14", "Asia/Jerusalem");
  assert.equal(w.start, "2026-10-13T21:00:00.000Z");
  assert.equal(w.end, "2026-10-14T21:00:00.000Z");
  // and still the home zone when no zone is given
  assert.equal(H.dayWindow("2026-07-15").start, "2026-07-15T05:00:00.000Z");
});

test("a message at 02:00 local time is on the day it was sent, not the day before", () => {
  const rows = [{ id: 1, role: "user", content: "up late", created_at: "2026-10-13T23:00:00Z" }]; // 02:00 IDT Oct 14
  const il = H.chatFacts(rows, H.dayWindow("2026-10-14", "Asia/Jerusalem"));
  const home = H.chatFacts(rows, H.dayWindow("2026-10-14", "America/Chicago"));
  assert.equal(il.length, 1, "inside the local day");
  assert.equal(home.length, 0, "this is what the home-zone window dropped");
});

test("a raw-fact cache cut in another zone is refetched, not reused", () => {
  let fetched = 0;
  const sources = { git: () => { fetched++; return { commits: [], added: [] }; }, sentMail: () => [], notes: () => [], corrections: () => [] };
  const cachedAtHome = { date: "2026-10-14", raw: { commits: [], new_files: [], sent_mail: [], notes: [] }, errors: {} };
  H.harvestDay({ date: "2026-10-14", cached: cachedAtHome, sources, tz: "Asia/Jerusalem" });
  assert.equal(fetched, 1, "a home-cut cache is stale for a day abroad");
  const h = H.harvestDay({ date: "2026-10-14", cached: cachedAtHome, sources });
  assert.equal(fetched, 1, "the same zone still reuses it");
  assert.equal(h.window.boundary_tz, "America/Chicago");
  const h2 = H.harvestDay({ date: "2026-10-14", sources, tz: "Asia/Jerusalem" });
  assert.equal(h2._cache.tz, "Asia/Jerusalem");
  assert.equal(h2.window.boundary_tz, "Asia/Jerusalem");
});
