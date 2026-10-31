// resolve-day-shrunk-companions.test.mjs — a stop cut down after it took its
// visit rows' people keeps only the ones whose rows it still overlaps.
//
// The incident (2026-10-23, Portside): the Brenna bakery stop took Olin and Paige
// from the flat's 12:01 row while it was still the 00:05-13:20 cluster; the wake
// hold and the spine cut it to 08:49-08:59 and it kept them, though he went "to
// get bourekas for Olin and Yuri" and Olin's phone was elsewhere. A person with
// him at the stops on both sides (Paige: the coffee before, the flat after) stays.
//
// Run: node --test tests/resolve-day-shrunk-companions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at as fakeAt } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { pruneShrunkCompanions, pieceCompanions } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const iso = (s) => Date.parse(s);
const FLAT = { ...LL(0.0, 0.0) };
const BAKERY = { ...LL(115.43, 170.93) };
// The flat's 12:01-12:19 row carrying Olin and Paige.
const rows = [{ arrived_at: "2026-10-23T09:01:56Z", departed_at: "2026-10-23T09:19:55Z",
                latitude: FLAT.lat, longitude: FLAT.lon, companions: ["Olin", "Paige"] }];
const CLUSTER = { start_ts_ms: iso("2026-10-22T21:05:00Z"), end_ts_ms: iso("2026-10-23T10:20:00Z"), ...FLAT };

function bakery(over = {}) {
  return { id: "s-1", start: "08:49", end: "08:59", start_ts_ms: iso("2026-10-23T05:49:00Z"), end_ts_ms: iso("2026-10-23T05:59:00Z"),
           ...BAKERY, companions: ["Olin", "Paige"], companion_merge_window: { ...CLUSTER }, ...over };
}

test("a stop cut down from the cluster drops the people only the cluster's rows gave it", () => {
  const stops = [bakery()];
  const out = pruneShrunkCompanions(stops, rows, []);
  assert.deepEqual(stops[0].companions, []);
  assert.deepEqual(out, [{ id: "s-1", dropped: ["Olin", "Paige"], window: "08:49–08:59" }]);
  assert.equal("companion_merge_window" in stops[0], false, "the bookkeeping field never reaches the JSON");
});

test("a name his words put on the stop stays", () => {
  const stops = [bakery()];
  pruneShrunkCompanions(stops, rows, [{ id: "s-1", companions: ["Paige"] }]);
  assert.deepEqual(stops[0].companions, ["Paige"]);
});

test("a piece whose own window still overlaps the row keeps its people", () => {
  const flat = { id: "s-2", start: "09:01", end: "13:47", start_ts_ms: iso("2026-10-23T06:01:00Z"),
                 end_ts_ms: iso("2026-10-23T10:47:00Z"), ...FLAT, companions: ["Olin", "Paige"],
                 companion_merge_window: { ...CLUSTER } };
  pruneShrunkCompanions([flat], rows, []);
  assert.deepEqual(flat.companions, ["Olin", "Paige"]);
});

test("a stop that did not shrink, a name no row gave, and the kill switch are left alone", () => {
  const whole = bakery({ start_ts_ms: CLUSTER.start_ts_ms, end_ts_ms: CLUSTER.end_ts_ms });
  pruneShrunkCompanions([whole], rows, []);
  assert.deepEqual(whole.companions, ["Olin", "Paige"]);

  const tagged = bakery({ companions: ["Olin", "Rover"] });
  pruneShrunkCompanions([tagged], rows, []);
  assert.deepEqual(tagged.companions, ["Rover"], "Rover came from no visit row: kept");

  process.env.JORI_PIECE_COMPANIONS = "0";
  try {
    const off = bakery();
    pruneShrunkCompanions([off], rows, []);
    assert.deepEqual(off.companions, ["Olin", "Paige"]);
  } finally {
    delete process.env.JORI_PIECE_COMPANIONS;
  }
});

test("a person with him at the stops on both sides stays; one on a single side goes", () => {
  const cafe = { id: "s-a1", start: "07:56", end: "08:48", start_ts_ms: iso("2026-10-23T04:56:00Z"),
                 end_ts_ms: iso("2026-10-23T05:48:00Z"), ...LL(44.58, -29.02), companions: ["Paige", "Rover"] };
  const flat = { id: "s-p2", start: "09:01", end: "13:47", start_ts_ms: iso("2026-10-23T06:01:00Z"),
                 end_ts_ms: iso("2026-10-23T10:47:00Z"), ...FLAT, companions: ["Olin", "Paige"] };
  const stops = [cafe, bakery(), flat];
  const out = pruneShrunkCompanions(stops, rows, []);
  assert.deepEqual(stops[1].companions, ["Paige"]);
  assert.deepEqual(out, [{ id: "s-1", dropped: ["Olin"], window: "08:49\u201308:59" }]);
  assert.deepEqual(cafe.companions, ["Paige", "Rover"], "neighbours are never touched");
});

