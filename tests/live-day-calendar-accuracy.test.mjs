// live-day-calendar-accuracy.test.mjs — the calendar prediction number in
// `live-day accuracy` (computeAccuracy: calendar_supports / calendar_total_physical).
//
// A calendar event lands on the GPS interval it overlaps with gps_status
// "supports"; when the user's own confirmation of that stop is carried onto the
// interval the status becomes "confirmed". Both are hits: counting only
// "supports" left calendar_accuracy null on nearly every day. Synthetic day.
//
// Run: node --test tests/live-day-calendar-accuracy.test.mjs
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const { computeAccuracy } = require("../lib/live-day.js");

const D = "2099-03-07";
const HERE = at(0, 0);
const ms = (iso) => Date.parse(iso);
const cal = (summary, start, end, location = "Rua Exemplo 1, Sample City") =>
  ({ event_id: summary, summary, expected_start: start, expected_end: end, location });
const iv = (id, start, end, { source = "google_places", status = "supports", calendar = null, name = id } = {}) => ({
  id, start, end, start_ts_ms: ms(start), end_ts_ms: ms(end), open: false, type: "stop",
  place: { name, source, confidence: source === "user_confirmed" ? 1 : 0.9, lat: HERE.lat, lon: HERE.lon },
  calendar, gps_status: status, duration_min: Math.round((ms(end) - ms(start)) / 60_000), evidence_log: [],
});
const day = (intervals, unmatched = []) =>
  ({ date: D, tz: "UTC", intervals, unmatched_calendar_events: unmatched });

test("a calendar match on a stop the user confirmed counts as supported", () => {
  const acc = computeAccuracy(day([
    iv("iv-gps-1", `${D}T10:19:33Z`, `${D}T12:57:24Z`, {
      source: "user_confirmed", status: "confirmed",
      calendar: cal("Wedding", `${D}T13:00:00+03:00`, `${D}T16:00:00+03:00`),
    }),
  ]));
  assert.equal(acc.calendar_supports, 1);
  assert.equal(acc.calendar_total_physical, 1);
  assert.equal(acc.calendar_accuracy, 1);
});

test("supports and confirmed are hits, a past event with no GPS is a miss", () => {
  const acc = computeAccuracy(day([
    iv("iv-gps-1", `${D}T06:00:00Z`, `${D}T07:00:00Z`, {
      calendar: cal("Coffee", `${D}T09:00:00+03:00`, `${D}T10:00:00+03:00`) }),
    iv("iv-gps-2", `${D}T09:00:00Z`, `${D}T11:00:00Z`, {
      source: "user_confirmed", status: "confirmed",
      calendar: cal("Lunch", `${D}T12:00:00+03:00`, `${D}T13:30:00+03:00`) }),
    iv("iv-cal-x", `${D}T15:00:00Z`, `${D}T16:00:00Z`, {
      source: "calendar_seed", status: "missed",
      calendar: cal("Dentist", `${D}T18:00:00+03:00`, `${D}T19:00:00+03:00`) }),
  ]));
  assert.equal(acc.calendar_supports, 2);
  assert.equal(acc.calendar_missed, 1);
  assert.equal(acc.calendar_total_physical, 3);
  assert.equal(acc.calendar_accuracy, 0.667);
});

test("not-yet-happened, contradicted and calendar-less intervals stay out of the count", () => {
  const acc = computeAccuracy(day([
    iv("iv-cal-future", `${D}T18:00:00Z`, `${D}T19:00:00Z`, {
      source: "calendar_seed", status: "no_evidence_yet",
      calendar: cal("Later", `${D}T21:00:00+03:00`, `${D}T22:00:00+03:00`) }),
    iv("iv-gps-c", `${D}T08:00:00Z`, `${D}T09:00:00Z`, {
      status: "contradicts", calendar: cal("Elsewhere", `${D}T11:00:00+03:00`, `${D}T12:00:00+03:00`) }),
    iv("iv-gps-plain", `${D}T10:00:00Z`, `${D}T11:00:00Z`, { source: "user_confirmed", status: "confirmed" }),
  ]));
  assert.equal(acc.calendar_supports, 0);
  assert.equal(acc.calendar_total_physical, 0);
  assert.equal(acc.calendar_accuracy, null, "nothing checkable is null, never 1.0");
});

test("a confirmed event scores; a location-less visit is not counted either way", () => {
  const acc = computeAccuracy(day([
    iv("iv-gps-a", `${D}T07:00:05.000Z`, `${D}T10:15:08.000Z`, {
      source: "user_confirmed", status: "confirmed", name: "The rental flat",
      calendar: cal("Alex's wedding ", `${D}T13:00:00+03:00`, `${D}T16:00:00+03:00`, "Restaurante Exemplo, Sample City") }),
    iv("iv-gps-b", `${D}T14:14:45.000Z`, `${D}T16:14:37.000Z`, {
      source: "user_confirmed", status: "confirmed", name: "A relative's home" }),
  ], [{
    event_id: "evt-visit-1", summary: "Visit Sam and Robin", location: null,
    start: `${D}T17:00:00+03:00`, end: `${D}T18:30:00+03:00`, duration_min: 90, physical: false,
  }]));
  assert.equal(acc.calendar_supports, 1);
  assert.equal(acc.calendar_missed, 0);
  assert.equal(acc.calendar_unmatched_physical, 0);
  assert.equal(acc.calendar_total_physical, 1);
  assert.equal(acc.calendar_accuracy, 1);
});
