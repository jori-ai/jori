// cruise-cruisefeed.test.mjs — mapping CruiseFeed's schema onto ours.
//
// CruiseFeed became the PRIMARY source on 2026-09-01, with the per-line
// scrapers demoted to verification. The mapping is the whole integration, and
// none of it can be exercised against the live API until a key exists — so the
// fixtures here are built from their published OpenAPI spec (v1.12.0) and their
// own documented coverage notes, and they pin the decisions that are easy to
// get quietly wrong.
//
// Run: node --test tests/cruise-cruisefeed.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { toSailing, balconyFare, portsOfCall, lineKeyFor } from "../lib/cruise/cruisefeed.mjs";

const record = (over = {}) => ({
  id: "rec_1",
  sailing_id: "sail_abc",
  cruise_line: "Royal Caribbean",
  ship_name: "Harmony of the Seas",
  departure_date: "2027-03-14",
  return_date: "2027-03-21",
  nights: 7,
  round_trip: true,
  embark_port: "Galveston",
  disembark_port: "Galveston",
  price_amount: 1200,
  price_currency: "USD",
  fares: [
    { cabin_class: "Interior", cabin_category: "interior", price_amount: 700, available: true },
    { cabin_class: "Ocean View Balcony", cabin_category: "balcony", price_amount: 1400, available: true },
    { cabin_class: "Junior Suite", cabin_category: "suite", price_amount: 2600, available: true },
  ],
  itinerary: [
    { seq: 1, port: "Galveston, Texas", is_embark: true },
    { seq: 2, port: null, is_sea_day: true },
    { seq: 3, port: "Roatan, Honduras", port_code: "RTB" },
    { seq: 4, port: "Cozumel, Mexico" },
    { seq: 5, port: "Galveston, Texas", is_disembark: true },
  ],
  booking_url: "https://example.com/book",
  ...over,
});

test("a record becomes a sailing in our shape", () => {
  const s = toSailing(record());
  assert.equal(s.source, "royal", "their display name maps to our extractor key");
  assert.equal(s.sailing_id, "cf:sail_abc", "namespaced so it cannot collide with a scraped id");
  assert.equal(s.lowest_balcony_per_person_usd, 1400);
  assert.equal(s.nights, 7);
  assert.equal(s.departure_port, "Galveston");
  assert.equal(s.disembark_port, "Galveston");
  assert.equal(s.data_source, "cruisefeed");
  assert.deepEqual(s.ports_of_call.map((p) => p.name), ["Roatan", "Cozumel"]);
});

test("the balcony fare is chosen by their normalized category, not the line's wording", () => {
  // The whole point of cabin_category: Virgin calls it "Sea Terrace" and
  // Princess "Veranda", and both bucket as balcony on their side.
  assert.equal(balconyFare({ fares: [{ cabin_class: "Sea Terrace", cabin_category: "balcony", price_amount: 900 }] }), 900);
  assert.equal(balconyFare({ fares: [{ cabin_class: "Veranda", cabin_category: "balcony", price_amount: 800 }] }), 800);
});

test("the cheapest balcony wins, and an unsellable one is skipped", () => {
  const f = { fares: [
    { cabin_category: "balcony", price_amount: 1400, available: true },
    { cabin_category: "balcony", price_amount: 1100, available: true },
    { cabin_category: "balcony", price_amount: 300,  available: false },
  ] };
  assert.equal(balconyFare(f), 1100, "available:false is shown but not sold");
});

test("available:null is not a reason to discard a fare", () => {
  // Three-valued on their side: null means "this source does not report
  // availability", which is most of them.
  assert.equal(balconyFare({ fares: [{ cabin_category: "balcony", price_amount: 950, available: null }] }), 950);
});

test("no balcony fare yields null, never a substitute", () => {
  const s = toSailing(record({ fares: [{ cabin_class: "Interior", cabin_category: "interior", price_amount: 700 }] }));
  assert.equal(s.lowest_balcony_per_person_usd, null, "an interior fare must never stand in for a balcony");
});

