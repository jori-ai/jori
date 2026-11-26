// calendar-place.test.mjs — if the calendar already identifies the stop, don't
// ask about it (a 09:28 print shop on the calendar). Synthetic places.
// Run: node --test tests/calendar-place.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeEvents, calendarPlaceAt, geocodeLocation, CAL_MATCH_M } from "../lib/calendar-place.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };

const PRINT = { summary: "Print & Coffee", location: "Example Blvd 37, Sampleton",
  start: { dateTime: "2026-10-07T09:00:00+03:00" }, end: { dateTime: "2026-10-07T10:00:00+03:00" } };
const SHOP = { ...fakeAt(0, 0) };           // geocode of Example Blvd 37
const AT_COUNTER = [{ ...fakeAt(-11.31, -3.34) }];   // the 09:30 fix / 09:29 photo
const W = { start: "2026-10-07T06:25:01Z", end: "2026-10-07T06:41:24Z" };
const deps = (events, geo = SHOP) => ({ listEvents: () => ({ events, error: null }), geocode: () => geo });

test("the user was at the place on their calendar → match, named from the event", () => {
  const r = calendarPlaceAt({ ...W, points: AT_COUNTER }, deps([PRINT]));
  assert.equal(r.match?.summary, "Print & Coffee");
  assert.ok(r.match.distance_m <= CAL_MATCH_M);
});

test("same event, but the user was 250 m away (the café before it) → no match", () => {
  const r = calendarPlaceAt({ ...W, points: [{ ...fakeAt(-238.43, 219.05) }] }, deps([PRINT]));
  assert.equal(r.match, null);
});

test("all-day, transparent, URL and day-long events never place him", () => {
  const evs = [
    { ...PRINT, start: { date: "2026-10-07" }, end: { date: "2026-10-08" } },
    { ...PRINT, transparency: "transparent" },
    { ...PRINT, location: "https://zoom.us/j/1" },
    { ...PRINT, start: { dateTime: "2026-10-07T06:00:00+03:00" }, end: { dateTime: "2026-10-07T18:00:00+03:00" } },
  ];
  assert.equal(placeEvents(evs, Date.parse(W.start), Date.parse(W.end)).length, 0);
});

test("a failed calendar lookup is reported, not read as an empty calendar", () => {
  const r = calendarPlaceAt({ ...W, points: AT_COUNTER }, { listEvents: () => ({ events: [], error: "no TTY" }), geocode: () => SHOP });
  assert.equal(r.match, null);
  assert.equal(r.error, "no TTY");
});

test("the tightest overlapping event wins", () => {
  const errands = { ...PRINT, summary: "Errands", start: { dateTime: "2026-10-07T08:00:00+03:00" }, end: { dateTime: "2026-10-07T12:00:00+03:00" } };
  const r = calendarPlaceAt({ ...W, points: AT_COUNTER }, deps([errands, PRINT]));
  assert.equal(r.match.summary, "Print & Coffee");
});

// "Print and coffee was the name of the event … not a location" (2026-10-08).
import { venueForCalendarMatch } from "../lib/calendar-place.mjs";

const addr = { summary: "Print & Coffee", location: "Example Blvd 37, Sampleton", place_name: "Example Blvd 37",
  is_business: false, ...fakeAt(10.37, 6.67) };
const block = [
  { name: "אשר צעצועים", primary_type: "toy_store", distance_m: 12 },
  { name: "דפוס לדוגמה", primary_type: "electronics_store", distance_m: 3 },
  { name: "מאהר חלפים", primary_type: "car_repair", distance_m: 19 },
];
const jevPicks = (choice) => async (o) => { const it = o.interpret({ venue: { type: "choice", choice, probabilities: { [choice]: 0.9 } } }); return { value: it.value, used: "jev" }; };

