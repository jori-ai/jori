// cruise-site-encoding.test.mjs — round-trips the cruise site's wire format.
//
// The site hands the browser all ~6,800 future sailings in one payload so that
// filtering, sorting and search are instant. That only fits because rows are
// POSITIONAL tuples against shared string dictionaries (the cruise app's lib/
// sailing-row.ts), which buys ~66% but makes column order load-bearing: add a
// field to the encoder and forget the decoder and every field after it shifts
// by one — no type error, no throw, just a page quietly showing the wrong
// ship's price. This test is the thing that makes that mistake loud.
//
// Node strips the TypeScript types natively; no build step.
//
// Run: node --test tests/cruise-site-encoding.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

// The cruise app: apps/cruises once the sites have moved, web/cruises before.
const APP = ["apps/cruises", "web/cruises"].map((d) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", d))
  .find((d) => existsSync(path.join(d, "package.json")));
const MOD = path.join(APP, "lib/sailing-row.ts");
const { SailingEncoder, decodeSailings, ROW, lineLabel } = await import(MOD);

/** A row shaped exactly like a cruise_sailings select. */
function dbRow(over = {}) {
  return {
    sailing_id: "celebrity:RF4BH330_2026-12-07",
    source: "celebrity",
    ship_name: "Celebrity Reflection",
    ship_built_year: 2012,
    departure_port: "Galveston",
    depart_date: "2026-12-07",
    return_date: "2026-12-11",
    nights: 4,
    lowest_balcony_per_person_usd: 507.09,
    per_person_per_night_usd: 126.77,
    taxes_fees_included: true,
    is_match: true,
    matched_city: "Galveston, TX",
    price_change_pct: -18.5,
    price_change_usd: -115.2,
    prev_balcony_per_person_usd: 622.29,
    price_changed_at: "2026-08-31T13:28:04.808+00:00",
    is_all_time_low: true,
    ports_of_call: [{ code: "RTB", name: "Roatan, Honduras" }, { code: "PCC", name: "Perfect Day CocoCay" }],
    ports_ordered: true,
    disembark_port: "Galveston",
    booking_url: "https://www.celebritycruises.com/booking/RF4BH330",
    last_run_at: "2026-08-31T13:28:04.808+00:00",
    ...over,
  };
}

function roundTrip(rows, photos) {
  const enc = new SailingEncoder();
  if (photos) enc.setShipPhotos(photos);
  for (const r of rows) enc.add(r);
  return decodeSailings(enc.finish(false));
}

test("every field survives the round trip", () => {
  const r = dbRow();
  const [s] = roundTrip([r]);
  assert.equal(s.id, r.sailing_id);
  assert.equal(s.line, r.source);
  assert.equal(s.ship, r.ship_name);
  assert.equal(s.built, r.ship_built_year);
  assert.equal(s.port, r.departure_port);
  assert.equal(s.depart, r.depart_date);
  assert.equal(s.ret, r.return_date);
  assert.equal(s.nights, r.nights);
  assert.equal(s.price, r.lowest_balcony_per_person_usd);
  assert.equal(s.pppn, r.per_person_per_night_usd);
  assert.equal(s.taxIncl, true);
  assert.equal(s.isMatch, true);
  assert.equal(s.city, r.matched_city);
  assert.equal(s.changePct, r.price_change_pct);
  assert.equal(s.changeUsd, r.price_change_usd);
  assert.equal(s.prevPrice, r.prev_balcony_per_person_usd);
  assert.equal(s.changedAt, "2026-08-31");
  assert.equal(s.atl, true);
  assert.equal(s.book, r.booking_url);
});

test("return date is stored, not derived from nights", () => {
  // 3.5% of sailings have return_date != depart_date + nights. Deriving it
  // would silently mis-date every one of them.
  const [s] = roundTrip([dbRow({ nights: 4, return_date: "2026-12-12" })]);
  assert.equal(s.ret, "2026-12-12");
});

test("nulls stay null rather than becoming zero", () => {
  // Number(null) is 0, which would render a $0 fare and a year-0 ship.
  const [s] = roundTrip([
    dbRow({
      ship_built_year: null,
      matched_city: null,
      price_change_pct: null,
      price_change_usd: null,
      prev_balcony_per_person_usd: null,
      price_changed_at: null,
      booking_url: null,
      taxes_fees_included: null,
    }),
  ]);
  assert.equal(s.built, null);
  assert.equal(s.city, null);
  assert.equal(s.changePct, null);
  assert.equal(s.changeUsd, null);
  assert.equal(s.prevPrice, null);
  assert.equal(s.changedAt, null);
  assert.equal(s.hero, null, "no photo for this ship");
  assert.equal(s.book, null);
  assert.equal(s.taxIncl, null, "unknown must not collapse to false");
});

test("taxes_fees_included distinguishes false from unknown", () => {
  const [f] = roundTrip([dbRow({ taxes_fees_included: false })]);
  assert.equal(f.taxIncl, false);
});

test("unusable rows are dropped, not encoded as garbage", () => {
  const enc = new SailingEncoder();
  assert.equal(enc.add(dbRow({ lowest_balcony_per_person_usd: null })), false);
  assert.equal(enc.add(dbRow({ depart_date: null })), false);
  assert.equal(enc.add(dbRow({ nights: null })), false);
  assert.equal(enc.add(dbRow()), true);
  assert.equal(enc.finish(false).total, 1);
});

test("dictionaries dedupe and every row still resolves its own strings", () => {
  const rows = [
    dbRow({ sailing_id: "a", ship_name: "Ship A", departure_port: "Seattle", source: "royal" }),
    dbRow({ sailing_id: "b", ship_name: "Ship B", departure_port: "Seattle", source: "royal" }),
    dbRow({ sailing_id: "c", ship_name: "Ship A", departure_port: "Barcelona", source: "msc" }),
  ];
  const enc = new SailingEncoder();
  for (const r of rows) enc.add(r);
  const ix = enc.finish(false);
  assert.deepEqual(ix.ships, ["Ship A", "Ship B"], "repeat ship interned once");
  assert.deepEqual(ix.ports, ["Seattle", "Barcelona"]);
  assert.deepEqual(ix.lines, ["royal", "msc"]);

  const out = decodeSailings(ix);
  assert.deepEqual(out.map((s) => s.ship), ["Ship A", "Ship B", "Ship A"]);
  assert.deepEqual(out.map((s) => s.port), ["Seattle", "Seattle", "Barcelona"]);
});

test("per-night price is computed when the DB has none", () => {
  const [s] = roundTrip([dbRow({ per_person_per_night_usd: null, lowest_balcony_per_person_usd: 500, nights: 4 })]);
  assert.equal(s.pppn, 125);
});

test("lastRunAt is the newest run seen, not the last row's", () => {
  const enc = new SailingEncoder();
  enc.add(dbRow({ sailing_id: "a", last_run_at: "2026-08-31T13:00:00.000Z" }));
  enc.add(dbRow({ sailing_id: "b", last_run_at: "2026-08-24T13:00:00.000Z" }));
  assert.equal(enc.finish(false).lastRunAt, "2026-08-31T13:00:00.000Z");
});

test("ROW indexes are unique and contiguous", () => {
  // The one invariant a positional layout actually needs: no two fields share a
  // slot, and no slot is skipped.
  const idx = Object.values(ROW).sort((a, b) => a - b);
  assert.deepEqual(idx, idx.map((_, i) => i));
});

test("line keys render as the names on the booking sites", () => {
  assert.equal(lineLabel("ncl"), "Norwegian");
  assert.equal(lineLabel("unknown-line"), "unknown-line", "an unmapped key falls back to itself");
});

test("a ship's photo reaches every one of its sailings", () => {
  // The photo rides the SHIP dictionary, not a per-row column — 79 entries
  // instead of 710, and one fewer field per row. The alignment between
  // `ships[i]` and `shipPhotos[i]` is what makes that work, and nothing but
  // this test would notice it slipping.
  const photos = new Map([["celebrity reflection", "https://cdn/reflection.jpg"]]);
  const out = roundTrip(
    [
      dbRow({ sailing_id: "a", ship_name: "Celebrity Reflection" }),
      dbRow({ sailing_id: "b", ship_name: "Celebrity Reflection", depart_date: "2027-01-04", return_date: "2027-01-08" }),
      dbRow({ sailing_id: "c", ship_name: "Celebrity Summit" }),
    ],
    photos,
  );
  assert.equal(out[0].hero, "https://cdn/reflection.jpg");
  assert.equal(out[1].hero, "https://cdn/reflection.jpg", "second sailing of the same ship");
  assert.equal(out[2].hero, null, "a ship with no photo stays null, not the previous ship's");
});

test("shipPhotos stays index-aligned with ships", () => {
  const photos = new Map([["ship b", "https://cdn/b.jpg"]]);
  const enc = new SailingEncoder();
  enc.setShipPhotos(photos);
  enc.add(dbRow({ sailing_id: "a", ship_name: "Ship A" }));
  enc.add(dbRow({ sailing_id: "b", ship_name: "Ship B" }));
  enc.add(dbRow({ sailing_id: "c", ship_name: "Ship C" }));
  const ix = enc.finish(false);
  assert.equal(ix.shipPhotos.length, ix.ships.length);
  assert.deepEqual(ix.ships, ["Ship A", "Ship B", "Ship C"]);
  assert.deepEqual(ix.shipPhotos, [null, "https://cdn/b.jpg", null]);
});

// ---- Itinerary ports and the one-way flag -------------------------
// Added 2026-09-01 with the ports_of_call column. The repositioning flag is
// DERIVED at decode time from two normalized names, so it is exactly the kind
// of thing that silently inverts; these pin both directions.

test("ports of call round-trip, normalized and deduped", () => {
  const [out] = roundTrip([dbRow({
    ports_of_call: [
      { code: "RTB", name: "Roatan, Honduras" },
      { code: "RTB", name: "Roatan" },          // same port, another call day
      { code: "CZM", name: "Cozumel, Mexico" },
    ],
  })]);
  assert.deepEqual(out.calls, ["Roatan", "Cozumel"], "collapsed to canonical names, once each");
  assert.equal(out.callsOrdered, true);
});

test("a round trip is not one-way", () => {
  const [out] = roundTrip([dbRow({
    departure_port: "Galveston",
    disembark_port: "Galveston",
  })]);
  assert.equal(out.oneWay, false);
  assert.equal(out.disembark, "Galveston");
});

test("ending in another port IS one-way", () => {
  const [out] = roundTrip([dbRow({
    departure_port: "Galveston",
    disembark_port: "Barcelona, Spain",
  })]);
  assert.equal(out.oneWay, true);
  assert.equal(out.disembark, "Barcelona");
});

test("the same port spelled two ways is still a round trip", () => {
  // normalizePort collapses both sides before they are compared; without that
  // every Rome sailing would wear a Repositioning badge.
  const [out] = roundTrip([dbRow({
    departure_port: "Rome (Civitavecchia)",
    disembark_port: "Rome",
  })]);
  assert.equal(out.oneWay, false);
});

test("no disembarkation port makes no one-way claim", () => {
  const [out] = roundTrip([dbRow({ disembark_port: null, ports_of_call: null })]);
  assert.equal(out.oneWay, false);
  assert.equal(out.disembark, null);
  assert.deepEqual(out.calls, []);
});

test("an unordered line is flagged as a set, not a sequence", () => {
  const [out] = roundTrip([dbRow({ ports_ordered: false })]);
  assert.equal(out.callsOrdered, false, "Holland gives ports with no sailed order");
});

test("call ports do not leak into the departure-port filter dictionary", () => {
  const enc = new SailingEncoder();
  enc.add(dbRow({ departure_port: "Seattle", ports_of_call: [{ code: "PCC", name: "Perfect Day CocoCay" }] }));
  const ix = enc.finish(false);
  assert.deepEqual(ix.ports, ["Seattle"], "the port filter stays drivable-from ports only");
  assert.ok(ix.callPorts.includes("Perfect Day CocoCay"));
});

// ---- Price age is DISCLOSED, not acted on -------------------------------
// A 6-hour per-sweep staleness filter briefly hid rows the lines had stopped
// returning. It was removed the same day: a line's search set churns, and it
// would have hidden Celebrity Ascent 2027-04-19 — starred, bookable, and
// quoted at the same $2,419 on CruiseFeed throughout. The site always uses its own
// database, not just the most recent scrape: the row now
// always shows; `lastSeen` is what lets the card say how old the price is.

test("lastSeen round-trips so a card can date its price", () => {
  const [out] = roundTrip([dbRow({ last_seen_at: "2026-08-14T13:00:00.000Z" })]);
  assert.equal(out.lastSeen, "2026-08-14");
});

test("a row that has never been dated says so rather than guessing", () => {
  const [out] = roundTrip([dbRow({ last_seen_at: null })]);
  assert.equal(out.lastSeen, null);
});

