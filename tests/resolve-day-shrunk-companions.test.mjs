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
import fs from "node:fs";
import os from "node:os";
import { at as fakeAt } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { pruneShrunkCompanions, pieceCompanions, annotateCompanionJoins, settleJoinsOnFindMy, loadCompanionReadings } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;
const { stopHeaderHtml } = require(path.join(ROOT, "lib/daily-summary-render.js"))._internal;

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

// ---------------------------------------------------------------------------
// A guest who arrives partway through a long stay is noted with when. A stop's
// people are the union of every visit row it holds, so a stay from midnight to
// evening listed a visitor whose first row began in the afternoon from its first
// minute (annotateCompanionJoins; the header prints it "(from 1:03pm)").
// ---------------------------------------------------------------------------
const STAY = (over = {}) => ({ id: "s-9", start: "00:00", end: "18:10", tz: "UTC",
  start_ts_ms: iso("2026-10-24T00:00:00Z"), end_ts_ms: iso("2026-10-24T18:10:00Z"), ...FLAT,
  companions: ["Paige", "Olin"], ...over });
const stayRows = () => [
  { arrived_at: "2026-10-23T17:49:00Z", departed_at: "2026-10-24T18:05:00Z", ...LLR(0, 0), companions: ["Paige"] },
  { arrived_at: "2026-10-24T13:03:00Z", departed_at: "2026-10-24T13:08:00Z", ...LLR(0, 0), companions: ["Olin", "Paige"] },
  { arrived_at: "2026-10-24T14:33:00Z", departed_at: "2026-10-24T14:59:00Z", ...LLR(0, 0), companions: ["Paige", "Olin"] },
];

test("a guest whose rows begin hours into a long stay is noted with the time their first row began", () => {
  const stop = STAY();
  const out = annotateCompanionJoins([stop], stayRows());
  assert.deepEqual(stop.companion_joins, { Olin: "13:03" });   // Paige is on the row the stay began with
  assert.deepEqual(stop.companions, ["Paige", "Olin"], "nobody leaves the stop");
  assert.deepEqual(out, [{ id: "s-9", window: "00:00\u201318:10", joins: { Olin: "13:03" } }]);
});

test("no note for a short stay, a late row under two hours in, a name the user's words or the fixes placed, or one no row names", () => {
  const short = STAY({ start: "12:00", end: "15:00", start_ts_ms: iso("2026-10-24T12:00:00Z"), end_ts_ms: iso("2026-10-24T15:00:00Z") });
  annotateCompanionJoins([short], stayRows());
  assert.equal("companion_joins" in short, false, "a stay under four hours cannot hide a late arrival");
  const early = STAY();
  annotateCompanionJoins([early], [{ arrived_at: "2026-10-24T01:30:00Z", departed_at: "2026-10-24T02:00:00Z", ...LLR(0, 0), companions: ["Olin"] }]);
  assert.equal("companion_joins" in early, false, "first seen 90 minutes into the stay is not a late arrival");
  const told = STAY();
  annotateCompanionJoins([told], stayRows(), [{ id: "s-9", companions: ["Olin"] }]);
  assert.equal("companion_joins" in told, false, "the user's words put the guest there");
  const fixed = STAY();
  annotateCompanionJoins([fixed], stayRows(), [], [{ id: "s-9", name: "Home", added: ["Olin"], fixes: 9 }]);
  assert.equal("companion_joins" in fixed, false, "the fixes put the guest there");
  const stranger = STAY({ companions: ["Paige", "Quinn"] });
  annotateCompanionJoins([stranger], stayRows());
  assert.equal("companion_joins" in stranger, false, "a name no row gives is not this pass's to date");
  const off = STAY();
  process.env.JORI_COMPANION_JOINS = "0";
  try { annotateCompanionJoins([off], stayRows()); } finally { delete process.env.JORI_COMPANION_JOINS; }
  assert.equal("companion_joins" in off, false);
});

test("the header reads the guest's time, and only when it is after the stop's own start", () => {
  const day = { date: "2026-10-24", tz: "UTC", stops: [] };
  const stop = { id: "s-9", start: "00:00", end: "18:10", place: { name: "Home" }, companions: ["Paige", "Olin"],
                 companion_joins: { Olin: "13:03" } };
  const text = (s) => stopHeaderHtml(s, day).replace(/<[^>]+>/g, "");
  assert.match(text(stop), /with Paige \+ Olin \(from 1:03pm\)/);
  assert.doesNotMatch(text({ ...stop, start: "13:03" }), /from/, "a stop that begins when the guest arrived needs no note");
  assert.doesNotMatch(text({ ...stop, companion_joins: undefined }), /from/);
});