test("both sides must be close: a long gap on either side is no bracket", () => {
  const before = { id: "s-0", start: "06:00", end: "06:30", start_ts_ms: iso("2026-10-23T03:00:00Z"),
                   end_ts_ms: iso("2026-10-23T03:30:00Z"), ...FLAT, companions: ["Paige"] };
  const after = { id: "s-2", start: "09:01", end: "13:47", start_ts_ms: iso("2026-10-23T06:01:00Z"),
                  end_ts_ms: iso("2026-10-23T10:47:00Z"), ...FLAT, companions: ["Olin", "Paige"] };
  const stops = [before, bakery(), after];
  pruneShrunkCompanions(stops, rows, []);
  assert.deepEqual(stops[1].companions, []);
});

// A row the piece only grazes is not the piece's. A long stay at the flat was cut
// on its rests; the café piece's own row ran a few seconds past the café's end into
// the flat piece after it, and the two friends from breakfast rode on the whole
// afternoon at the flat.
test("a row that runs a few seconds into the next piece gives that piece nobody", () => {
  const CAFE = { ...LL(120.0, 90.0) };
  const blend = { start_ts_ms: iso("2026-10-22T22:38:00Z"), end_ts_ms: iso("2026-10-23T17:01:00Z"), ...FLAT,
                  companions: ["Paige", "Olin", "Yuri"] };
  const graze = [
    // breakfast photo row, wholly inside the café piece
    { arrived_at: "2026-10-23T09:12:48Z", departed_at: "2026-10-23T09:17:48Z",
      ...LLR(120.0, 90.0), companions: ["Paige", "Olin", "Yuri"] },
    // the café row that ends five seconds into the flat piece
    { arrived_at: "2026-10-23T11:00:25Z", departed_at: "2026-10-23T11:31:55Z",
      ...LLR(120.0, 90.0), companions: ["Paige", "Olin", "Yuri"] },
    // the flat's own afternoon row
    { arrived_at: "2026-10-23T12:00:00Z", departed_at: "2026-10-23T16:00:00Z",
      ...LLR(0.0, 0.0), companions: ["Paige"] },
  ];
  const cafe = { start_ts_ms: iso("2026-10-23T08:46:40Z"), end_ts_ms: iso("2026-10-23T11:29:40Z"), ...CAFE };
  const flat = { start_ts_ms: iso("2026-10-23T11:31:50Z"), end_ts_ms: iso("2026-10-23T17:01:00Z"), ...FLAT };
  assert.deepEqual(pieceCompanions(blend, cafe, graze), ["Paige", "Olin", "Yuri"]);
  assert.deepEqual(pieceCompanions(blend, flat, graze), ["Paige"]);
});

test("a short row wholly inside a piece, or one it holds minutes of, still counts", () => {
  const blend = { start_ts_ms: iso("2026-10-22T22:38:00Z"), end_ts_ms: iso("2026-10-23T17:01:00Z"), ...FLAT,
                  companions: ["Paige", "Olin"] };
  const piece = { start_ts_ms: iso("2026-10-23T12:00:00Z"), end_ts_ms: iso("2026-10-23T13:00:00Z"), ...FLAT };
  const short = [{ arrived_at: "2026-10-23T12:10:00Z", departed_at: "2026-10-23T12:11:00Z",
                   ...LLR(0.0, 0.0), companions: ["Olin"] }];
  assert.deepEqual(pieceCompanions(blend, piece, short), ["Paige", "Olin"], "Paige came from no row: kept");
  const minutes = [{ arrived_at: "2026-10-23T11:00:00Z", departed_at: "2026-10-23T12:03:00Z",
                     ...LLR(0.0, 0.0), companions: ["Olin"] }];
  assert.deepEqual(pieceCompanions(blend, piece, minutes), ["Paige", "Olin"]);
  const sliver = [{ arrived_at: "2026-10-23T11:00:00Z", departed_at: "2026-10-23T12:00:30Z",
                    ...LLR(0.0, 0.0), companions: ["Olin"] }];
  assert.deepEqual(pieceCompanions(blend, piece, sliver), ["Paige"]);
});
