// resolve-day-photo-edge-radius.test.mjs — a photo taken down the street is not "still there".
//
// The shape: dessert at a café until about 20:14; the next photo, at 20:15:54,
// was taken on the walk home, ~102 m from the café; a fix at 20:17:41 and the
// flat from 20:22. Photos are folded into the ping stream, and the silence pass
// and the travel trim used to count any ping within 150 m as "at the place", so
// that photo held the café open to 20:15 and the summary printed a 2-minute walk
// for a 350 m one. A camera fix is precise: it is at a place only within
// PHOTO_AT_STOP_M, the radius the photo passes already use.
//
// Geometry is a real evening's (metres and bearings kept), placed around the
// fake origin of tests/fixtures/fake-geo.mjs.
//
// Run: node --test tests/resolve-day-photo-edge-radius.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { extendThroughSilence, leaveRoomToTravel, photoPings } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const D = "2099-03-08";
const T = (hms) => Date.parse(`${D}T${hms}+02:00`);
const hm = (ms) => new Date(ms + 2 * 3600_000).toISOString().slice(11, 16);
const CAFE = at(183.19, 166.54);
const FLAT = at(0, 0);
const photo = (hms, e, n, uuid) => { const p = at(e, n); return { taken_at: `${D}T${hms}+02:00`, latitude: p.lat, longitude: p.lon, uuid }; };

const stop = (id, s, e, where) => ({ id, start: s, end: e, start_ts_ms: T(`${s}:00`), end_ts_ms: T(`${e}:00`),
  duration_min: (T(`${e}:00`) - T(`${s}:00`)) / 60000, ...where, place: { name: id, source: "user_confirmed" },
  photos: [], companions: [] });

const pings = () => [
  ...photoPings([
    photo("19:55:40", 193.76, 165.57, "p1"),
    // on the walk home, ~102 m from the café
    photo("20:15:54", 128.74, 78.84, "p2"),
  ]),
  { ts: T("20:17:41"), ...at(111.77, 18.79), acc: 13 },
  { ts: T("20:22:55"), ...at(-4.15, 13.23), acc: 20 },
].sort((a, b) => a.ts - b.ts);

function day(env = {}) {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  try {
    const stops = [stop("cafe", "19:51", "20:14", CAFE), stop("flat", "20:22", "23:59", FLAT)];
    extendThroughSilence(stops, pings());
    leaveRoomToTravel(stops, pings());
    return stops;
  } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("a photo 100 m down the street does not keep the stop open", () => {
  const [cafe, flat] = day();
  assert.equal(hm(cafe.end_ts_ms), "20:14");
  // the walk home keeps at least the time it takes to walk it
  assert.ok(flat.start_ts_ms - cafe.end_ts_ms >= 3 * 60_000, `${hm(cafe.end_ts_ms)} → ${hm(flat.start_ts_ms)}`);
});

test("a photo at the place still keeps it open", () => {
  const stops = [stop("cafe", "19:51", "20:10", CAFE), stop("flat", "20:22", "23:59", FLAT)];
  const atTable = photoPings([photo("20:12:30", 185.28, 166.68, "p3")]);
  extendThroughSilence(stops, [...pings(), ...atTable].sort((a, b) => a.ts - b.ts));
  assert.equal(hm(stops[0].end_ts_ms), "20:12");
});

test("the switch gives photos the 150 m again", () => {
  const [cafe] = day({ JORI_PHOTO_EDGE_RADIUS: "0" });
  assert.equal(hm(cafe.end_ts_ms), "20:15");
});
