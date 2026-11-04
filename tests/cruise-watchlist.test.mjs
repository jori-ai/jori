// cruise-watchlist.test.mjs — the favourites-scoped weekly watch.
//
// The rule: watch the sailings the user starred, alert on a price drop of 10%
// or more or a new promotion, and send NOTHING in a week where nothing moved.
// That last clause is the one most worth a test — a watchlist that emails "no
// changes" every Monday is exactly what this replaced, and it is the failure
// mode a careless refactor reintroduces.
//
// Run: node --test tests/cruise-watchlist.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWatchlist, ALERT_DEFAULTS } from "../lib/cruise/alerts.mjs";

const RUN = "2026-09-07T13:00:00.000Z";
const TH = { ...ALERT_DEFAULTS };

const sailing = (id, over = {}) => ({
  sailing_id: id, ship_name: "Celebrity Reflection", per_person_per_night_usd: 150,
  promos: null, promos_changed_at: null, ...over,
});
const drop = (pct, usd, at = RUN) => ({ change_pct: pct, change_usd: usd, changed_at: at });

test("a 10% drop on a starred sailing is the alert", () => {
  const w = classifyWatchlist(["a"], new Map([["a", sailing("a")]]),
    new Map([["a", drop(-12, -60)]]), TH, RUN);
  assert.equal(w.drops.length, 1);
  assert.equal(w.any, true);
});

test("the $75 floor does NOT apply to a watchlist", () => {
  // classifyAlerts screens thousands of sailings and needs a dollar bar; a list
  // curated by hand does not. A 12% drop worth $40 on a short starred sailing
  // is exactly what the watchlist is for.
  const w = classifyWatchlist(["a"], new Map([["a", sailing("a")]]),
    new Map([["a", drop(-12, -40)]]), TH, RUN);
  assert.equal(w.drops.length, 1, "a small-dollar but >=10% drop still alerts");
});

test("under 10% is not news", () => {
  const w = classifyWatchlist(["a"], new Map([["a", sailing("a")]]),
    new Map([["a", drop(-9.4, -300)]]), TH, RUN);
  assert.equal(w.drops.length, 0);
  assert.equal(w.any, false, "a big-dollar 9% move stays quiet — 10% is the bar");
});

test("a rise is never an alert", () => {
  const w = classifyWatchlist(["a"], new Map([["a", sailing("a")]]),
    new Map([["a", drop(18, 200)]]), TH, RUN);
  assert.equal(w.any, false);
});

test("last week's drop does not re-send this week", () => {
  // The delta columns are sticky, so change_pct survives weeks after the move.
  // changed_at === runAt is the only freshness test.
  const w = classifyWatchlist(["a"], new Map([["a", sailing("a")]]),
    new Map([["a", drop(-30, -400, "2026-08-31T13:00:00.000Z")]]), TH, RUN);
  assert.equal(w.any, false, "a stale drop must not become a weekly recurring email");
});

test("a new promotion is news, a standing one is not", () => {
  const fresh = sailing("a", { promos: [{ code: "free-wifi-offer", label: "Wi-Fi Package" }], promos_changed_at: RUN });
  assert.equal(classifyWatchlist(["a"], new Map([["a", fresh]]), new Map(), TH, RUN).promos.length, 1);

  const standing = sailing("a", { promos: [{ code: "free-wifi-offer", label: "Wi-Fi Package" }], promos_changed_at: "2026-08-10T13:00:00.000Z" });
  assert.equal(classifyWatchlist(["a"], new Map([["a", standing]]), new Map(), TH, RUN).any, false);
});

test("a line that publishes no promotions is watched on price alone", () => {
  // royal and celebrity expose no promotion field at all — 68% of the corpus.
  const royal = sailing("a", { promos: null, promos_changed_at: null });
  const w = classifyWatchlist(["a"], new Map([["a", royal]]), new Map(), TH, RUN);
  assert.equal(w.any, false, "no promos must not read as a promo change");
});

test("a drop and a promo on one sailing reads as a drop, once", () => {
  const both = sailing("a", { promos: [{ code: "x", label: "x" }], promos_changed_at: RUN });
  const w = classifyWatchlist(["a"], new Map([["a", both]]), new Map([["a", drop(-15, -90)]]), TH, RUN);
  assert.equal(w.drops.length, 1);
  assert.equal(w.promos.length, 0, "one sailing, one section");
});

test("an unseen sailing is recorded but never sends an email", () => {
  // The row never leaves cruise_sailings — a cruise disappears only if the line
  // cancels it. All we observe is that a search did not return it this run, and
  // those sets churn. Reporting that as news would be mailing about our own
  // scrape's flakiness.
  const w = classifyWatchlist(["gone-1"], new Map(), new Map(), TH, RUN);
  assert.deepEqual(w.gone, [{ sailing_id: "gone-1", unseen_this_run: true }]);
  assert.equal(w.any, false, "an unseen sailing is not a reason to send anything");
});

test("nothing starred sends nothing", () => {
  const w = classifyWatchlist([], new Map([["a", sailing("a")]]), new Map([["a", drop(-40, -900)]]), TH, RUN);
  assert.equal(w.any, false, "an empty watchlist must not fall back to alerting on everything");
});

test("a quiet week sends nothing at all", () => {
  const w = classifyWatchlist(["a", "b"],
    new Map([["a", sailing("a")], ["b", sailing("b")]]),
    new Map([["a", drop(-2, -10)], ["b", drop(1, 5)]]), TH, RUN);
  assert.equal(w.any, false);
  assert.deepEqual([w.drops.length, w.promos.length, w.gone.length], [0, 0, 0]);
});

