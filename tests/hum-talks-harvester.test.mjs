// hum-talks-harvester.test.mjs — unit tests for talks.mjs's pickTopEvent(),
// the geo-gating selection logic. Covers 2026-10-04: an undated
// venue-anchored event (fixed home-city venue, no single scheduled date) used
// to bypass geo-gating entirely and could re-surface while the user is away
// (e.g. abroad). pickTopEvent() now gates undated events against "today"
// instead of letting them pass unconditionally, while still respecting the
// same gateCap spend budget shared with dated events.
//
// Run: node --test tests/hum-talks-harvester.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTopEvent, seenEvents } from "../agent/scripts/hum-harvesters/talks.mjs";

const TODAY = "2026-10-06";

function fakeGate(awaySet) {
  // awaySet: Set of date strings where the user is NOT in the home metro.
  const calls = [];
  const fn = (metro, dateStr) => {
    calls.push(dateStr);
    return { suppress: awaySet.has(dateStr) };
  };
  fn.calls = calls;
  return fn;
}

test("pickTopEvent: undated event is gated against today, not bypassed", () => {
  const candidates = [{ id: "met-1", title: "Met undated series" }]; // no date field
  const geoGateFn = fakeGate(new Set([TODAY])); // the user is away today (e.g. abroad)
  const top = pickTopEvent(candidates, { geoGateFn, todayStr: TODAY });
  assert.equal(top, null, "undated event must be suppressed when away today");
  assert.deepEqual(geoGateFn.calls, [TODAY], "undated event must be checked against today's date");
});

test("pickTopEvent: undated event surfaces when the user is home today", () => {
  const candidates = [{ id: "met-1", title: "Met undated series" }];
  const geoGateFn = fakeGate(new Set()); // nobody away
  const top = pickTopEvent(candidates, { geoGateFn, todayStr: TODAY });
  assert.equal(top.id, "met-1");
  assert.deepEqual(geoGateFn.calls, [TODAY]);
});

test("pickTopEvent: dated event still gates on its own date, not today", () => {
  const candidates = [{ id: "ev-1", title: "Dated talk", date: "2026-12-25" }];
  const geoGateFn = fakeGate(new Set([TODAY])); // away today, but event is in December
  const top = pickTopEvent(candidates, { geoGateFn, todayStr: TODAY });
  assert.equal(top.id, "ev-1");
  assert.deepEqual(geoGateFn.calls, ["2026-12-25"]);
});

test("pickTopEvent: falls through a gated dated event to an undated one, still gated", () => {
  const candidates = [
    { id: "dated-away", date: "2026-10-10" },
    { id: "undated-anchored" },
  ];
  const geoGateFn = fakeGate(new Set(["2026-10-10", TODAY])); // both away
  const top = pickTopEvent(candidates, { geoGateFn, todayStr: TODAY });
  assert.equal(top, null);
  assert.deepEqual(geoGateFn.calls, ["2026-10-10", TODAY]);
});

test("pickTopEvent: falls through a gated dated event to an undated one that is reachable", () => {
  const candidates = [
    { id: "dated-away", date: "2026-10-10" },
    { id: "undated-anchored" },
  ];
  const geoGateFn = fakeGate(new Set(["2026-10-10"])); // dated one away, today is fine
  const top = pickTopEvent(candidates, { geoGateFn, todayStr: TODAY });
  assert.equal(top.id, "undated-anchored");
});

test("pickTopEvent: gateCap is shared across dated and undated events (no extra budget for undated)", () => {
  const candidates = [
    { id: "d1", date: "2026-10-07" },
    { id: "d2", date: "2026-10-08" },
    { id: "undated" }, // would be checked 3rd, but cap is 2
  ];
  const geoGateFn = fakeGate(new Set(["2026-10-07", "2026-10-08"])); // both dated away
  const top = pickTopEvent(candidates, { geoGateFn, todayStr: TODAY, gateCap: 2 });
  assert.equal(top, null, "undated event must not be checked once the shared cap is spent");
  assert.deepEqual(geoGateFn.calls, ["2026-10-07", "2026-10-08"]);
});

test("pickTopEvent: returns null for an empty candidate list", () => {
  const geoGateFn = fakeGate(new Set());
  const top = pickTopEvent([], { geoGateFn, todayStr: TODAY });
  assert.equal(top, null);
  assert.deepEqual(geoGateFn.calls, []);
});

test("seenEvents: a venue-watch lane's entries float by key; ones it did not surface do not", () => {
  const states = [
    { seen: [{ id: "old-1", title: "Playbook-written talk", date: "2026-11-01" }] },
    { seen: [
      { key: "series-night|hall-a|2026-11-05", title: "Series Night", date: "2026-11-05", surfaced: true },
      { key: "routine-night|hall-a|2026-11-06", title: "Routine Night", date: "2026-11-06", surfaced: false },
    ] },
    {},
  ];
  const evs = seenEvents(states);
  assert.deepEqual(evs.map((e) => e.id), ["old-1", "series-night|hall-a|2026-11-05"]);
});