test("ports of call drop the ends and the sea days, ordered by seq", () => {
  // `day_number` is null on about half of all stops, so `seq` is the only safe
  // ordering key — sorting by day_number would scramble the list.
  const out = portsOfCall({ itinerary: [
    { seq: 4, port: "Cozumel", day_number: null },
    { seq: 1, port: "Galveston", is_embark: true },
    { seq: 3, port: "Roatan", day_number: 3 },
    { seq: 5, port: "Galveston", is_disembark: true },
    { seq: 2, port: null, is_sea_day: true },
  ] });
  assert.deepEqual(out.map((p) => p.name), ["Roatan", "Cozumel"]);
});

test("a one-way sailing keeps the port it actually ends in", () => {
  const s = toSailing(record({ round_trip: false, embark_port: "Galveston", disembark_port: "Barcelona" }));
  assert.equal(s.departure_port, "Galveston");
  assert.equal(s.disembark_port, "Barcelona");
});

test("a round trip with no disembark port falls back to where it started", () => {
  // round_trip is the one field they guarantee on every row, so it can carry
  // this; disembark_port is 98.6% and the gap has to land somewhere sane.
  const s = toSailing(record({ round_trip: true, disembark_port: null }));
  assert.equal(s.disembark_port, "Galveston");
});

test("taxes are left unknown rather than assumed", () => {
  // taxes_and_fees is populated on 16% of their rows; neither true nor false is
  // supportable across the corpus.
  assert.equal(toSailing(record()).taxes_fees_included, null);
});

test("promotions are null — they carry none at any tier", () => {
  assert.equal(toSailing(record()).promos, null,
    "promos come from the line's own site, for starred sailings only");
});

test("line names map to our keys, and an unknown line still gets a stable slug", () => {
  assert.equal(lineKeyFor("Celebrity Cruises"), "celebrity");
  assert.equal(lineKeyFor("Holland America Line"), "holland");
  assert.equal(lineKeyFor("Princess Cruises"), "princess");
  assert.equal(lineKeyFor("Virgin Voyages"), "virgin");
  assert.equal(lineKeyFor("Disney Cruise Line"), "disney-cruise-line", "a line we do not scrape is still usable");
  assert.equal(lineKeyFor(""), "unknown");
});

test("a record missing what we cannot do without is dropped, not patched", () => {
  for (const missing of [{ departure_date: null }, { ship_name: null }, { embark_port: null }, { nights: null }]) {
    assert.equal(toSailing(record(missing)), null, JSON.stringify(missing));
  }
});

// ---- Plan windows and the budget ------------------------------------------
// The travel plan is a month-by-month list, so four consecutive months in one city
// describe ONE continuous stay. On a per-result budget, querying each window
// separately pays for the same sailings four times. Merging is what took a full
// pull from 3,343 results (over the 2,000/month grant) to 825.

import { mergeWindows } from "../lib/cruise/cruisefeed.mjs";

test("consecutive plan months collapse into one range", () => {
  const merged = mergeWindows([
    { city: "Galveston, TX", start: "2026-12-01", end: "2026-12-31" },
    { city: "Galveston, TX", start: "2027-01-01", end: "2027-01-31" },
    { city: "Galveston, TX", start: "2027-02-01", end: "2027-02-28" },
    { city: "Galveston, TX", start: "2027-03-01", end: "2027-03-15" },
  ]);
  assert.deepEqual(merged, [{ start: "2026-12-01", end: "2027-03-15" }],
    "a plan that ends on the 31st and resumes on the 1st is not a real gap");
});

test("a genuine gap stays two ranges", () => {
  const merged = mergeWindows([
    { start: "2026-10-29", end: "2026-11-30" },
    { start: "2027-03-01", end: "2027-03-15" },
  ]);
  assert.equal(merged.length, 2);
});

test("out-of-order and overlapping windows still merge correctly", () => {
  const merged = mergeWindows([
    { start: "2027-01-10", end: "2027-01-20" },
    { start: "2026-12-01", end: "2027-01-15" },
  ]);
  assert.deepEqual(merged, [{ start: "2026-12-01", end: "2027-01-20" }]);
});

test("malformed or inverted windows are dropped, not guessed at", () => {
  const merged = mergeWindows([
    { start: "not-a-date", end: "2027-01-01" },
    { start: "2027-02-01", end: "2027-01-01" },
    { start: null, end: null },
    { start: "2027-05-01", end: "2027-05-10" },
  ]);
  assert.deepEqual(merged, [{ start: "2027-05-01", end: "2027-05-10" }]);
});
