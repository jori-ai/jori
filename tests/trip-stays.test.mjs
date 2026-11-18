// trip-stays.test.mjs — the travel timeline resolved into stays, and the
// location ribbon the travel-guide site builds from them (lib/trip-stays.mjs).
//
// Synthetic trip (no real itinerary in a public repo): a coarse flights row per
// destination with the real legs as manual rows inside it, a city visited twice
// around another, a multi-stop loop that returns to its gateway, layovers, and
// an open-ended return home.
//
// Run: node --test tests/trip-stays.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStays, guideFor, prettyMetro, ribbonItems, focusItem, landingArea } from "../lib/trip-stays.mjs";

const TZ = "Etc/GMT+5"; // a fixed UTC-5 home zone
const seg = (metro, source, a, d) => ({ metro, source, arrive_at: a, depart_at: d });

const SEGMENTS = [
  seg("alpha", "flights", "2030-03-01T18:00:00Z", "2030-03-10T15:00:00Z"),   // home base, first visit
  seg("transit", "flights", "2030-03-10T15:00:00Z", "2030-03-10T18:00:00Z"),
  seg("beta", "flights", "2030-03-10T18:00:00Z", "2030-03-15T15:00:00Z"),
  seg("transit", "flights", "2030-03-15T15:00:00Z", "2030-03-15T18:00:00Z"),
  seg("alpha", "flights", "2030-03-15T18:00:00Z", "2030-03-20T11:00:00Z"),   // home base again
  seg("transit", "flights", "2030-03-20T11:00:00Z", "2030-03-20T14:00:00Z"),
  seg("layover", "flights", "2030-03-20T14:00:00Z", "2030-03-20T16:00:00Z"), // 2h connection
  seg("transit", "flights", "2030-03-20T16:00:00Z", "2030-03-21T10:00:00Z"),
  // One flights row spans the whole loop out of the gateway…
  seg("gate_city", "flights", "2030-03-21T10:00:00Z", "2030-04-01T02:00:00Z"),
  // …with the real legs inside it.
  seg("gate_city", "manual", "2030-03-21T12:00:00Z", "2030-03-24T16:00:00Z"),
  seg("delta", "manual", "2030-03-24T17:00:00Z", "2030-03-28T16:00:00Z"),
  seg("gate_city", "manual", "2030-03-28T17:00:00Z", "2030-04-01T11:30:00Z"),
  seg("transit", "flights", "2030-04-01T02:00:00Z", "2030-04-01T20:00:00Z"),
  seg("alpha", "flights", "2030-04-01T20:00:00Z", null),                     // home, open-ended
];

test("overlapping rows resolve to the most specific stay; slivers and layovers drop", () => {
  const stays = resolveStays(SEGMENTS, { tz: TZ });
  assert.deepEqual(
    stays.map((s) => [s.metro, s.start, s.end]),
    [
      ["alpha", "2030-03-01", "2030-03-10"],
      ["beta", "2030-03-10", "2030-03-15"],
      // Leaves 3/20, lands at the next stay 3/21 within a day: one travel move.
      ["alpha", "2030-03-15", "2030-03-21"],
      ["gate_city", "2030-03-21", "2030-03-24"],
      ["delta", "2030-03-24", "2030-03-28"],
      // Leaves 2am UTC = the evening before in the home zone; the next stay starts
      // within a day, so the stay ends on the day the next one starts.
      ["gate_city", "2030-03-28", "2030-04-01"],
      ["alpha", "2030-04-01", null],
    ],
  );
});

test("an exact manual tie beats a flights row starting at the same instant", () => {
  const stays = resolveStays([
    seg("transit", "flights", "2030-05-01T12:00:00Z", "2030-05-01T15:00:00Z"),
    seg("alpha", "manual", "2030-05-01T12:00:00Z", "2030-05-05T12:00:00Z"),
  ], { tz: TZ });
  assert.deepEqual(stays.map((s) => [s.metro, s.start, s.end]), [["alpha", "2030-05-01", "2030-05-05"]]);
});

test("guides match by exact key, else as a whole word of a combined key", () => {
  const keys = ["alpha_beta", "gate_city", "omega"];
  assert.equal(guideFor("gate_city", keys), "gate_city");
  assert.equal(guideFor("alpha", keys), "alpha_beta");
  assert.equal(guideFor("beta", keys), "alpha_beta");
  assert.equal(guideFor("gate", keys), "gate_city", "whole words of a key match (keys are metro slugs joined by _)");
  assert.equal(guideFor("ate", keys), null, "a part of a word never does");
  assert.equal(guideFor("delta", keys), null);
  assert.equal(prettyMetro("gate_city"), "Gate City");
  assert.equal(prettyMetro("abc"), "ABC");
});

test("the ribbon: a chip per stay, guide-less stops dimmed, uncovered guides by their own dates, past flagged", () => {
  const stays = resolveStays([
    seg("old_town", "manual", "2030-01-02T17:00:00Z", "2030-01-05T17:00:00Z"), // past, no guide → dropped
    seg("omega", "manual", "2030-01-10T17:00:00Z", "2030-01-12T17:00:00Z"),    // past, has guide
    ...SEGMENTS,
  ], { tz: TZ });
  const guides = [
    { area: "alpha_beta", label: "Alpha/Beta", date_range: { start: "2029-01-01", end: "2029-02-01" } },
    { area: "gate_city", label: "Gate City, Somewhere", date_range: null },
    { area: "omega", label: "Omega", date_range: null },
    { area: "port", label: "Port of Call", date_range: { start: "2030-03-05", end: "2030-03-05" } },
    { area: "someday", label: "Someday", date_range: null },
  ];
  const today = "2030-03-12";
  const items = ribbonItems(stays, guides, today);
  assert.deepEqual(
    items.map((it) => [it.area, it.label, it.start, it.hasGuide, it.past]),
    [
      ["omega", "Omega", "2030-01-10", true, true],
      ["alpha_beta", "Alpha", "2030-03-01", true, true],
      ["port", "Port of Call", "2030-03-05", true, true],
      ["alpha_beta", "Beta", "2030-03-10", true, false],
      ["alpha_beta", "Alpha", "2030-03-15", true, false],
      ["gate_city", "Gate City, Somewhere", "2030-03-21", true, false],
      ["delta", "Delta", "2030-03-24", false, false],
      ["gate_city", "Gate City, Somewhere", "2030-03-28", true, false],
      ["alpha_beta", "Alpha", "2030-04-01", true, false],
      ["someday", "Someday", null, true, false],
    ],
  );
  // The combined guide's stale stored range is ignored once the timeline covers it.
  assert.ok(!items.some((it) => it.start === "2029-01-01"));

  assert.equal(focusItem(items, "alpha_beta", today).start, "2030-03-10", "current stay");
  assert.equal(focusItem(items, "gate_city", today).start, "2030-03-21", "next stay");
  assert.equal(focusItem(items, "omega", today).start, "2030-01-10", "most recent");
  assert.equal(landingArea(items, today), "alpha_beta");
  // On a stop with no guide, land on the next stop that has one.
  assert.equal(landingArea(items, "2030-03-25"), "gate_city");
  // A changeover day lands on the stay being arrived into.
  assert.equal(landingArea(items, "2030-03-21"), "gate_city");
});
