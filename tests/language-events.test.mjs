// language-events — events in the user's languages wherever the user is.
// Pins the code half: which cities the timeline puts the user in (sampled at each
// city's own evening), the per-date city gate with the tier-1 "worth the trip"
// bypass, comedy's clash note vs. drop-on-conflict for the rest, already-
// surfaced filtering, one item per performer, and the channel rule.
//
// Run: node --test tests/language-events.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "language-events-"));
// The test's own installation: synthetic metros with fixed zones and two
// languages, so it reads the same with or without a real agent/local.
const LOCAL = path.join(tmp, "local");
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ tz: "America/Chicago" }));
fs.writeFileSync(path.join(LOCAL, "config", "geo-timezone.json"), JSON.stringify({ metro_place: { far_city: "GR", home_city: "US-NY", coast_city: "US-FL" } }));
fs.writeFileSync(path.join(LOCAL, "config", "language-events.json"), JSON.stringify({ languages: ["en", "es"] }));
process.env.JORI_LOCAL_DIR = LOCAL;
delete process.env.JORI_TZ;
process.env.LANGUAGE_EVENTS_SEEN_FILE = path.join(tmp, "seen.json");
process.env.VENUE_SURFACED_FILE = path.join(tmp, "surfaced.json");
const L = await import("../lib/language-events.mjs");

const NOW = Date.parse("2026-10-22T10:00:00Z");
// Far City until Oct 31 evening, Home City from Nov 1, Coast City Nov 20 onward.
const SEGMENTS = [
  { id: "a", metro: "far_city", arrive_at: "2026-10-01T10:00:00Z", depart_at: "2026-10-31T22:00:00Z", source: "flights" },
  { id: "b", metro: "home_city", arrive_at: "2026-11-01T06:00:00Z", depart_at: "2026-11-20T14:00:00Z", source: "flights" },
  { id: "c", metro: "coast_city", arrive_at: "2026-11-20T18:00:00Z", depart_at: "2026-12-10T14:00:00Z", source: "flights" },
];

test("stays: each city with its date runs, from the timeline", () => {
  const runs = L.buildStays({ segments: SEGMENTS, fromDate: "2026-10-22", days: 35, nowMs: NOW });
  const by = Object.fromEntries(runs.map((r) => [r.metro, r]));
  assert.equal(by.far_city.from, "2026-10-22");
  assert.equal(by.far_city.to, "2026-10-31");
  assert.equal(by.far_city.tz, "Europe/Athens");
  assert.equal(by.home_city.from, "2026-11-01");
  assert.equal(by.home_city.to, "2026-11-19");
  assert.equal(by.coast_city.from, "2026-11-20");
});

test("stays: an evening in another city's zone is judged on that city's clock", () => {
  // The user leaves Far City at 19:00 local on Oct 31 (17:00Z): that evening is not a Far City evening.
  const segs = [{ id: "a", metro: "far_city", arrive_at: "2026-10-01T10:00:00Z", depart_at: "2026-10-31T17:00:00Z", source: "flights" }];
  const runs = L.buildStays({ segments: segs, fromDate: "2026-10-30", days: 2, nowMs: NOW });
  assert.deepEqual(runs.map((r) => r.dates), [["2026-10-30"]]);
});

test("stays: a calendar 'elsewhere' window over that evening removes it (calendar beats the timeline)", () => {
  const ms = L.localInstantMs("2026-10-24", "20:00", "Europe/Athens");
  const overrides = { windows: [{ base: "far_city", date: "2026-10-24", from: new Date(ms - 3 * 3600e3).toISOString(), to: new Date(ms + 3 * 3600e3).toISOString(), evidence: [{ title: "Overnight trip" }] }] };
  const runs = L.buildStays({ segments: SEGMENTS, overrides, fromDate: "2026-10-23", days: 3, nowMs: NOW });
  assert.deepEqual(runs.map((r) => r.dates), [["2026-10-23"], ["2026-10-25"]]);
});

const base = { performer: "Band Alpha", title: "Band Alpha live", city: "Home City", date: "2026-11-05", time: "20:00", url: "https://x/1", language: "es", category: "music" };
const gateOpts = (over = {}) => ({
  today: "2026-10-22",
  inCity: (metro, iso) => metro === "home_city" ? iso >= "2026-11-01" : metro === "far_city" ? iso < "2026-11-01" : false,
  isHeadliner: (n) => n === "Big Headliner",
  clash: () => ({ conflict: false }),
  ...over,
});

test("gate: only dates the user is in that city; tier-1 headliners come through tagged 'worth the trip'", () => {
  const { kept, dropped } = L.gateCandidates([
    base,
    { ...base, performer: "Singer Beta", city: "Home City", date: "2026-10-28", url: "https://x/2" },
    { ...base, performer: "Big Headliner", city: "Other Town", date: "2026-11-10", url: "https://x/3", language: "en" },
    { ...base, performer: "Singer Gamma", city: "Far City", date: "2026-10-29", url: "https://x/4" },
  ], gateOpts());
  assert.deepEqual(kept.map((k) => [k.performer, k.tag]), [["Band Alpha", null], ["Big Headliner", "worth the trip"], ["Singer Gamma", null]]);
  assert.deepEqual(dropped.map((d) => [d.candidate.performer, d.reason]), [["Singer Beta", "away that date"]]);
});

