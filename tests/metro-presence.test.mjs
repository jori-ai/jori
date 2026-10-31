// metro-presence.test.mjs — the calendar walk behind `metro-presence`: the
// last flight's destination, the lodging cross-check, and fail-open at home.
// Synthetic metros and airports.
// Run: node --test tests/metro-presence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "metro-presence-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "travel.json"), JSON.stringify({
  metros: [
    { key: "home_city", aliases: ["home city", "old town"], airports: ["AAA", "AAB"] },
    { key: "beach_city", aliases: ["beach city"], airports: ["BBB"] },
  ],
  home_metros: ["home_city"],
}));
process.env.JORI_LOCAL_DIR = LOCAL;
process.env.JORI_TZ = "America/Chicago";
const { fromCalendar, namesMetro } = require("../bin/metro-presence");

const flight = (date, from, to, h = 15) => ({ summary: `Flight to somewhere (XX 12) — ${from} → ${to}`, start: { dateTime: `${date}T${h}:00:00Z` } });
const stay = (from, to, place) => ({ summary: `Stay at ${place}`, start: { date: from }, end: { date: to } });

test("no flight in the window: a home metro is in, any other is away", () => {
  assert.equal(fromCalendar([], "2026-05-10", "home_city", { home: true }).in, true);
  assert.equal(fromCalendar([], "2026-05-10", "beach_city", { home: false }).in, false);
});

test("the last flight before the end of the day decides", () => {
  const ev = [flight("2026-05-01", "AAA", "BBB"), flight("2026-05-08", "BBB", "AAB")];
  assert.equal(fromCalendar(ev, "2026-05-05", "home_city", { home: true }).in, false);
  assert.equal(fromCalendar(ev, "2026-05-05", "beach_city").in, true);
  const back = fromCalendar(ev, "2026-05-08", "home_city", { home: true });
  assert.equal(back.in, true);
  assert.equal(back.signal, "flight");
  assert.equal(fromCalendar(ev, "2026-05-07", "home_city", { home: true }).in, false, "still away the day before");
});

test("a title without an airport pair is not a flight", () => {
  const ev = [{ summary: "Rocket Flight 12 launch", start: { dateTime: "2026-05-01T15:00:00Z" } }];
  assert.equal(fromCalendar(ev, "2026-05-02", "home_city", { home: true }).in, true);
});

test("an away lodging flips in to away; a lodging in the metro does not; checkout morning is home", () => {
  assert.equal(fromCalendar([stay("2026-05-10", "2026-05-12", "Lake Lodge (Far Away)")], "2026-05-11", "home_city", { home: true }).in, false);
  assert.equal(fromCalendar([stay("2026-05-10", "2026-05-12", "Lake Lodge (Far Away)")], "2026-05-12", "home_city", { home: true }).in, true);
  assert.equal(fromCalendar([stay("2026-05-10", "2026-05-12", "Hotel Example (Old Town)")], "2026-05-11", "home_city", { home: true }).in, true);
});

test("namesMetro matches whole alias words only", () => {
  assert.equal(namesMetro("Stay at Inn (Old Town)", ["old town"]), true);
  assert.equal(namesMetro("Stay at Inn (Old Townsend)", ["old town"]), false);
});
