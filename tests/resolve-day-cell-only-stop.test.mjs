// resolve-day-cell-only-stop.test.mjs — a stop placed only by a cell-tower
// reading, and a walking fix that ends a stop.
//
// The day's shape: lunch at a café, a short stop at a shop on the way home, the
// rented flat from 12:41. A 20-minute "stop" between lunch and the flat had as
// its only position a cell-tower row (accuracy 1414 m, ~250 m from where the
// user was); every precise fix in that window sat at the flat. It is dropped,
// not asked about. The same window also stretched the shop (12:07-12:12) to the
// flat's next fix: a walking fix halfway home, nearer the flat, counted as
// "still at the shop" because the two sit under 130 m apart. A moving fix
// nearer the next stop ends the shop.
//
// Geometry is a real day's (metres and bearings kept), placed around the fake
// origin of tests/fixtures/fake-geo.mjs.
//
// Run: node --test tests/resolve-day-cell-only-stop.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { dropUnrestedStops, extendThroughSilence } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const T = (hms) => Date.parse(`2099-03-08T${hms}Z`);
const CAFE = at(156.04, 1.84);
const FLAT = at(0, 0);
const CELL = at(-225.46, -119.77);

const PINGS = [
  { ts: T("11:48:06"), ...at(196.36, 3.98), acc: 4.3, activity: "stationary" },
  { ts: T("12:13:19"), ...at(21.36, -3.99), acc: 10.2, activity: "walking" },
  { ts: T("12:21:00"), ...CELL, acc: 1414, activity: "stationary" },
  { ts: T("12:21:00"), ...CELL, acc: 1414, activity: "stationary" },
  { ts: T("12:41:46"), ...at(-56.66, 0.81), acc: 15.8, activity: "unknown" },
  { ts: T("12:41:46"), ...at(-56.66, 0.81), acc: 15.8, activity: "unknown" },
];

const cafe = { id: "s-2", start_ts_ms: T("11:29:40"), end_ts_ms: T("12:13:19"), ...CAFE, photos: [],
  place: { name: "Café Aurora", source: "user_confirmed", confidence: 1 } };
const flat = { id: "s-4", start_ts_ms: T("12:41:46"), end_ts_ms: T("14:20:00"), ...FLAT, photos: [],
  place: { name: "The rental flat", source: "confirmed_stop", confidence: 0.9 } };
const cellStop = () => ({ id: "s-3", start: "14:21", end: "14:41", start_ts_ms: T("12:21:00"),
  end_ts_ms: T("12:41:46"), duration_min: 21, ...CELL, photos: [],
  place: { name: null, source: "unknown", confidence: 0 } });

test("a stop placed only by a cell-tower reading is dropped, not asked about", () => {
  const out = dropUnrestedStops([{ ...cafe }, cellStop(), { ...flat }], PINGS);
  assert.deepEqual(out.stops.map(s => s.id), ["s-2", "s-4"]);
  assert.match(out.dropped[0].reason, /cell-tower/);
});

test("the same window is still kept when a precise fix sits at its position", () => {
  const pings = [...PINGS, { ts: T("12:30:00"), ...at(-225.46, -86.41), acc: 12, activity: "walking" }];
  const out = dropUnrestedStops([{ ...cafe }, cellStop(), { ...flat }], pings);
  assert.ok(out.stops.some(s => s.id === "s-3" && s.unrested));
});

const SHOP = at(113.94, -4.45);
const shop = () => ({ id: "s-a3", start_ts_ms: T("12:07:00"), end_ts_ms: T("12:12:00"), ...SHOP, photos: [],
  place: { name: "Loja Exemplo", source: "user_confirmed", confidence: 1 } });
const home = () => ({ ...flat, start_ts_ms: T("12:41:46") });
// The user's two photos at the shop are camera fixes in the ping stream.
const WALK_HOME = [
  ...PINGS.filter(p => p.acc < 100),
  { ts: T("12:07:43"), ...at(114.25, -1.72), acc: 5, kind: "photo", activity: null },
  { ts: T("12:08:53"), ...at(113.47, -7.28), acc: 5, kind: "photo", activity: null },
].sort((a, b) => a.ts - b.ts);

test("a walking fix nearer the next stop ends the shop, and the flat starts there", () => {
  const stops = [shop(), home()];
  extendThroughSilence(stops, WALK_HOME);
  assert.equal(stops[0].end_ts_ms, T("12:12:00"), "the shop is not stretched to the flat's next fix");
  assert.equal(stops[1].start_ts_ms, T("12:13:19"), "the flat starts at the walking fix beside it");
});

