// address-match.test.mjs — a home is recognised by its street address, and a
// model, not a pattern, decides whether two addresses are the same house.
//
// Requirement: a geocoder's English rendering of a street ("12 Oak Alley")
// and the home's address as written in the wiki ("Rehov HaAlon 9", the same
// street transliterated from Hebrew) must be recognised as the same house, so
// the name match is transliteration/translation-aware — a model's call per
// Rule #0b, never a regex.
//
// The model is injected here (`ask`, `reverse`); what is under test is the
// geometry that picks the candidates, what the model is shown, that each answer
// is kept and reused, and that a failure names nothing.
//
// Run: node --test tests/address-match.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { addressCandidates, loadAddressHomes, ADDRESS_NEAR_M } = require(path.join(ROOT, "lib/named-locations.js"));
const { matchHomeByAddress } = await import(path.join(ROOT, "lib/address-match.mjs"));
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { nameStopsByAddress } = _internal;
const { at: fakeAt } = await import(path.join(ROOT, "tests/fixtures/fake-geo.mjs"));

// Synthetic homes (tests/fixtures/fake-geo.mjs): metres east/north of a fake
// origin, so the geometry is real and the places are not.
const FAMILY_AT = fakeAt(0, 0);
const FAMILY = { name: "Family home, Example Town", lat: FAMILY_AT.lat, lon: FAMILY_AT.lon,
                 address: "Rehov HaAlon 9, Example Town 10000, Israel", kind: "family" };
const RELATIVES = { name: "Relatives' house", address: "Example St 5, Other Town, Israel",
                    tz: "Asia/Jerusalem", kind: "family" };   // address-only
const HOME_AT = fakeAt(-1_000_000, 900_000);
const HOME = { name: "Home", lat: HOME_AT.lat, lon: HOME_AT.lon, address: "1 Example Ave, Big City" };
const HOMES = [HOME, FAMILY, RELATIVES];
// ~250 m north of the house: outside the 150 m spot match, inside ADDRESS_NEAR_M.
const OFF_DOOR = fakeAt(0, 250);
const HEB = "7, האלון, שכונת דוגמה, עיר דוגמה, מחוז המרכז, ישראל";

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "address-match-")), "verdicts.json");
}
function counting(answer) {
  const calls = [];
  const fn = async (state) => { calls.push(state); return typeof answer === "function" ? answer(state) : answer; };
  fn.calls = calls;
  return fn;
}

test("the candidates are picked by geometry: near a recorded spot, or address-only in the same timezone", () => {
  const near = addressCandidates(HOMES, OFF_DOOR.lat, OFF_DOOR.lon, "Asia/Jerusalem").map(c => c.entry.name);
  assert.deepEqual(near.sort(), ["Family home, Example Town", "Relatives' house"]);
  // 2 km away: a different neighbourhood, where "HaAlon" is another street.
  const farAt = fakeAt(0, 2000);
  const far = addressCandidates(HOMES, farAt.lat, farAt.lon, "Asia/Jerusalem").map(c => c.entry.name);
  assert.deepEqual(far, ["Relatives' house"]);
  // In another zone the address-only home is not a candidate at all.
  const nearHome = fakeAt(-1_000_000, 900_200);
  assert.deepEqual(addressCandidates(HOMES, nearHome.lat, nearHome.lon, "America/Chicago").map(c => c.entry.name),
                   ["Home"]);
  assert.equal(ADDRESS_NEAR_M, 500);
});

test("the file's homes all load for address matching", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "address-homes-")), "named-locations.json");
  fs.writeFileSync(file, JSON.stringify({ entries: HOMES }));
  const names = loadAddressHomes(file).map(e => e.name);
  assert.ok(names.includes("Family home, Example Town"));
  assert.ok(names.includes("Home"));
});

