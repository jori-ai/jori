/**
 * An open-ended stay (depart_at NULL) must not claim all of time.
 *
 * Regression: one `flights` row — the second home city, arrive at the end of
 * October, depart NULL — made `travel in-city <first city>` answer AWAY for
 * every date for years, so every event lane's geo-gate suppressed every
 * first-city recommendation indefinitely.
 *
 * The metros, home bases and area come from a synthetic
 * agent/local/config/travel.json written to a temp dir (JORI_LOCAL_DIR), so
 * the test is the same on a fresh install and on a configured one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "presence-test-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "travel.json"), JSON.stringify({
  metros: [
    { key: "boston", aliases: ["boston", "cambridge"], airports: ["BOS"] },
    { key: "seattle", aliases: ["seattle", "bellevue"], airports: ["SEA"] },
    { key: "vancouver", aliases: ["vancouver"], airports: ["YVR"] },
  ],
  home_metros: ["boston", "seattle"],
  areas: [{
    key: "seattle",
    stay_keys: ["bellevue"],
    regions: ["puget sound", "king county"],
    towns: ["redmond", "kirkland", "tacoma"],
    state: ["wa", "washington"],
    state_only_towns: ["vancouver"],
  }],
}));
process.env.JORI_LOCAL_DIR = LOCAL;
process.env.JORI_TZ = "Europe/London";
const P = createRequire(import.meta.url)("../lib/presence.js");

const NOW = Date.parse("2026-09-02T12:00:00Z");
const T = (s) => Date.parse(s);

// The shape of the live timeline that caused the bug.
const segments = [
  { id: "a", metro: "boston",  arrive_at: "2026-08-26T18:11:00Z", depart_at: "2026-09-30T18:55:00Z", source: "flights" },
  { id: "b", metro: "seattle", arrive_at: "2026-10-29T18:35:00Z", depart_at: null, source: "flights", place_label: "Bellevue" },
];
const at = (when) => P.resolvePresenceAt(T(when), segments, [], NOW);

// Present and near future still resolve — the user really is there.
assert.equal(at("2026-11-05T19:00:00Z").metro, "seattle", "a week in, the open stay is authoritative");
assert.equal(at("2026-11-20T19:00:00Z").metro, "seattle", "three weeks in, still authoritative");

// Beyond the horizon the timeline admits it does not know, so readers fail open.
for (const d of ["2026-12-10", "2026-12-25", "2027-01-07", "2030-01-01"]) {
  assert.equal(at(`${d}T19:00:00Z`).metro, null, `${d} must be unknown, not a confident guess`);
}

// A bounded stay is never subject to the horizon.
const bounded = [{ id: "c", metro: "boston", arrive_at: "2027-01-01T00:00:00Z", depart_at: "2027-02-01T00:00:00Z", source: "manual" }];
assert.equal(P.resolvePresenceAt(T("2027-01-07T19:00:00Z"), bounded, [], NOW).metro, "boston",
  "a stay with a real depart_at stays authoritative however far out it is");

// A later bounded stay still wins over an open stay inside the horizon.
const withOverride = [...segments, { id: "d", metro: "boston", arrive_at: "2026-11-01T00:00:00Z", depart_at: "2026-11-10T00:00:00Z", source: "manual" }];
assert.equal(P.resolvePresenceAt(T("2026-11-05T19:00:00Z"), withOverride, [], NOW).metro, "boston",
  "a manual correction still overrides the open stay");

// The past is never unknown.
assert.equal(at("2026-09-01T19:00:00Z").metro, "boston", "past dates resolve normally");

// The flights fallback is a SECOND source with the same flaw — on the first
// deploy of the DB horizon it re-answered every date the DB had just declined
// ("resolved <city> [flights]"), so the gate still read AWAY for years.
const flights = [
  { type: "flight", from: "BOS", to: "SEA", to_city: "Bellevue",
    depart: "2026-10-29T15:29:00Z", arrive: "2026-10-29T18:35:00Z" },
];
const noSegs = (when) => P.resolvePresenceAt(T(when), [], flights, NOW);
assert.equal(noSegs("2026-11-05T19:00:00Z").metro, "seattle", "flights fallback holds inside the horizon");
for (const d of ["2026-12-10", "2027-01-07", "2030-01-01"]) {
  assert.equal(noSegs(`${d}T19:00:00Z`).metro, null, `flights fallback must not answer ${d}`);
}

// Both sources together — the real live shape.
const both = (when) => P.resolvePresenceAt(T(when), segments, flights, NOW);
assert.equal(both("2027-01-07T19:00:00Z").metro, null,
  "with DB + flights both present, a January date must still be unknown");

console.log("presence open-stay horizon: all assertions passed");

// ── Schrodinger stays: the user is in one of these metros, we don't know which ──
// A stretch of going back and forth between the two home cities, where the
// user should be assumed to be in both.
assert.equal(P.normalizeMetro("seattle|boston"), "boston|seattle", "candidates are canonicalized + sorted");
assert.deepEqual(P.ambiguousCandidates("boston|seattle"), ["boston", "seattle"]);
assert.equal(P.ambiguousCandidates("boston"), null, "a single metro is not ambiguous");

// A comma is address punctuation, never a candidate separator — treating it as one
// turned "<City>, <ST>" into a bogus ambiguous metro.
assert.equal(P.normalizeMetro("Boston, MA"), "boston");
assert.equal(P.normalizeMetro("Seattle, WA"), "seattle");

const schrodinger = [
  { id: "s", metro: "boston|seattle", arrive_at: "2026-12-01T17:00:00Z", depart_at: "2027-02-01T17:00:00Z",
    source: "manual", place_label: "Boston/Seattle (tentative)" },
];
const sres = P.resolvePresenceAt(T("2027-01-07T19:00:00Z"), schrodinger, [], NOW);
assert.equal(sres.ambiguous, true);
assert.deepEqual(sres.candidates, ["boston", "seattle"]);
assert.equal(sres.metro, null, "metro stays null so existing readers keep failing open unchanged");

console.log("schrodinger stays: all assertions passed");

// ── An area in the in-city gate ──────────────────────────────────────────────
// `travel in-city "<region>" <date>` read AWAY while a town of the region and
// the metro itself read IN. The area is a same-area relation used only there:
// normalizeMetro is unchanged, and the stay side matches by its stored key.
{
  const NOW_RG = Date.parse("2026-10-27T12:00:00Z");
  const stay = (metro) => P.resolvePresenceAt(P.parseWhen("2026-11-20"),
    [{ id: "m", metro, arrive_at: "2026-11-16T00:11:00Z", depart_at: null, source: "manual" }], [], NOW_RG);
  const verdict = (place, metro = "seattle") => {
    const t = P.inCityTarget(place);
    return P.inCityVerdict(t.key, stay(metro), { accept: t.accept }).verdict;
  };
  for (const place of ["Puget Sound", "puget sound, WA", "King County, Washington, USA", "Bellevue",
    "Seattle", "Seattle, WA 98101", "Redmond, WA", "Vancouver, WA", "Vancouver, WA 98660",
    "Example Arena, Vancouver, WA", "Example Concert Hall, Bellevue, WA", "Tacoma"]) {
    assert.equal(verdict(place), "IN", `${place} is the area`);
  }
  for (const place of ["University of Puget Sound", "University of Puget Sound, Spokane, WA", "Spokane", "Spokane, WA",
    "Yakima, Puget Sound", "Wenatchee, Puget Sound", "Olympia, Puget Sound", "Puget Sound, Yakima",
    "Everett, Aruba", "Everett, NSW, Australia", "Redmond, Aruba", "Vancouver", "Vancouver, BC", "Cambridge"]) {
    assert.equal(verdict(place), "AWAY", `${place} is not the area`);
  }
  assert.equal(P.inCityTarget("Vancouver").key, "vancouver");
  assert.equal(P.normalizeMetro("Puget Sound"), "puget_sound", "normalizeMetro is untouched");
  // Symmetric: a stay stored under an area key matches a listing anywhere in the area.
  for (const stored of ["redmond", "puget_sound", "king_county"]) {
    assert.equal(verdict("Seattle", stored), "IN", `a stay stored as ${stored}`);
    assert.equal(verdict(stored.replace(/_/g, " "), stored), "IN", `${stored} listing, ${stored} stay`);
  }
  for (const stored of ["everett", "north_everett"]) {   // outside the area: exact match, as before
    assert.equal(verdict(stored.replace(/_/g, " "), stored), "IN", `${stored} listing, ${stored} stay`);
    assert.equal(verdict("Seattle", stored), "AWAY");
  }
  // The live timeline's shape: the first city to Nov 15, then an open stay in the area.
  const segs = [
    { id: "n", metro: "boston", arrive_at: "2026-11-01T09:55:00Z", depart_at: "2026-11-15T20:59:00Z", source: "flights" },
    { id: "m", metro: "seattle", arrive_at: "2026-11-16T00:11:00Z", depart_at: null, source: "flights", place_label: "Bellevue" },
  ];
  const on = (place, day) => { const t = P.inCityTarget(place);
    return P.inCityVerdict(t.key, P.resolvePresenceAt(P.parseWhen(day), segs, [], NOW_RG), { accept: t.accept }).verdict; };
  assert.equal(on("Puget Sound", "2026-11-20"), "IN");
  assert.equal(on("Puget Sound", "2026-11-05"), "AWAY", "while the user is in the first city");
  assert.equal(on("Cambridge", "2026-11-05"), "IN");
  const amb = P.resolvePresenceAt(P.parseWhen("2027-01-07"),
    [{ id: "s", metro: "boston|seattle", arrive_at: "2026-12-01T17:00:00Z", depart_at: "2027-02-01T17:00:00Z", source: "manual" }], [], NOW_RG);
  const t = P.inCityTarget("Puget Sound");
  assert.equal(P.inCityVerdict(t.key, amb, { accept: t.accept }).verdict, "IN(ambiguous)");
}

console.log("area in the in-city gate: all assertions passed");

// ── Home-zone time parsing (instance().tz) ──────────────────────────────────
assert.equal(new Date(P.parseWhen("2026-07-01")).toISOString(), "2026-07-01T18:00:00.000Z", "19:00 summer time in the home zone");
assert.equal(new Date(P.parseWhen("2026-12-01")).toISOString(), "2026-12-01T19:00:00.000Z", "19:00 winter time in the home zone");
assert.equal(P.getHomeOffset("2026-07-01"), "+01:00");
assert.equal(P.homeDateOf(new Date("2026-07-01T23:30:00Z")), "2026-07-02");

// ── No config: a fresh install still resolves (no metros, no areas) ─────────
{
  const { execFileSync } = await import("node:child_process");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "presence-empty-"));
  const out = execFileSync(process.execPath, ["-e", `
    const P = require(${JSON.stringify(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../lib/presence.js"))});
    console.log(JSON.stringify([P.METRO_DEFS.length, P.HOME_METROS.size, P.AREAS.length, P.normalizeMetro("Seattle, WA"), P.metroFromAirport("SEA"), P.inCityTarget("Puget Sound").key]));
  `], { env: { ...process.env, JORI_LOCAL_DIR: empty }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), [0, 0, 0, "seattle", null, "puget_sound"]);
  fs.rmSync(empty, { recursive: true, force: true });
}

fs.rmSync(LOCAL, { recursive: true, force: true });
console.log("presence home zone + fresh install: all assertions passed");
