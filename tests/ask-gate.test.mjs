// ask-gate.test.mjs — a rental-flat evening asked as "21:29–21:53 (24 min),
// after the flat — were you at the flat?" when the user had not moved all
// evening. The fixture has that night's shape: a stay open since 16:25Z, and
// every fix since within 1 m of the flat.
//
// Plus the cases the thresholds were tuned on: a real breakfast at a café
// 155 m from the flat the user walked back to must stay askable; one far
// fix from a still phone is not a departure; a photo away is.
// Run: node --test tests/ask-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, meters } from "../lib/ask-gate.mjs";

const FLAT = { lat: 32.05, lon: 34.75 }; // a synthetic point (the lon scale below assumes ~32°N)
const T = (hhmmss, day = "2026-10-07") => Date.parse(`${day}T${hhmmss}Z`);
const fix = (hhmmss, dy = 0, dx = 0, acc = 10, day) => ({
  t: T(hhmmss, day), lat: FLAT.lat + dy / 111320, lon: FLAT.lon + dx / 94400, acc, kind: "fix" });

// 2026-10-07 from 16:21Z, as stored (offsets in metres from the flat).
const NIGHT = [
  fix("16:21:01", 4, 79, 17.7), fix("16:23:02", -7, 10, 15.8), fix("16:26:04", 0, 0, 11.1),
  fix("17:01:05", -1, -1, 11.3), fix("17:01:07", -1, -1, 11.3), fix("17:06:22", 0, 0, 5.8),
  fix("18:29:13", 0, 0, 9.5), fix("18:29:18", 0, 0, 8.0), fix("18:29:21", 0, 0, 8.0),
  fix("18:53:40", -1, -1, 14.0),
];
const OPEN_STAY = { id: "00773ba0", place_type: "address", latitude: FLAT.lat, longitude: FLAT.lon,
  arrived_at: "2026-10-07T16:25:45Z", departed_at: null };

test("the 21:29 flat slice is a stay the user never left — not asked", () => {
  const g = gate({ points: NIGHT, start: T("18:29:13"), end: T("18:53:40"), priorStays: [OPEN_STAY], fallbackCenter: FLAT });
  assert.equal(g.ask, false);
  assert.equal(g.check, "same-stay");
});

test("without the open row it is still held: nothing away from it since", () => {
  const g = gate({ points: NIGHT, start: T("18:29:13"), end: T("18:53:40"), priorStays: [], fallbackCenter: FLAT });
  assert.equal(g.ask, false);
  assert.equal(g.check, "no-departure");
});

test("and no 'Left the flat' either", () => {
  const g = gate({ points: NIGHT, start: T("18:29:13"), end: T("18:53:40"), mode: "departure", fallbackCenter: FLAT });
  assert.equal(g.ask, false);
});

test("one far fix from a still phone is not a departure", () => {
  const pts = [...NIGHT, fix("19:10:00", 190, 0, 12)];
  const g = gate({ points: pts, start: T("18:29:13"), end: T("18:53:40"), priorStays: [], fallbackCenter: FLAT });
  assert.equal(g.check, "no-departure");
});

test("two points away are; so is one photo away", () => {
  const two = [...NIGHT, fix("19:10:00", 190, 0, 12), fix("19:11:00", 260, 0, 12)];
  assert.equal(gate({ points: two, start: T("18:29:13"), end: T("18:53:40"), fallbackCenter: FLAT }).check, "left");
  const photo = [...NIGHT, { t: T("19:10:00"), lat: FLAT.lat + 300 / 111320, lon: FLAT.lon, acc: null, kind: "photo" }];
  assert.equal(gate({ points: photo, start: T("18:29:13"), end: T("18:53:40"), fallbackCenter: FLAT }).check, "left");
});

test("the café: a real breakfast 155 m from the flat stays askable", () => {
  const day = "2026-10-03";
  const S = { dy: 0, dx: 155 }; // the café, 155 m east of the flat
  const pts = [
    fix("05:00:00", 0, 0, 8, day), fix("07:10:00", 2, 1, 9, day),           // night at the flat
    fix("07:16:00", 0, 80, 15, day),                                         // the walk over
    fix("07:21:30", S.dy, S.dx, 9, day), fix("07:30:00", S.dy + 2, S.dx, 8, day), fix("07:40:00", S.dy, S.dx - 1, 9, day),
    fix("07:47:00", 0, 2, 10, day), fix("07:55:00", 1, 0, 9, day),          // back at the flat
  ];
  const flatNight = { id: "night", place_type: "user-confirmed", latitude: FLAT.lat, longitude: FLAT.lon,
    arrived_at: "2026-10-02T20:18:27Z", departed_at: "2026-10-03T08:41:00Z" }; // sweeper-stretched
  const g = gate({ points: pts, start: T("07:21:30", day), end: T("07:40:00", day), priorStays: [flatNight],
    fallbackCenter: { lat: FLAT.lat, lon: FLAT.lon + 155 / 94400 } });
  assert.equal(g.ask, true, g.reason);
  assert.ok(meters(g.center, FLAT) > 140);
});
