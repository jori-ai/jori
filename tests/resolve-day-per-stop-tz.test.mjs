// resolve-day-per-stop-tz.test.mjs — every stop renders in the local time of
// where the user was, not the day's single display zone.
//
// The incident: an overnight US East Coast -> Israel travel day was rendered
// entirely in Israel time, so the US evening read "12:00am ... 4:33am"
// instead of ~5pm-9:30pm EDT. Requirement: show the local time at each location
// while the user was there. A zone-crossing day labels every clock (EDT / IDT);
// a single-zone day renders exactly as before. Coordinates are coarse (a city,
// not a place) — only their zone matters here.
//
// Run: node --test tests/resolve-day-per-stop-tz.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { applyPerStopTz } = _internal;
const { timezoneForCoords, tzAbbr, tzAtMs, crossesZones } = require(path.join(ROOT, "lib/geo-timezone.js"));
const { buildSkeleton, buildMarkdown } = require(path.join(ROOT, "lib/daily-summary-render.js"));
const { localizeTasksToStops } = require(path.join(ROOT, "lib/daily-summary-tasks.js"));

const NY_START = 1790802000000; // 21:00Z = 17:00 EDT = 00:00 IDT
const IL_START = Date.parse("2026-10-01T13:22:00Z"); // 16:22 IDT

// Shaped like the real resolved-day stops: start/end already in the day's
// display zone (Israel), which is what resolve-day hands applyPerStopTz.
function travelDayStops() {
  return [
    { id: "s-ny", start: "00:00", end: "01:04", start_ts_ms: NY_START, end_ts_ms: NY_START + 64 * 60_000,
      duration_min: 64, lat: 40.65, lon: -73.78,
      place: { name: "Airport lounge", source: "user_confirmed", confidence: 1 }, companions: [], photos: [] },
    { id: "s-il", start: "16:22", end: "17:23", start_ts_ms: IL_START, end_ts_ms: IL_START + 61 * 60_000,
      duration_min: 61, lat: 32.05, lon: 34.76,
      place: { name: "Seaside bar", source: "user_confirmed", confidence: 1 }, companions: [], photos: [] },
  ];
}

function day(stops, tzs, extra = {}) {
  return {
    date: "2026-10-01", tz: "Asia/Jerusalem", tzs,
    wake: null, sleep: null, stops,
    travel_legs: [{ from: stops[0].id, to: stops[1].id, duration_min: 30, distance_km: 12.4, mode: null }],
    unmatched_calendar_events: [], corrections: [], unknown_stops: [],
    ...extra,
  };
}

test("coordinate lookup: US East Coast and Israel", () => {
  assert.equal(timezoneForCoords(40.65, -73.78), "America/New_York");
  assert.equal(timezoneForCoords(32.05, 34.76), "Asia/Jerusalem");
  assert.equal(timezoneForCoords(null, 5), null);
  assert.equal(tzAbbr("Asia/Jerusalem", IL_START), "IDT");
  assert.equal(tzAbbr("America/New_York", NY_START), "EDT");
});

