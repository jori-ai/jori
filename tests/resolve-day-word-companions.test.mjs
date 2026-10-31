// resolve-day-word-companions.test.mjs — the people he named are on the stop he named.
//
// 2026-10-16, Portside: "had dinner here <maps link> with Yuri and Paige". day-statements
// (a model) read it as Shawarma Example with Yuri and Paige, but only Find My
// proximity ever wrote a companion, so the summary's header carried no one.
//
// Run: node --test tests/resolve-day-word-companions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { applyStatementCompanions, applyNonStopCompanions } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const U = (hms) => Date.parse(`2026-10-16T${hms}Z`);
const stop = (id, name, from, to) => ({ id, start_ts_ms: U(from), end_ts_ms: U(to),
  place: { name, source: "confirmed_stop" }, companions: [] });
const TZ = { _meta: { tz: "Asia/Jerusalem" } };

test("the companions he named land on the stop he named, by the model's time", () => {
  const dinner = stop("s-20261016-p3", "Shawarma Example", "17:27:00", "18:42:40");
  const home = stop("s-20261016-6", "The Harbor Flat", "18:42:40", "21:00:00");
  const statements = { ...TZ, places: [
    { venue: "Shawarma Example", said_at: "22:47", when_hint: "earlier", companions: ["Yuri", "Paige"],
      evidence: "had dinner here - https://maps.app.goo.gl/PiBCCtnL8GqmtTG58 with Yuri and Paige" },
    { venue: "The Airbnb", said_at: "15:15", when_hint: "05:39", companions: [] },
  ] };
  const applied = applyStatementCompanions([dinner, home], statements, "2026-10-16");
  assert.deepEqual(dinner.companions, ["Yuri", "Paige"]);
  assert.deepEqual(home.companions, []);
  assert.equal(applied.length, 1);
});

test("a name said 'now' binds to the stop he was at as he wrote", () => {
  const first = stop("s-a", "August", "09:00:00", "10:00:00");
  const second = stop("s-b", "August", "15:15:00", "16:16:00");
  applyStatementCompanions([first, second], { ...TZ, places: [
    { venue: "August", said_at: "18:19", when_hint: "now", companions: ["Yuri"] }] }, "2026-10-16");
  assert.deepEqual(first.companions, []);
  assert.deepEqual(second.companions, ["Yuri"]);
});

test("no statements file, no companions", () => {
  const s = stop("s-x", "Shawarma Example", "17:27:00", "18:42:40");
  assert.deepEqual(applyStatementCompanions([s], null, "2026-10-16"), []);
  assert.deepEqual(s.companions, []);
});

test("the people on a walk he described ride onto the walk block, by the model's window", () => {
  // 2026-10-18: "We (Paige, Rover and I) had our morning coffee at Corvina, then took
  // rover for a long walk along the beach" left the walk with nobody on it.
  const cafe = stop("s-a1", "Café Corvina", "06:00:00", "06:56:00");
  const walk = { ...stop("s-loop", "Walk along the beach", "06:56:00", "07:37:00"), excursion: { away_m: 651 } };
  const home = stop("s-p1", "The Harbor Flat", "07:37:00", "11:22:00");
  const statements = { ...TZ,
    places: [{ venue: "Corvina", said_at: "10:46", when_hint: "earlier", companions: ["Paige", "Rover"],
               evidence: "We (Paige, Rover and I) had our morning coffee at Corvina" }],
    non_stops: [
      { evidence: "took rover for a long walk along the beach", said_at: "10:46", from: "10:14", to: "10:39", companions: ["Paige", "Rover"] },
      { evidence: "then I drove Abby back home", said_at: "22:24", from: "19:25", to: "19:55", companions: ["Abby"] },
      { evidence: "walked around", said_at: "12:00", from: null, to: null, companions: ["Yuri"] },
    ] };
  const placed = applyStatementCompanions([cafe, walk, home], statements, "2026-10-16");
  assert.deepEqual(cafe.companions, ["Paige", "Rover"]);
  assert.deepEqual(walk.companions, [], "the places pass never binds a non-stop: the walk block is often built later");
  const applied = applyNonStopCompanions([cafe, walk, home], statements, "2026-10-16");
  assert.deepEqual(walk.companions, ["Paige", "Rover"]);
  assert.deepEqual(home.companions, [], "a stop that is not movement is never bound by a non-stop's window");
  assert.deepEqual(applied.map(a => a.id), ["s-loop"]);
  assert.ok(placed.every(a => !a.non_stop));
});

// 2026-10-21, Harbor City: "the hotel for the conference", his reply to the
// 10:30 ask. The row he answered reads "Hotel Example", so no name test binds
// "Hotel example"; the stop is his own answer for that window, and the model put
// the statement at 10:30, inside the minute the stop began (10:30:56).
test("what he said he was there for binds to the stop he answered, by the model's time (2026-10-21)", () => {
  const { applyStatementWords } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;
  const D = (hms) => Date.parse(`2026-10-21T${hms}Z`);
  const antilia = { id: "s-1", start_ts_ms: D("06:04:45"), end_ts_ms: D("07:16:57"),
    place: { name: "Café Corvina", source: "user_confirmed" }, confirmed_row: { place_type: "named" } };
  const hilton = { id: "s-2", start_ts_ms: D("07:30:56"), end_ts_ms: D("07:56:22"),
    place: { name: "Hotel Example", source: "user_confirmed" }, confirmed_row: { place_type: "user-confirmed" } };
  const flat = { id: "s-7", start_ts_ms: D("14:13:17"), end_ts_ms: D("17:36:58"),
    place: { name: "The Harbor Flat", source: "confirmed_stop" }, confirmed_row: { place_type: "named" } };
  const statements = { _meta: { tz: "Asia/Jerusalem" }, places: [
    { venue: "Hotel example", activity: "AI conference", when_hint: "10:30", evidence: "the hotel for the conference" },
    // A plan said at the flat about a place he had not reached: the flat is neither that place nor his answer.
    { venue: "Tamsa", activity: "meeting Evan and Ivy", when_hint: "20:32", evidence: "We're going to meet Evan and Ivy at Tamsa" },
  ] };
  const applied = applyStatementWords([antilia, hilton, flat], statements, "2026-10-21");
  assert.deepEqual(applied.map(a => a.id), ["s-2"]);
  assert.equal(hilton.his_words[0].activity, "AI conference");
  assert.equal(antilia.his_words, undefined);
  assert.equal(flat.his_words, undefined);
  assert.deepEqual(applyStatementWords([hilton], null, "2026-10-21"), []);
});
