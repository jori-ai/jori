// stop-name-writeback.test.mjs — a name the day EARNED reaches the row it stands
// on, and nothing else (a named stop the day knew was missing from its map).
// Synthetic coordinates and names, the real case's geometry.
//
// One evening as the stores held it the next morning:
//   - resolve-day: stop 19:22–21:48, `saved_place` "Example Jazz Club" at 0.9, verified
//     rest of 144 min 6 m from the club;
//   - location_history: the row under it said "131 Example St" / address, and a
//     sweeper-synthesized twin 144 m up the block said "354–358 Example Ave" / address;
//   - the map, drawn from the rows, labelled the stop with the twin's address.
//
// Run: node --test tests/stop-name-writeback.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { planNameWriteBack, applyNameWriteBack, WRITEBACK_ROW_M, WRITTEN_TYPE } =
  require(path.join(HERE, "..", "lib", "stop-name-writeback.js"));

const MIN = 60_000;
const T0 = Date.parse("2026-09-07T23:22:51Z");   // 19:22 ET
const T1 = Date.parse("2026-09-08T01:48:00Z");   // 21:48 ET
const BLUE_NOTE = { ...fakeAt(0, 0) };

// Nine precise, stationary-tagged fixes at the club, as the tracker recorded.
function pings() {
  const out = [];
  for (let i = 0; i < 9; i++) {
    out.push({ ts: T0 + (10 + i * 14) * MIN, lat: BLUE_NOTE.lat + 0.00003, lon: BLUE_NOTE.lon - 0.00004,
               acc: 12, activity: "stationary", kind: "fix" });
  }
  return out;
}

const BLUE_NOTE_ROW = {
  id: "5306a953", ...fakeRow(3.37, 12.23),
  arrived_at: "2026-09-07T23:28:39Z", departed_at: "2026-09-08T01:47:41Z",
  place_name: "131 Example St", place_type: "address", notes: "[sweeper] departed_at synthesized",
};
const SIXTH_AVE_TWIN = {
  id: "4e6b7e80", ...fakeRow(15.17, 155.67),
  arrived_at: "2026-09-07T23:22:51Z", departed_at: "2026-09-08T00:23:57Z",
  place_name: "354–358 Example Ave", place_type: "address", notes: null,
};

function stop(over = {}) {
  return {
    id: "s-20260907-4", start_ts_ms: T0, end_ts_ms: T1, ...fakeAt(4.97, 40.59),
    place: { name: "Example Jazz Club", source: "saved_place", confidence: 0.9 },
    ...over,
  };
}

test("the row under the rest takes the earned name; the twin up the block does not", () => {
  const plan = planNameWriteBack([stop()], [SIXTH_AVE_TWIN, BLUE_NOTE_ROW], pings());
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].row, "5306a953");
  assert.equal(plan.writes[0].name, "Example Jazz Club");
  assert.equal(plan.writes[0].was_name, "131 Example St");
  assert.ok(plan.writes[0].rest_distance_m <= WRITEBACK_ROW_M);
});

test("a verdict on the row is never overwritten", () => {
  for (const place_type of ["user-confirmed", "named", "non-stop", "photo-synthesized"]) {
    const row = { ...BLUE_NOTE_ROW, place_type, place_name: "Comedy Cellar" };
    const plan = planNameWriteBack([stop()], [row], pings());
    assert.equal(plan.writes.length, 0, place_type);
    assert.equal(plan.skipped.length, 1, place_type);
  }
});

test("a row already carrying the name is a no-op, not a rewrite", () => {
  const row = { ...BLUE_NOTE_ROW, place_type: WRITTEN_TYPE, place_name: "Example Jazz Club" };
  const plan = planNameWriteBack([stop()], [row], pings());
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 0);
});

test("only saved_place and photo_text names travel; a guess or a confirmation does not", () => {
  for (const source of ["google_places", "osm_overpass", "user_confirmed", "known_recurring", "unknown"]) {
    const plan = planNameWriteBack([stop({ place: { name: "Example Jazz Club", source } })], [BLUE_NOTE_ROW], pings());
    assert.equal(plan.writes.length, 0, source);
  }
  const plan = planNameWriteBack([stop({ place: { name: "Example Jazz Club", source: "photo_text" } })], [BLUE_NOTE_ROW], pings());
  assert.equal(plan.writes.length, 1);
});

test("no rest, no write — the name has nothing to be anchored to", () => {
  const plan = planNameWriteBack([stop()], [BLUE_NOTE_ROW], []);
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped[0].reason, /no verified rest/);
});

test("a row outside the stop's window is not this stop's row", () => {
  const earlier = { ...BLUE_NOTE_ROW, id: "x", arrived_at: "2026-09-07T20:00:00Z", departed_at: "2026-09-07T21:00:00Z" };
  const plan = planNameWriteBack([stop()], [earlier], pings());
  assert.equal(plan.writes.length, 0);
});

test("apply PATCHes name + type and appends an audit line to the row's notes", async () => {
  const plan = planNameWriteBack([stop()], [BLUE_NOTE_ROW], pings());
  const patches = [];
  const r = await applyNameWriteBack(plan, {
    patch: async (id, body) => { patches.push({ id, body }); },
    rowNotes: () => BLUE_NOTE_ROW.notes,
    today: "2026-09-08",
  });
  assert.equal(r.done.length, 1);
  assert.equal(patches[0].id, "5306a953");
  assert.equal(patches[0].body.place_name, "Example Jazz Club");
  assert.equal(patches[0].body.place_type, WRITTEN_TYPE);
  assert.equal(patches[0].body.notes,
    '[sweeper] departed_at synthesized\n[writeback 2026-09-08] saved_place -> "Example Jazz Club"; was: 131 Example St (address)');
});

test("a failed PATCH is reported, not thrown — an unwritten row leaves the day as it was", async () => {
  const plan = planNameWriteBack([stop()], [BLUE_NOTE_ROW], pings());
  const r = await applyNameWriteBack(plan, { patch: async () => { throw new Error("HTTP 500"); } });
  assert.equal(r.done.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /500/);
});
