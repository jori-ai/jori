// cruise-price-alerts.test.mjs — pins the rule that decides what the weekly
// cruise email is allowed to say.
//
// On 2026-08-31 the email stopped being a digest of every matching sailing
// ("should only alert me on significant price drops - not all cruises") and
// the full list moved to the browsing site. Two failure modes are worth a test:
// re-sending last week's drop every Monday until the price moves again, and
// letting a $12 weekly wobble through as news. Both are one comparison away
// from being wrong, so both are pinned here.
//
// Run: node --test tests/cruise-price-alerts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAlerts, isSignificantDrop, ALERT_DEFAULTS } from "../lib/cruise/alerts.mjs";

const RUN_AT = "2026-08-31T13:00:00.000Z";
const LAST_WEEK = "2026-08-24T13:00:00.000Z";
const T = ALERT_DEFAULTS;

function match(id, pppn = 100) {
  return { sailing_id: id, ship_name: "Test Ship", per_person_per_night_usd: pppn, nights: 5 };
}
function event(id, over = {}) {
  return {
    sailing_id: id,
    current: 500,
    prev: 600,
    change_usd: -100,
    change_pct: -16.67,
    changed_at: RUN_AT,
    is_new: false,
    is_all_time_low: false,
    lowest_ever: 500,
    ...over,
  };
}
function classify(pairs) {
  const matches = pairs.map(([m]) => m);
  const events = new Map(pairs.map(([m, e]) => [m.sailing_id, e]));
  return classifyAlerts(matches, events, T, RUN_AT);
}

test("a drop clearing both bars alerts", () => {
  const { price_drops } = classify([[match("a"), event("a")]]);
  assert.equal(price_drops.length, 1);
  assert.equal(price_drops[0].sailing_id, "a");
});

test("both bars are required — either one alone stays silent", () => {
  // -5% but a big dollar figure: a rounding change on an expensive fare.
  assert.equal(isSignificantDrop({ change_usd: -100, change_pct: -5 }, T), false);
  // -20% but small dollars: a wobble on a cheap short sailing.
  assert.equal(isSignificantDrop({ change_usd: -40, change_pct: -20 }, T), false);
  assert.equal(isSignificantDrop({ change_usd: -100, change_pct: -20 }, T), true);
});

test("a price RISE is never a drop, however large", () => {
  assert.equal(isSignificantDrop({ change_usd: 300, change_pct: 40 }, T), false);
  const { price_drops } = classify([[match("a"), event("a", { change_usd: 300, change_pct: 40 })]]);
  assert.equal(price_drops.length, 0);
});

test("last week's drop does not re-send this week", () => {
  // The delta columns are sticky: they still describe a -16% move, but it was
  // observed on the PREVIOUS run. Only changed_at === run_at is new.
  const { price_drops } = classify([[match("a"), event("a", { changed_at: LAST_WEEK })]]);
  assert.equal(price_drops.length, 0);
});

test("first-seen inventory alerts only when exceptionally cheap", () => {
  const cheap = classify([[match("a", 70), event("a", { is_new: true, prev: null, change_usd: null, change_pct: null, changed_at: null })]]);
  assert.equal(cheap.new_deals.length, 1);
  assert.equal(cheap.price_drops.length, 0, "no prior price means no drop");

  // Passes the $120 plan filter but is not itself news.
  const ordinary = classify([[match("b", 110), event("b", { is_new: true, prev: null, change_usd: null, change_pct: null, changed_at: null })]]);
  assert.equal(ordinary.new_deals.length, 0);
});

test("an all-time low reached by small steps still alerts", () => {
  // -$30 on a $530 fare clears neither bar, but it is the cheapest ever seen.
  const ev = event("a", { current: 500, prev: 530, change_usd: -30, change_pct: -5.66, is_all_time_low: true });
  const { price_drops, all_time_lows } = classify([[match("a"), ev]]);
  assert.equal(price_drops.length, 0);
  assert.equal(all_time_lows.length, 1);
});

test("a sailing appears in one section only", () => {
  // A big drop that is also an all-time low reads as a drop, not both.
  const ev = event("a", { is_all_time_low: true });
  const { price_drops, all_time_lows } = classify([[match("a"), ev]]);
  assert.equal(price_drops.length, 1);
  assert.equal(all_time_lows.length, 0);
});

test("a stale all-time low does not re-send either", () => {
  const ev = event("a", { current: 500, prev: 530, change_usd: -30, change_pct: -5.66, is_all_time_low: true, changed_at: LAST_WEEK });
  const { all_time_lows } = classify([[match("a"), ev]]);
  assert.equal(all_time_lows.length, 0);
});

test("a match with no price event is ignored rather than crashing", () => {
  const out = classifyAlerts([match("ghost")], new Map(), T, RUN_AT);
  assert.deepEqual(out, { price_drops: [], new_deals: [], all_time_lows: [] });
});

test("drops are ordered steepest first", () => {
  const out = classify([
    [match("small"), event("small", { current: 500, prev: 600, change_usd: -100, change_pct: -16.67 })],
    [match("big"), event("big", { current: 400, prev: 700, change_usd: -300, change_pct: -42.86 })],
  ]);
  assert.deepEqual(out.price_drops.map((d) => d.sailing_id), ["big", "small"]);
});