test("'12 Oak Alley' is matched to 'Rehov HaAlon 9' when the model says so, and the answer is kept", async () => {
  const file = tmpFile();
  const ask = counting(async (state) => ({ home: state.homes.find(h => h.address === FAMILY.address).id, reason: "same alley" }));
  const opts = { entries: [FAMILY], tz: "Asia/Jerusalem", file, ask, reverse: async () => HEB };
  const hit = await matchHomeByAddress({ ...OFF_DOOR, labels: ["12 Oak Alley"] }, opts);
  assert.equal(hit.entry.name, "Family home, Example Town");
  assert.equal(hit.cached, false);
  // The model sees the geocoders' words and the home's address, nothing else.
  assert.deepEqual(ask.calls[0], { stop_addresses: ["12 Oak Alley", HEB],
                                   homes: [{ id: "h0", address: FAMILY.address }] });
  const again = await matchHomeByAddress({ ...OFF_DOOR, labels: ["12 Oak Alley"] }, opts);
  assert.equal(again.entry.name, "Family home, Example Town");
  assert.equal(again.cached, true);
  assert.equal(ask.calls.length, 1, "one question, asked once");
});

test("a 'none' answer names nothing and is not asked again", async () => {
  const file = tmpFile();
  const ask = counting({ home: "none", reason: "different street" });
  const opts = { entries: [FAMILY], tz: "Asia/Jerusalem", file, ask, reverse: async () => null };
  assert.equal(await matchHomeByAddress({ ...OFF_DOOR, labels: ["90 Example Street"] }, opts), null);
  assert.equal(await matchHomeByAddress({ ...OFF_DOOR, labels: ["90 Example Street"] }, opts), null);
  assert.equal(ask.calls.length, 1);
});

test("a failed model call names nothing, keeps nothing, and is asked again next time", async () => {
  const file = tmpFile();
  let n = 0;
  const ask = async () => { n += 1; throw new Error("Not logged in"); };
  const opts = { entries: [FAMILY], tz: "Asia/Jerusalem", file, ask, reverse: async () => null };
  assert.equal(await matchHomeByAddress({ ...OFF_DOOR, labels: ["12 Oak Alley"] }, opts), null);
  assert.equal(await matchHomeByAddress({ ...OFF_DOOR, labels: ["12 Oak Alley"] }, opts), null);
  assert.equal(n, 2);
});

test("an answer that is not one of the offered ids is not trusted or kept", async () => {
  const file = tmpFile();
  const ask = counting({ home: "h7" });
  const opts = { entries: [FAMILY], tz: "Asia/Jerusalem", file, ask, reverse: async () => null };
  assert.equal(await matchHomeByAddress({ ...OFF_DOOR, labels: ["12 Oak Alley"] }, opts), null);
  assert.equal(await matchHomeByAddress({ ...OFF_DOOR, labels: ["12 Oak Alley"] }, opts), null);
  assert.equal(ask.calls.length, 2);
});

test("an address-only home needs the stop's full address, town included", async () => {
  const ask = counting({ home: "h0" });
  const far = fakeAt(30_000, 30_000);   // nowhere near a home with coordinates
  const none = await matchHomeByAddress({ ...far, labels: ["5 Example Street"] },
    { entries: [RELATIVES], tz: "Asia/Jerusalem", file: tmpFile(), ask, reverse: async () => null });
  assert.equal(none, null);
  assert.equal(ask.calls.length, 0, "no town for the stop, so no question");
  const hit = await matchHomeByAddress({ ...far, labels: ["5 Example Street"] },
    { entries: [RELATIVES], tz: "Asia/Jerusalem", file: tmpFile(), ask, reverse: async () => "5, Example St, Other Town, Israel" });
  assert.equal(hit.entry.name, "Relatives' house");
  assert.equal(hit.distance_m, null);
});

test("no candidate home nearby: no network, no model", async () => {
  const ask = counting({ home: "h0" });
  let reversed = 0;
  const hit = await matchHomeByAddress({ lat: 48.85, lon: 2.35, labels: ["1 Rue de Rivoli"] },
    { entries: HOMES, tz: "Europe/Paris", file: tmpFile(), ask, reverse: async () => { reversed += 1; return "x"; } });
  assert.equal(hit, null);
  assert.equal(ask.calls.length + reversed, 0);
});