// ---------------------------------------------------------------------------
// Find My dates a guest better than a visit row does. A long stay's own row cannot
// carry anyone who stepped out for a while, so the first row naming the household's
// people was a short one hours in and the header said they arrived then; the 10-minute
// readings had them with the user from the first one of the day (settleJoinsOnFindMy).
// ---------------------------------------------------------------------------
const rd = (person, hm, verdict = "together") => ({ person, t: iso(`2026-10-24T${hm}:00Z`), verdict });
const joined = () => { const stop = STAY(); const noted = annotateCompanionJoins([stop], stayRows()); return { stop, noted }; };

test("a guest Find My had with the user from the stop's first hours has no 'from' time", () => {
  const { stop, noted } = joined();
  assert.deepEqual(stop.companion_joins, { Olin: "13:03" });
  const changed = settleJoinsOnFindMy([stop], [rd("Olin", "00:20"), rd("Olin", "00:32"), rd("Olin", "09:00", "apart"), rd("Olin", "13:05")]);
  assert.equal("companion_joins" in stop, false, "they were there from the start");
  assert.deepEqual(changed, [{ id: "s-9", name: "Olin", was: "13:03", now: null, findmy_at: "00:20" }]);
  assert.deepEqual(noted[0].joins, {}, "the noted entry shares the joins object, so the day-level list can drop it");
});

test("a tracked guest who arrives mid-stay is dated by their first run of readings when it is earlier than the row", () => {
  const { stop } = joined();
  const changed = settleJoinsOnFindMy([stop], [rd("Olin", "01:00", "apart"), rd("Olin", "12:00", "apart"), rd("Olin", "12:50"), rd("Olin", "13:00")]);
  assert.deepEqual(stop.companion_joins, { Olin: "12:50" });
  assert.deepEqual(changed, [{ id: "s-9", name: "Olin", was: "13:03", now: "12:50", findmy_at: "12:50" }]);
});

test("Find My never adds a join, never moves one later, and a lone reading is not evidence", () => {
  const later = joined().stop;
  assert.deepEqual(settleJoinsOnFindMy([later], [rd("Olin", "13:20"), rd("Olin", "13:30")]), []);
  assert.deepEqual(later.companion_joins, { Olin: "13:03" }, "the row's earlier time stands");
  const lone = joined().stop;
  assert.deepEqual(settleJoinsOnFindMy([lone], [rd("Olin", "00:20"), rd("Olin", "09:00")]), []);
  assert.deepEqual(lone.companion_joins, { Olin: "13:03" }, "one reading with nothing near it settles nothing");
  const none = STAY();
  assert.deepEqual(settleJoinsOnFindMy([none], [rd("Olin", "00:20"), rd("Olin", "00:32")]), []);
  assert.equal("companion_joins" in none, false, "a stop with no join gains none");
});

test("a guest Find My does not follow keeps the row's time; so do readings of someone else", () => {
  const { stop } = joined();
  assert.deepEqual(settleJoinsOnFindMy([stop], [rd("Paige", "00:20"), rd("Paige", "00:32")]), []);
  assert.deepEqual(settleJoinsOnFindMy([stop], []), []);
  assert.deepEqual(stop.companion_joins, { Olin: "13:03" });
});

test("the switch turns the Find My pass off", () => {
  const { stop } = joined();
  process.env.JORI_JOINS_FINDMY = "0";
  try { assert.deepEqual(settleJoinsOnFindMy([stop], [rd("Olin", "00:20"), rd("Olin", "00:32")]), []); } finally { delete process.env.JORI_JOINS_FINDMY; }
  assert.deepEqual(stop.companion_joins, { Olin: "13:03" });
});

test("the readings come from the day files, and a missing or broken file changes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readings-"));
  try {
    const { stop } = joined();
    assert.deepEqual(loadCompanionReadings([stop], dir), [], "no files, no readings");
    fs.writeFileSync(path.join(dir, "readings-2026-10-24.json"), JSON.stringify([
      { person: "Olin", t: "2026-10-24T00:20:00+00:00", verdict: "together" },
      { person: "Olin", t: "2026-10-25T00:20:00+00:00", verdict: "together" },
      { person: "Paige", t: "not a time", verdict: "together" },
    ]));
    fs.writeFileSync(path.join(dir, "readings-2026-10-23.json"), "{ not json");
    assert.deepEqual(loadCompanionReadings([stop], dir), [{ person: "Olin", t: iso("2026-10-24T00:20:00Z"), verdict: "together" }]);
    assert.deepEqual(loadCompanionReadings([STAY()], dir), [], "no stop with a join, no files read");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
