// standout-stop-link.test.mjs — an in-store charge whose spelling no stop shares
// is linked by a model's reading: a charge spelled one way never met the stop
// the user had named another way, in another script. Synthetic names.
//
// Run: node --test tests/standout-stop-link.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const L = require(path.join(ROOT, "lib/standout-stop-link.js"));

const stops = [
  { id: "s-a1", start: "07:56", end: "08:48", place: { name: "Café Example" } },
  { id: "s-1", start: "08:49", end: "08:59", place: { name: "אבולוגו" } },
  { id: "s-walk", start: "10:00", end: "10:30", place: { name: "Walk" }, is_movement: true },
];
function data() {
  return { standouts: [
    { merchant: "Abologo", amount: 31.03, payment_channel: "in store", stop_id: null },
    { merchant: "Netflix", amount: 41.84, payment_channel: "online", stop_id: null },
    { merchant: "Hotel Example", amount: 90, payment_channel: "in store", stop_id: "s-x" },
  ], byStopId: { "s-x": [] } };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ssl-")), "cache.json");

test("only an in-store charge with no stop is asked about, against named stops", async () => {
  const asked = [];
  const d = data();
  const linked = await L.linkStandoutsToStops(d, stops, { cacheFile: tmp(), ask: async (text, ids) => {
    asked.push({ text, ids });
    return { stop_id: "s-1", model: "sonnet" };
  } });
  assert.equal(asked.length, 1);
  assert.ok(asked[0].text.includes('"Abologo"') && asked[0].text.includes("s-1: אבולוגו"), asked[0].text);
  assert.ok(!asked[0].text.includes("31"), "no amount leaves the machine");
  assert.deepEqual(asked[0].ids, ["s-a1", "s-1"], "a movement stop is not a business");
  assert.deepEqual(linked, [{ merchant: "Abologo", stop_id: "s-1", model: "sonnet" }]);
  assert.equal(d.standouts[0].stop_id, "s-1");
  assert.deepEqual(d.byStopId["s-1"].map((t) => t.merchant), ["Abologo"]);
  assert.equal(d.standouts[1].stop_id, null, "an online charge is never staged at a stop");
});

test("a null answer, an unknown id, a failed ladder or the kill switch leave the charge alone", async () => {
  for (const ask of [async () => ({ stop_id: null }), async () => ({ stop_id: "s-9" }), async () => null]) {
    const d = data();
    assert.deepEqual(await L.linkStandoutsToStops(d, stops, { cacheFile: tmp(), ask }), []);
    assert.equal(d.standouts[0].stop_id, null);
  }
  process.env.JORI_STANDOUT_LINK = "0";
  try {
    const d = data();
    await L.linkStandoutsToStops(d, stops, { cacheFile: tmp(), ask: async () => ({ stop_id: "s-1" }) });
    assert.equal(d.standouts[0].stop_id, null);
  } finally { delete process.env.JORI_STANDOUT_LINK; }
});

test("an answer is cached for the day, so a re-prep asks nothing new", async () => {
  const file = tmp();
  let calls = 0;
  const ask = async () => { calls++; return { stop_id: "s-1", model: "sonnet" }; };
  await L.linkStandoutsToStops(data(), stops, { cacheFile: file, ask });
  const d = data();
  await L.linkStandoutsToStops(d, stops, { cacheFile: file, ask });
  assert.equal(calls, 1);
  assert.equal(d.standouts[0].stop_id, "s-1");
});

test("the ladder climbs from Sonnet to Opus on a bad answer and stops on a fatal error", async () => {
  const seen = [];
  const res = await L.askLadder("q", ["s-1"], { judgeFn: async ({ model }) => {
    seen.push(model);
    return seen.length === 1 ? { stop_id: "nope" } : { stop_id: "s-1" };
  } });
  assert.equal(seen.length, 2);
  assert.equal(res.stop_id, "s-1");
  const fatal = await L.askLadder("q", ["s-1"], { judgeFn: async () => { throw Object.assign(new Error("Not logged in"), { fatal: true }); } });
  assert.equal(fatal, null);
});

// A place the user knows by a short name, which the bank prints in full: the
// model saw only the short name and read the two as different businesses. The
// businesses beside the user's photos at that stop now go with it.
test("the businesses beside the user's photos at a stop go with its name, nearest first", async () => {
  const photoStops = [
    { id: "s-l", start: "12:00", end: "13:00", place: { name: "Lulu" }, photos: [{ uuid: "p1" }, { uuid: "p2" }, { uuid: "p3" }] },
    { id: "s-h", start: "15:00", end: "18:00", place: { name: "Home" }, photos: [{ uuid: "p4" }] },
    { id: "s-n", start: "19:00", end: "20:00", place: { name: "Park" } },
  ];
  const rows = [
    { uuid: "p1", device_venue: { name: "Corner Deli", pois: [
      { name: "Corner Deli", distance_m: 9 }, { name: "Bakery Lulu of Main Street", distance_m: 17 }, { name: "Far Away Bar", distance_m: 60 },
    ] } },
    { uuid: "p2", device_venue: { pois: [{ name: "Bakery Lulu of Main Street", distance_m: 12 }, { name: "No Distance" }] } },
    { uuid: "p3", device_venue: null },
    { uuid: "p4", device_venue: { pois: [{ name: "Gas Station", distance_m: 400 }] } },
  ];
  const near = L.placesBesidePhotos(photoStops, rows);
  assert.deepEqual(near, { "s-l": ["Corner Deli", "Bakery Lulu of Main Street"] }, "within 25 m, deduped at the nearest reading; a stop with none is left out");

  const asked = [];
  const d = { standouts: [{ merchant: "Bakery Lulu Main", amount: 37.5, payment_channel: "in store", stop_id: null }], byStopId: {} };
  const file = tmp();
  const ask = async (text) => { asked.push(text); return { stop_id: "s-l", model: "sonnet" }; };
  await L.linkStandoutsToStops(d, photoStops, { cacheFile: file, near, ask });
  assert.ok(asked[0].includes("- s-l: Lulu (12:00-13:00); beside the user's photos: Corner Deli, Bakery Lulu of Main Street"), asked[0]);
  assert.ok(asked[0].includes("- s-n: Park (19:00-20:00)\n"), "a stop with no photos keeps the bare line");
  assert.ok(!asked[0].includes("37"), "no amount leaves the machine");
  assert.equal(d.standouts[0].stop_id, "s-l");

  // The places are part of what was asked, so a re-prep without them asks again.
  await L.linkStandoutsToStops({ standouts: [{ merchant: "Bakery Lulu Main", payment_channel: "in store", stop_id: null }] }, photoStops, { cacheFile: file, ask });
  assert.equal(asked.length, 2);
  await L.linkStandoutsToStops({ standouts: [{ merchant: "Bakery Lulu Main", payment_channel: "in store", stop_id: null }] }, photoStops, { cacheFile: file, near, ask });
  assert.equal(asked.length, 2, "the same question is answered from the cache");
  assert.deepEqual(L.placesBesidePhotos(photoStops, null), {});
});

// The bank's cleaned-up merchant name can drop the part of the name the stop
// shares; its statement line still has it.
test("the charge's statement line goes with its merchant name, without digits", async () => {
  assert.equal(L.statementLine({ transaction_id: "t1", merchant: "Sweet" }, { t1: "SWEET SHOP 4417 #0028" }), "SWEET SHOP #");
  assert.equal(L.statementLine({ transaction_id: "t1", merchant: "Sweet Shop" }, { t1: "SWEET  SHOP" }), null, "nothing new, nothing added");
  assert.equal(L.statementLine({ transaction_id: "t1", merchant: "Sweet" }, null), null);
  assert.equal(L.statementLine({ merchant: "Sweet" }, { t1: "SWEET SHOP" }), null, "no id, no line");

  const asked = [];
  const shopStops = [{ id: "s-s", start: "15:00", end: "15:20", place: { name: "Sweetshop" } }];
  const d = { standouts: [{ transaction_id: "t1", merchant: "Sweet", amount: 41.5, payment_channel: "in store", stop_id: null }], byStopId: {} };
  const file = tmp();
  const ask = async (text) => { asked.push(text); return { stop_id: "s-s", model: "sonnet" }; };
  await L.linkStandoutsToStops(d, shopStops, { cacheFile: file, statements: { t1: "SWEET SHOP 9912" }, ask });
  assert.ok(asked[0].startsWith('A card charge was made in person at a business the bank calls "Sweet" (its statement line reads "SWEET SHOP").'), asked[0]);
  assert.ok(!/\d{3}/.test(asked[0].split("\n")[0]), "no reference number or amount leaves the machine");
  assert.equal(d.standouts[0].stop_id, "s-s");
  await L.linkStandoutsToStops({ standouts: [{ transaction_id: "t1", merchant: "Sweet", payment_channel: "in store", stop_id: null }] }, shopStops, { cacheFile: file, ask });
  assert.equal(asked.length, 2, "without the line it is a different question");
});