test("the event title is never the name: an address resolves to the business Jev picks there", async () => {
  const v = await venueForCalendarMatch(addr, { near: () => block, decideImpl: jevPicks("c1") });
  assert.deepEqual([v.name, v.source], ["דפוס לדוגמה", "calendar_venue"]);
});

test("no clear pick → the stop is named by the address, not the title", async () => {
  const v = await venueForCalendarMatch(addr, { near: () => block, decideImpl: jevPicks("none") });
  assert.deepEqual([v.name, v.source], ["Example Blvd 37", "calendar_address"]);
  const empty = await venueForCalendarMatch(addr, { near: () => [] });
  assert.equal(empty.name, "Example Blvd 37");
});

test("a location that IS a business names it directly", async () => {
  const v = await venueForCalendarMatch({ ...addr, location: "Milk Bakery, Oak St 5", place_name: "Milk Bakery", is_business: true },
    { near: () => { throw new Error("not needed"); } });
  assert.deepEqual([v.name, v.source], ["Milk Bakery", "calendar_business"]);
});

test("two businesses at the address both fit → a shortlist question, no name", async () => {
  const split = async (o) => {
    const answers = { venue: { type: "choice", choice: "c2", probabilities: { c0: 0.01, c1: 0.32, c2: 0.42, none: 0.16 } } };
    return { value: await o.legacy(), used: "legacy", jev: { answers } };
  };
  const two = [...block, { name: "הדפסה על קנבס", primary_type: "point_of_interest", distance_m: 2 }];
  const v = await venueForCalendarMatch(addr, { near: () => two, decideImpl: split });
  assert.equal(v.source, "calendar_ambiguous");
  assert.equal(v.name, null);
  assert.deepEqual(v.shortlist.map((c) => c.name), ["מאהר חלפים", "דפוס לדוגמה"]);
});

// A refused lookup says nothing about the address: cached as a negative, it kept the calendar from
// placing a stop there for a week (a cinema address refused at the month's Places ceiling).
function fakeLookup(exitCode, stdout = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-geo-"));
  const bin = path.join(dir, "verify.sh");
  fs.writeFileSync(bin, `#!/bin/sh\n${stdout ? `echo '${stdout}'\n` : ""}exit ${exitCode}\n`, { mode: 0o755 });
  return { dir, bin, cacheFile: path.join(dir, "cache.json") };
}

for (const code of [3, 4, 5, 6]) {
  test(`a Places refusal (exit ${code}) is not cached as "no such address"`, () => {
    const f = fakeLookup(code);
    const out = geocodeLocation("Example Cinema, 1 Sample Blvd #3001, Sampleton", 12.3, -65.4, { cacheFile: f.cacheFile, verifyBin: f.bin });
    assert.equal(out, null);
    assert.equal(fs.existsSync(f.cacheFile), false, "a refusal must leave the cache untouched");
    fs.rmSync(f.dir, { recursive: true, force: true });
  });
}

test("a genuine no-match (exit 1) is still cached, and a match is returned and cached", () => {
  const none = fakeLookup(1);
  assert.equal(geocodeLocation("Nowhere Plaza", 12.3, -65.4, { cacheFile: none.cacheFile, verifyBin: none.bin }), null);
  assert.equal(JSON.parse(fs.readFileSync(none.cacheFile, "utf8"))["Nowhere Plaza"].lat, null);
  fs.rmSync(none.dir, { recursive: true, force: true });

  const hit = fakeLookup(0, '{"lat":12.3456,"lon":-65.4321,"name":"Example Cinema","address":"1 Sample Blvd"}');
  const g = geocodeLocation("Example Cinema, 1 Sample Blvd", 12.3, -65.4, { cacheFile: hit.cacheFile, verifyBin: hit.bin });
  assert.equal(g.name, "Example Cinema");
  assert.equal(JSON.parse(fs.readFileSync(hit.cacheFile, "utf8"))["Example Cinema, 1 Sample Blvd"].lat, 12.3456);
  fs.rmSync(hit.dir, { recursive: true, force: true });
});