test("gate: the city check uses the show's local evening instant", () => {
  const seen = [];
  L.gateCandidates([{ ...base, city: "Far City", date: "2026-10-25", time: "21:00" }], gateOpts({ inCity: (m, iso) => { seen.push([m, iso]); return true; } }));
  assert.deepEqual(seen, [["far_city", "2026-10-25T19:00:00.000Z"]]);
});

test("gate: a clashing comedy show stays with the clash named; anything else drops", () => {
  const clash = () => ({ conflict: true, label: "Dinner with friends" });
  const { kept, dropped } = L.gateCandidates([
    { ...base, performer: "Comic Delta", category: "comedy", language: "en", url: "https://x/5" },
    { ...base, performer: "Singer Epsilon", url: "https://x/6" },
  ], gateOpts({ clash }));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].clash_note, "⚠︎ you already have Dinner with friends that night");
  assert.match(dropped[0].reason, /calendar conflict: Dinner with friends/);
});

test("gate: structure is checked in code; language must be a configured one as the agent judged it", () => {
  const { kept, dropped } = L.gateCandidates([
    { ...base, language: "fr", url: "https://x/7" },
    { ...base, url: "" },
    { ...base, date: "next friday" },
    { ...base, date: "2026-09-01" },
  ], gateOpts());
  assert.equal(kept.length, 0);
  assert.deepEqual(dropped.map((d) => d.reason.split(":")[0]), ["invalid", "invalid", "invalid", "outside the window"]);
});

test("gate: what this lane sent before, or a sibling lane surfaced, is not sent again", () => {
  fs.writeFileSync(process.env.VENUE_SURFACED_FILE, JSON.stringify({ entries: [{ lane: "another-lane", title: "Singer Beta", performers: ["Singer Beta"], date: "2026-11-07" }] }));
  const seen = [{ key: L.showKey(base) }];
  const known = L.knownChecker({ seen, surfacedFile: process.env.VENUE_SURFACED_FILE });
  const { kept, dropped } = L.gateCandidates([
    base,
    { ...base, performer: "Singer Beta", date: "2026-11-07", url: "https://x/8" },
    { ...base, performer: "Singer Beta", date: "2026-11-08", url: "https://x/9" },
  ], gateOpts({ known }));
  assert.deepEqual(kept.map((k) => k.date), ["2026-11-08"]);
  assert.deepEqual(dropped.map((d) => d.reason), ["already surfaced", "already surfaced"]);
});

test("one item per performer: several dates (and spellings of the same name) become one entry", () => {
  const { kept } = L.gateCandidates([
    { ...base, date: "2026-11-12", url: "https://x/10" },
    { ...base, performer: "BAND ALPHA", date: "2026-11-05", url: "https://x/11" },
    { ...base, date: "2026-11-05", url: "https://x/dup" }, // same show twice in one run
    { ...base, performer: "Singer Zeta", date: "2026-11-03", url: "https://x/12" },
  ], gateOpts());
  const groups = L.groupByPerformer(kept);
  assert.deepEqual(groups.map((g) => [g.performer, g.shows.map((s) => s.date)]),
    [["Singer Zeta", ["2026-11-03"]], ["Band Alpha", ["2026-11-05", "2026-11-12"]]]);
});

test("channel: chat only for something in today's city (or worth the trip) in daytime; else email", () => {
  const g = (metro, wtt = false) => [{ worth_the_trip: wtt, shows: [{ metro }] }];
  const day = Date.parse("2026-10-22T09:00:00Z"); // 12:00 in Far City
  const night = Date.parse("2026-10-22T01:00:00Z"); // 04:00 in Far City
  assert.equal(L.channelFor(g("far_city"), { todayMetros: ["far_city"], nowMs: day, todayTz: "Europe/Athens" }), "chat");
  assert.equal(L.channelFor(g("home_city"), { todayMetros: ["far_city"], nowMs: day, todayTz: "Europe/Athens" }), "email");
  assert.equal(L.channelFor(g("other_town", true), { todayMetros: ["far_city"], nowMs: day, todayTz: "Europe/Athens" }), "chat");
  assert.equal(L.channelFor(g("far_city"), { todayMetros: ["far_city"], nowMs: night, todayTz: "Europe/Athens" }), "email");
  assert.equal(L.channelFor([], {}), "none");
});

test("record: delivered shows land in the ledger once", () => {
  const { kept } = L.gateCandidates([base, { ...base, date: "2026-11-06", url: "https://x/13" }], gateOpts());
  const groups = L.groupByPerformer(kept);
  assert.equal(L.recordSurfaced(groups, { nowMs: NOW }), 2);
  assert.equal(L.recordSurfaced(groups, { nowMs: NOW }), 2);
  const known = L.knownChecker({ surfacedFile: path.join(tmp, "none.json") });
  assert.equal(known(base), true);
});

test("off without languages: the gate keeps nothing", async () => {
  const { spawnSync } = await import("node:child_process");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "language-events-off-"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const L = await import(${JSON.stringify(new URL("../lib/language-events.mjs", import.meta.url).href)});
     const { kept, dropped } = L.gateCandidates([${JSON.stringify(base)}], { today: "2026-10-22", inCity: () => true, isHeadliner: () => false, clash: () => ({ conflict: false }) });
     console.log(JSON.stringify([kept.length, dropped[0].reason]));`], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: empty } });
  assert.equal(r.status, 0, r.stderr);
  const [n, reason] = JSON.parse(r.stdout.trim());
  assert.equal(n, 0);
  assert.match(reason, /no languages configured/);
});