test("kill switch: JORI_SILENCE_MOVING_NEIGHBOUR=0 restores the old stretch", () => {
  process.env.JORI_SILENCE_MOVING_NEIGHBOUR = "0";
  try {
    const stops = [shop(), home()];
    extendThroughSilence(stops, WALK_HOME);
    assert.ok(stops[0].end_ts_ms > T("12:40:00"));
  } finally { delete process.env.JORI_SILENCE_MOVING_NEIGHBOUR; }
});

test("a stationary fix there still says the user stayed (only a moving fix is the walk)", () => {
  const still = WALK_HOME.map(p => p.ts === T("12:13:19") ? { ...p, activity: "stationary" } : p);
  const stops = [shop(), home()];
  extendThroughSilence(stops, still);
  assert.ok(stops[0].end_ts_ms > T("12:40:00"));
});

// ── a crawl in a traffic jam is not a stop ───────────────────────────────────
//
// A long window with no rest was kept as an unknown stop so the user could be
// asked about it. On a jammed motorway the car crawls for half an hour and never
// rests, and the phone's motion reading says driving the whole time: it printed
// as a 34-minute stop with two nearby gardens offered as what it might have been.

const crawlStop = () => ({ id: "s-c", start: "18:51", end: "19:16", start_ts_ms: T("16:51:00"),
  end_ts_ms: T("17:16:00"), duration_min: 25, ...at(0, 2000), photos: [],
  place: { name: "Example Highway", source: "spine_dwell", confidence: 0.85 } });
// A fix every five minutes, 180 m further on each time: no rest anywhere in it.
const crawl = (activity) => [0, 1, 2, 3, 4].map(i => ({ ts: T("16:52:00") + i * 5 * 60_000,
  ...at(0, 1700 + i * 180), acc: 5, activity: typeof activity === "function" ? activity(i) : activity }));

test("a window the phone read as driving the whole time is dropped as traffic, not kept to ask about", () => {
  const out = dropUnrestedStops([crawlStop()], crawl("driving"));
  assert.deepEqual(out.stops, []);
  assert.match(out.dropped[0].reason, /vehicle/);
  assert.ok(!out.dropped[0].kept_as_unknown);
});

test("the same window walked is still kept to ask about", () => {
  const out = dropUnrestedStops([crawlStop()], crawl("walking"));
  assert.ok(out.stops.some(s => s.id === "s-c" && s.unrested));
  assert.ok(out.dropped[0].kept_as_unknown);
});

test("one reading of driving among walking fixes is not a ride", () => {
  const out = dropUnrestedStops([crawlStop()], crawl(i => (i === 0 ? "driving" : "walking")));
  assert.ok(out.stops.some(s => s.id === "s-c"));
});

test("kill switch: JORI_UNRESTED_IN_VEHICLE=0 keeps the driving window again", () => {
  process.env.JORI_UNRESTED_IN_VEHICLE = "0";
  try {
    const out = dropUnrestedStops([crawlStop()], crawl("driving"));
    assert.ok(out.stops.some(s => s.id === "s-c"));
  } finally { delete process.env.JORI_UNRESTED_IN_VEHICLE; }
});

// ...and the live question already queued about that crawl does not come back
// as the summary's follow-up once the crawl is no longer a stop.
test("a queued location question about a window the day passed through is not a follow-up", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pending-enrich-"));
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  const row = (id, a, d) => ({ visit_id: id, arrived_at: a, departed_at: d, latitude: 1, longitude: 1, candidates: [], asked: true });
  fs.writeFileSync(path.join(home, "data/location-pending-enrich.json"), JSON.stringify({ pending: [
    row("jam", "2099-03-08T16:51:59Z", "2099-03-08T17:16:52Z"),
    row("shop", "2099-03-08T19:00:00Z", "2099-03-08T19:20:00Z"),
  ] }));
  const passed = [{ start_ts_ms: T("16:51:00"), end_ts_ms: T("17:16:00"), reason: "in a vehicle the whole time — traffic, not a stop" }];
  const kept = [{ ...passed[0], kept_as_unknown: true }];
  const script = `const { loadUnaskedPendingEnrich } = require(${JSON.stringify(path.join(ROOT, "lib/resolve-day.js"))})._internal;
    const ids = (p) => loadUnaskedPendingEnrich("2099-03-08", [], false, p).map(u => u.id);
    console.log(JSON.stringify([ids(${JSON.stringify(passed)}), ids(${JSON.stringify(kept)}), ids([])]));`;
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, JORI_HOME: home }, encoding: "utf8" });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const [withPassed, withKept, without] = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(withPassed, ["pending-enrich-shop"]);
  assert.deepEqual(withKept, ["pending-enrich-jam", "pending-enrich-shop"], "a window kept to ask about still asks");
  assert.deepEqual(without, ["pending-enrich-jam", "pending-enrich-shop"]);
});
