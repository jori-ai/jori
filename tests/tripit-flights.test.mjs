// tripit-flights.test.mjs — TripIt's structured objects as flights-scan records
// (lib/tripit-flights.mjs), and the rules that decide which emails still
// need the model. The fixture mirrors the TripIt v1 list/trip JSON shape
// (single objects and arrays both occur; Segment and Traveler are either).
//
// Run: node --test tests/tripit-flights.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recordsFromTripit, fetchTripit, coveredByTripit, codeTokens, tripitIso, tripitDelta } from "../lib/tripit-flights.mjs";
import { mergeEntries } from "../lib/flights-scan.mjs";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "tripit-list-trips.json"), "utf8"));
const root = fixture.Response;

test("tripitIso keeps the station's own offset", () => {
  assert.equal(tripitIso({ date: "2026-10-14", time: "22:30:00", utc_offset: "-04:00" }), "2026-10-14T22:30:00-04:00");
  assert.equal(tripitIso({ date: "2026-10-23", utc_offset: "+03:00" }, "12:00:00"), "2026-10-23T12:00:00+03:00");
  assert.equal(tripitIso({ date: "2026-10-23" }), "2026-10-23");
  assert.equal(tripitIso({}), null);
});

test("Air, Lodging and Car objects map onto the email record shape", () => {
  const recs = recordsFromTripit(root);
  const flights = recs.filter((r) => r.type === "flight");
  assert.equal(flights.length, 2, "one record per segment");
  const out = flights.find((r) => r.from === "LHR");
  assert.equal(out.number, "XY8");
  assert.equal(out.confirmation, "K7QX2M");
  assert.equal(out.depart, "2026-10-14T22:30:00+01:00");
  assert.equal(out.arrive, "2026-10-15T16:05:00+03:00");
  assert.deepEqual(out.passengers, ["Jane Doe", "John Doe"]);
  assert.deepEqual(out.seats, ["32A", "32B"]);
  assert.equal(out.status, "confirmed");
  assert.ok(out.source_message_id.startsWith("tripit:air:"));

  const stay = recs.find((r) => r.type === "accommodation");
  assert.equal(stay.checkin, "2026-10-15");
  assert.equal(stay.checkout, "2026-10-20");
  assert.equal(stay.guests, 2);
  assert.equal(stay.location, "Athens, GR");

  const car = recs.find((r) => r.type === "car_rental");
  assert.equal(car.provider, "Sixt");
  assert.equal(car.return, "2026-10-23T12:00:00+03:00");
  assert.ok(recs.every((r) => Object.values(r).every((v) => v !== undefined)));
});

test("objects without a confirmation code or a start date are skipped", () => {
  const recs = recordsFromTripit({ AirObject: { id: "x", Segment: { StartDateTime: { date: "2026-11-01" } } }, LodgingObject: { id: "y", supplier_conf_num: "ABCDE" } });
  assert.equal(recs.length, 0);
});

test("fetchTripit pages through list/trip and builds code coverage", async () => {
  const calls = [];
  const api = { listTrips: async (o) => { calls.push(o); return { root, maxPage: 1 }; } };
  const { records, coverage } = await fetchTripit({ user: "u", password: "p", api });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].past, false);
  assert.equal(records.length, 4);
  assert.equal(coverage.get("K7QX2M"), 1790800000 * 1000);
});

test("coveredByTripit: forwards, known codes, and newer mail", () => {
  const coverage = new Map([["K7QX2M", 1790800000 * 1000]]);
  assert.ok(coveredByTripit({ viaTripitForward: true, text: "", internalDate: 0 }, coverage));
  // Same code, older than TripIt's last update → TripIt already has it.
  assert.ok(coveredByTripit({ text: "Booking ref K7QX2M — your itinerary", internalDate: 1790700000 * 1000 }, coverage));
  // Same code, newer → could be a change or cancellation TripIt has not seen.
  assert.ok(!coveredByTripit({ text: "Booking ref K7QX2M — schedule change", internalDate: 1790900000 * 1000 }, coverage));
  // A code inside a longer token is not a match.
  assert.ok(!coveredByTripit({ text: "XK7QX2MZ", internalDate: 0 }, coverage));
  // No TripIt data at all → never covered (the all-email fallback).
  assert.ok(!coveredByTripit({ viaTripitForward: true, text: "K7QX2M", internalDate: 0 }, new Map()));
});

test("codeTokens splits on non-alphanumerics, case-insensitively", () => {
  assert.deepEqual([...codeTokens("ref: k7qx2m/SX99-12")], ["REF", "K7QX2M", "SX99", "12"]);
});

test("tripitDelta: nothing re-merged when flights.json already agrees", () => {
  const recs = recordsFromTripit(root);
  const today = "2026-10-05";
  const first = mergeEntries([], tripitDelta([], recs), today);
  assert.equal(first.touched.size, 4);
  // Same TripIt view next run → no delta, so no calendar rewrite and no ping.
  assert.equal(tripitDelta(first.entries, recs).length, 0);
  // An email-extracted spelling of the same leg ("XY 8") must not register as a change either.
  const emailSpelled = first.entries.map((e) => (e.number === "XY8" ? { ...e, number: "XY 8", airline: "EXAMPLE AIR" } : e));
  assert.equal(tripitDelta(emailSpelled, recs).length, 0);
});

test("tripitDelta: a re-timed leg updates the existing entry in place", () => {
  const recs = recordsFromTripit(root);
  const today = "2026-10-05";
  const base = mergeEntries([], recs, today).entries.map((e) => (e.number === "XY8" ? { ...e, number: "XY 8" } : e));
  const moved = recs.map((r) => (r.number === "XY8" ? { ...r, depart: "2026-10-14T23:15:00+01:00" } : r));
  const delta = tripitDelta(base, moved);
  assert.equal(delta.length, 1);
  assert.equal(delta[0].number, "XY 8", "carries the stored spelling so the merge matches");
  const merged = mergeEntries(base, delta, today);
  assert.equal(merged.entries.length, base.length, "no duplicate leg");
  assert.equal(merged.entries.find((e) => e.number === "XY 8").depart, "2026-10-14T23:15:00+01:00");
});
