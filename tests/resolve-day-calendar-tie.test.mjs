// resolve-day-calendar-tie.test.mjs — which calendar event a stop carries when
// two overlap it, and what happens to the one that loses.
//
// enrichStopsWithCalendar keeps the most specific (shortest) event per stop. On
// a tie in length the event that covers more of the stop wins (never the
// calendar's listing order), and the losing event is listed as unmatched rather
// than recorded nowhere. Synthetic day and place; the calendar CLI is a stub.
//
// Run: node --test tests/resolve-day-calendar-tie.test.mjs

import "./synthetic-instance.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { at as fakeAt } from "./fixtures/fake-geo.mjs";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cal-tie-"));
const GOG = path.join(DIR, "gog");
process.env.GOG_BIN = GOG;          // read once when location-calendar-fuse.js loads
const require = createRequire(import.meta.url);
const { _internal: { enrichStopsWithCalendar } } = require("../lib/resolve-day.js");

const DATE = "2099-05-07";
after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(os.tmpdir(), `cal-${DATE}.json`)); } catch { /* not written */ }
  try { fs.unlinkSync(path.join("/tmp", `cal-${DATE}.json`)); } catch { /* not written */ }
});

const PLACE = fakeAt(0, 0);
const fakeGog = (events) => fs.writeFileSync(GOG,
  `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(events)}\nJSON\n`, { mode: 0o755 });
const at = (hm) => `${DATE}T${hm}:00+02:00`;
const timed = (summary, from, to) => ({ summary, start: { dateTime: at(from) }, end: { dateTime: at(to) } });
const stop = (from, to) => ({ id: "s1", start_ts_ms: Date.parse(at(from)), end_ts_ms: Date.parse(at(to)),
                              lat: PLACE.lat, lon: PLACE.lon, calendar_event: null });

test("a tie in length goes to the event that covers more of the stop; the other is unmatched", async () => {
  fakeGog([timed("Errand elsewhere", "18:00", "21:00"), timed("Evening with Alex", "19:00", "22:00")]);
  const s = stop("19:17", "22:41");
  const r = await enrichStopsWithCalendar([s], DATE);
  assert.equal(s.calendar_event.summary, "Evening with Alex");
  assert.ok(s.calendar_event.event_share > 0.9, String(s.calendar_event.event_share));
  assert.deepEqual(r.unmatched_calendar_events.map((e) => e.summary), ["Errand elsewhere"]);
});

test("the listing order does not decide a tie", async () => {
  fakeGog([timed("Evening with Alex", "19:00", "22:00"), timed("Errand elsewhere", "18:00", "21:00")]);
  const s = stop("19:17", "22:41");
  const r = await enrichStopsWithCalendar([s], DATE);
  assert.equal(s.calendar_event.summary, "Evening with Alex");
  assert.deepEqual(r.unmatched_calendar_events.map((e) => e.summary), ["Errand elsewhere"]);
});

test("a shorter event still wins over a longer one, and the longer one is listed, not lost", async () => {
  fakeGog([timed("Drinks", "18:00", "19:00"), timed("Dinner", "19:00", "22:00")]);
  const s = stop("18:00", "23:00");
  const r = await enrichStopsWithCalendar([s], DATE);
  assert.equal(s.calendar_event.summary, "Drinks");
  assert.deepEqual(r.unmatched_calendar_events.map((e) => e.summary), ["Dinner"]);
});

test("an event that a stop still carries is not also listed as unmatched; a losing all-day block is not listed", async () => {
  fakeGog([
    { summary: "Stay somewhere", start: { date: DATE }, end: { date: "2099-05-09" } },
    timed("Lunch", "13:00", "14:00"),
    timed("Walk", "16:00", "17:00"),
  ]);
  const a = stop("13:00", "14:00"), b = { ...stop("16:00", "17:00"), id: "s2" };
  const r = await enrichStopsWithCalendar([a, b], DATE);
  assert.equal(a.calendar_event.summary, "Lunch");
  assert.equal(b.calendar_event.summary, "Walk");
  assert.deepEqual(r.unmatched_calendar_events, []);
});