test("a line this run did not scrape cannot be called unseen", () => {
  // Observed live on 2026-09-01: `cruise-watch --lines princess` reported all
  // 12 starred sailings as "no longer offered", because Royal and Celebrity
  // were simply not looked at. That email would have been alarming and wrong.
  const stars = ["royal:abc", "princess:xyz"];
  const w = classifyWatchlist(stars, new Map(), new Map(), TH, RUN, new Set(["princess"]));
  assert.deepEqual(w.gone, [{ sailing_id: "princess:xyz", unseen_this_run: true }],
    "only the line we actually scraped");
  assert.equal(w.any, false, "and even that is informational, never an email");
});

test("a line that WAS scraped still records the sailing as unseen", () => {
  // A full run passes every line, so the guard must not suppress real losses.
  const w = classifyWatchlist(["royal:abc"], new Map(), new Map(), TH, RUN, new Set(["royal", "celebrity"]));
  assert.deepEqual(w.gone, [{ sailing_id: "royal:abc", unseen_this_run: true }]);
});

test("one missed run is not a disappearance", () => {
  // Celebrity Ascent 2027-04-19 was returned by Celebrity at 03:58 on
  // 2026-09-01, missing at 15:46, and on CruiseFeed the whole time at the same
  // $2,419. A line's result set is not stable between runs, so the watchlist
  // must not call a single absence "no longer offered". classifyWatchlist still
  // reports the raw absence; cruise-watch requires 3 consecutive misses before
  // it says anything, which is the behaviour this pins.
  const w = classifyWatchlist(["celebrity:AT14T258"], new Map(), new Map(), TH, RUN, new Set(["celebrity"]));
  assert.equal(w.gone.length, 1, "the raw signal is still produced...");

  // ...and the caller's consecutive-miss gate is what suppresses it.
  const GONE_AFTER_MISSES = 3;
  const gate = (misses) => w.gone.filter((g) => (misses[g.sailing_id] || 0) >= GONE_AFTER_MISSES);
  assert.deepEqual(gate({ "celebrity:AT14T258": 1 }), [], "one miss says nothing");
  assert.deepEqual(gate({ "celebrity:AT14T258": 2 }), [], "two still says nothing");
  assert.equal(gate({ "celebrity:AT14T258": 3 }).length, 1, "three consecutive misses is a real loss");
});

// ---- A star or a rating outranks the built-year floor ---------------------
// Requirement: a star or a member rating of 4.0+ outranks the ship-age floor.
// The floor is a proxy for "will we enjoy this ship"; a star and a member
// rating are direct evidence about that same question, so where they exist the
// proxy yields. Without it an old starred ship stayed off the reachable list.
//
// Synthetic config and catalogs: a line floor of after-2016, one port, one
// ship built 2009.

import { applyFilters } from "../lib/cruise/filter.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = mkdtempSync(join(tmpdir(), "cruise-watchlist-"));
mkdirSync(join(FIX, "local", "config"), { recursive: true });
mkdirSync(join(FIX, "data"), { recursive: true });
writeFileSync(join(FIX, "local", "config", "cruise-watch.json"), JSON.stringify({
  filters: { default: { built_after_year: 2016 }, lines: { royal: { built_after_year: 2016 } } },
}));
writeFileSync(join(FIX, "data", "cruise-ports.json"), JSON.stringify({ ports: [
  { port: "Port Alpha", codes: ["PAA"], name_aliases: ["Alpha"], city_aliases: ["Alpha City, XA"], lat: 10, lon: 10 },
] }));
writeFileSync(join(FIX, "data", "cruise-ships.json"), JSON.stringify({ ships: {
  royal: [{ name: "Oasis of the Seas", built_year: 2009 }],
} }));
process.env.JORI_LOCAL_DIR = join(FIX, "local");
process.env.JORI_CRUISE_DATA_DIR = join(FIX, "data");

const WINDOWS = [{ city: "Alpha City, XA", start: "2026-09-01", end: "2028-12-31" }];
const oldShip = (over = {}) => ({
  source: "royal", sailing_id: "royal:old-1", ship_name: "Oasis of the Seas",
  departure_port: "Alpha", departure_port_code: "PAA", depart_date: "2027-06-15",
  nights: 7, lowest_balcony_per_person_usd: 900, ...over,
});

test("an old ship is dropped when nothing vouches for it", async () => {
  const r = await applyFilters([oldShip()], WINDOWS, new Set(), { favorites: new Set(), ratings: new Map() });
  assert.equal(r.dropped.ship_too_old, 1);
  assert.equal(r.reachable.length, 0);
});

test("a star keeps an old ship", async () => {
  const r = await applyFilters([oldShip()], WINDOWS, new Set(),
    { favorites: new Set(["royal:old-1"]), ratings: new Map() });
  assert.equal(r.reachable.length, 1);
  assert.equal(r.reachable[0].age_override, "starred");
});

test("a 4.0+ rating keeps an old ship", async () => {
  const r = await applyFilters([oldShip()], WINDOWS, new Set(),
    { favorites: new Set(), ratings: new Map([["oasis of the seas", 4.1]]) });
  assert.equal(r.reachable.length, 1);
  assert.equal(r.reachable[0].age_override, "rating");
});

test("exactly 4.0 counts — ratings land on one decimal", async () => {
  const r = await applyFilters([oldShip()], WINDOWS, new Set(),
    { favorites: new Set(), ratings: new Map([["oasis of the seas", 4.0]]) });
  assert.equal(r.reachable.length, 1);
});

test("a poorly-rated old ship stays out", async () => {
  const r = await applyFilters([oldShip()], WINDOWS, new Set(),
    { favorites: new Set(), ratings: new Map([["oasis of the seas", 3.6]]) });
  assert.equal(r.dropped.ship_too_old, 1);
});
