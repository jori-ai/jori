// cruise-regate.test.mjs — pins "the plan flags follow the CURRENT plan".
//
// The upsert only re-flags sailings a run observed, so after the plan moved
// (one home city until 2026-11-15, the other from 11-16) the site still showed
// the second city's departures before 11-16 as plan matches under windows that no longer
// existed. regate recomputes every stored row.
//
// Run: node --test tests/cruise-regate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { gateTargets, regatePatches, sailingFromRow } from "../lib/cruise/regate.mjs";

const stale = {
  sailing_id: "royal:X_2026-11-08",
  is_match: true,
  is_reachable: true,
  matched_port: "Port One",
  matched_city: "Home One, XA",
  matched_window: "2026-10-29..2026-11-30",
  matched_window_assumed: false,
};
const current = {
  sailing_id: "royal:Y_2026-11-20",
  is_match: false,
  is_reachable: true,
  matched_port: "Port One",
  matched_city: "Home One, XA",
  matched_window: "2026-11-16..2026-12-31",
  matched_window_assumed: false,
};

test("a row that fell out of the plan is cleared", () => {
  const rows = [stale];
  const groups = regatePatches(rows, gateTargets(rows, { matches: [], reachable: [] }));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, [stale.sailing_id]);
  assert.equal(groups[0].fields.is_reachable, false);
  assert.equal(groups[0].fields.is_match, false);
  assert.equal(groups[0].fields.matched_window, null);
});

test("a row already matching the current plan is left alone", () => {
  const rows = [current];
  const reachable = [{ ...current }];
  assert.deepEqual(regatePatches(rows, gateTargets(rows, { matches: [], reachable })), []);
});

test("a row whose window moved gets the new window", () => {
  const rows = [{ ...current, matched_window: "2026-10-29..2026-12-31" }];
  const groups = regatePatches(rows, gateTargets(rows, { matches: [], reachable: [{ ...current }] }));
  assert.equal(groups[0].fields.matched_window, "2026-11-16..2026-12-31");
});

test("an unflagged row newly inside the plan is promoted, match included", () => {
  const fresh = { sailing_id: "ncl:Z_2026-11-05", is_match: false, is_reachable: false,
    matched_port: null, matched_city: null, matched_window: null, matched_window_assumed: false };
  const hit = { sailing_id: fresh.sailing_id, matched_port: "Port Two",
    matched_city: "Home Two, XB", matched_window: "2026-11-01..2026-11-15", matched_window_assumed: false };
  const groups = regatePatches([fresh], gateTargets([fresh], { matches: [hit], reachable: [hit] }));
  assert.equal(groups[0].fields.is_reachable, true);
  assert.equal(groups[0].fields.is_match, true);
  assert.equal(groups[0].fields.matched_city, "Home Two, XB");
});

test("stored numerics come back as numbers for the filter", () => {
  const s = sailingFromRow({ sailing_id: "a", nights: "7", lowest_balcony_per_person_usd: "899.5" });
  assert.equal(s.nights, 7);
  assert.equal(s.lowest_balcony_per_person_usd, 899.5);
});