test("the travel-day bug: the US stop renders 17:00 EDT, the Israel stop stays IDT", () => {
  const stops = travelDayStops();
  const tzs = applyPerStopTz(stops, "Asia/Jerusalem");
  assert.deepEqual(tzs, ["America/New_York", "Asia/Jerusalem"]);
  assert.equal(stops[0].start, "17:00");
  assert.equal(stops[0].end, "18:04");
  assert.equal(stops[0].tz_abbr, "EDT");
  assert.equal(stops[1].start, "16:22");
  assert.equal(stops[1].tz_abbr, "IDT");

  const html = buildSkeleton(day(stops, tzs), {});
  assert.match(html, /5:00pm EDT · /);
  assert.match(html, /4:22pm IDT · /);
  const md = buildMarkdown(day(stops, tzs), {});
  assert.match(md, /### 17:00-18:04 EDT · /);
  assert.match(md, /### 16:22-17:23 IDT · /);
  assert.match(md, /18:04 EDT · 30 min/);
});

test("tasks and calendar events on a zone-crossing day follow the stop the user was at", () => {
  const stops = travelDayStops();
  const tzs = applyPerStopTz(stops, "Asia/Jerusalem");
  assert.equal(tzAtMs(stops, NY_START + 10 * 60_000, "Asia/Jerusalem"), "America/New_York");
  const closedAt = NY_START + 30 * 60_000; // 17:30 EDT
  const tasks = localizeTasksToStops([{ title: "Close up the shop", completed_at: "00:30",
    completed_ts: closedAt, completed_utc: new Date(closedAt).toISOString() }], stops, "Asia/Jerusalem");
  assert.equal(tasks[0].completed_at, "17:30");
  assert.equal(tasks[0].tz_abbr, "EDT");

  const ev = { summary: "Drive to the old port", start: "2026-10-01T16:30:00+03:00", end: "2026-10-01T17:00:00+03:00", physical: false };
  const html = buildSkeleton(day(stops, tzs, { tasks_completed: tasks, unmatched_calendar_events: [ev] }), {});
  assert.match(html, /<b>5:30pm EDT<\/b> Close up the shop/);
  assert.match(html, /<b>4:30pm–5:00pm IDT<\/b> Drive to the old port/);
});

test("a single-zone day is untouched: no relabel, no tz suffix", () => {
  const stops = travelDayStops().map(s => ({ ...s, lat: 32.05, lon: 34.75 }));
  const before = buildSkeleton(day(structuredClone(stops), undefined), {});
  const tzs = applyPerStopTz(stops, "Asia/Jerusalem");
  assert.deepEqual(tzs, ["Asia/Jerusalem"]);
  assert.equal(stops[0].start, "00:00");
  assert.equal(stops[0].tz_abbr, undefined);
  const after = buildSkeleton(day(stops, tzs), {});
  assert.equal(after, before);
  assert.doesNotMatch(after, /IDT|EDT/);
});

// The real travel-day shape: the day's default zone is US Eastern (the user
// began it there) but every stop resolved in Israel. One stop zone, yet not the
// day's — before crossesZones the stops moved to IDT unlabelled while wake,
// sleep, tasks and events stayed in US Eastern time (sleep read 13:25 for 20:25 IDT).
test("all stops in a zone other than the day's: everything re-zoned and labelled", () => {
  const stops = travelDayStops().slice(1); // Israel only
  const tzs = applyPerStopTz(stops, "America/New_York");
  assert.deepEqual(tzs, ["Asia/Jerusalem"]);
  assert.ok(crossesZones(tzs, "America/New_York"));
  assert.ok(!crossesZones(tzs, "Asia/Jerusalem"));
  assert.ok(!crossesZones(undefined, "Asia/Jerusalem"));
  assert.equal(stops[0].start, "16:22");
  assert.equal(stops[0].tz_abbr, "IDT");

  const closedAt = IL_START + 20 * 60_000; // 16:42 IDT = 09:42 EDT
  const tasks = localizeTasksToStops([{ title: "Pay rent", completed_at: "09:42",
    completed_ts: closedAt, completed_utc: new Date(closedAt).toISOString() }], stops, "America/New_York");
  assert.equal(tasks[0].completed_at, "16:42");

  const wake = { at: "16:30", source: "phone_unlocks", ts_ms: IL_START + 8 * 60_000, tz_abbr: "IDT" };
  const d = { ...day(stops.concat(stops), tzs, { tasks_completed: tasks, wake }), tz: "America/New_York", travel_legs: [] };
  d.stops = stops;
  const html = buildSkeleton(d, {});
  assert.match(html, /4:22pm IDT · /);
  assert.match(html, /<b>4:42pm IDT<\/b> Pay rent/);
  assert.match(html, /Woke 4:30pm IDT at Seaside bar/);
});

test("wake vs first stop compares instants, not cross-zone HH:MM strings", () => {
  const stops = travelDayStops();
  applyPerStopTz(stops, "Asia/Jerusalem");
  // Woke 00:10 IDT (= 17:10 EDT, inside the US stop) — the strings "00:10"
  // vs "17:00-18:04" disagree, the instants agree.
  const wake = { at: "00:10", source: "phone_unlocks", ts_ms: NY_START + 10 * 60_000 };
  const html = buildSkeleton(day(stops, ["America/New_York", "Asia/Jerusalem"], { wake }), {});
  assert.match(html, /Woke 12:10am at Airport lounge/);
});