test("cached-only reads never call the model", async () => {
  const ask = counting({ home: "h0" });
  const hit = await matchHomeByAddress({ ...OFF_DOOR, labels: ["12 Oak Alley"] },
    { entries: [FAMILY], tz: "Asia/Jerusalem", file: tmpFile(), ask, reverse: async () => null, allowAsk: false });
  assert.equal(hit, null);
  assert.equal(ask.calls.length, 0);
});

// ---- resolve-day: which stops the address pass may rename -------------------

function stop(id, place, extra = {}) {
  return { id, start: "17:22", end: "18:34", lat: OFF_DOOR.lat, lon: OFF_DOOR.lon, place, ...extra };
}
const homeMatch = async (st) => ({ entry: FAMILY, distance_m: 250, cached: true, stop_addresses: st.labels });

test("resolve-day names a stop still carrying a geocoder guess, from its guessed label", async () => {
  const s = stop("s-1", { name: null, source: "unknown", address: null, confidence: 0 },
                 { guessed_name: "12 Oak Alley", unnamed: true });
  let seen = null;
  const named = await nameStopsByAddress([s], { homes: [FAMILY], tzFor: () => "Asia/Jerusalem",
    match: async (st, o) => { seen = st; return homeMatch(st, o); } });
  assert.deepEqual(seen.labels, ["12 Oak Alley"]);
  assert.equal(s.place.name, "Family home, Example Town");
  assert.equal(s.place.source, "named_location");
  assert.equal(s.place.matched_by, "address");
  assert.equal(s.unnamed, false);
  assert.deepEqual(named.map(n => [n.name, n.was]), [["Family home, Example Town", "12 Oak Alley"]]);
});

test("resolve-day never renames the user's answer, a lodging, a place they confirmed or a 'not a stop'", async () => {
  const keep = [
    stop("s-a", { name: "Notary", source: "user_confirmed", confidence: 1 }),
    stop("s-b", { name: "The rented flat", source: "accommodation", confidence: 0.95 }),
    stop("s-c", { name: "Boutique cafe", source: "confirmed_stop", confidence: 0.95 }),
    stop("s-d", { name: "Notary", source: "spine_dwell", confidence: 1 }, { spine_tier: "user-confirmed" }),
    stop("s-e", { name: "12 Oak Alley", source: "reverse_geocode" }, { user_non_stop: true }),
  ];
  let calls = 0;
  const named = await nameStopsByAddress(keep, { homes: [FAMILY], tzFor: () => "Asia/Jerusalem",
    match: async (st, o) => { calls += 1; return homeMatch(st, o); } });
  assert.equal(named.length, 0);
  assert.equal(calls, 0);
  assert.deepEqual(keep.map(s => s.place.name), ["Notary", "The rented flat", "Boutique cafe", "Notary", "12 Oak Alley"]);
});

test("resolve-day caps fresh model calls per run and keeps reading remembered answers", async () => {
  const stops = Array.from({ length: 9 }, (_, i) =>
    stop(`s-${i}`, { name: `${i + 1} Oak Alley`, source: "reverse_geocode", confidence: 0.4 }));
  const allow = [];
  await nameStopsByAddress(stops, { homes: [FAMILY], tzFor: () => "Asia/Jerusalem",
    match: async (st, o) => { allow.push(o.allowAsk); if (o.allowAsk) o.onAsk(); return null; } });
  assert.deepEqual(allow, [true, true, true, true, true, true, false, false, false]);
});

test("resolve-day skips the pass entirely when no home is in range", async () => {
  const s = stop("s-x", { name: "1 Rue de Rivoli", source: "reverse_geocode" }, { lat: 48.85, lon: 2.35 });
  let calls = 0;
  await nameStopsByAddress([s], { homes: HOMES, tzFor: () => "Europe/Paris", match: async () => { calls += 1; return null; } });
  assert.equal(calls, 0);
  assert.equal(s.place.name, "1 Rue de Rivoli");
});
