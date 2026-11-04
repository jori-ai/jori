// cruise-itinerary-clean.test.mjs — sea days, endpoint leakage and ordering.
//
// Every case here is a real defect that reached the live site on 2026-09-01,
// caught by the user on the cards rather than by anything in the pipeline
// (port names below are synthetic stand-ins for the home port):
//   - an MSC card reading "Day At Sea → Puerto Plata → ... → <home> → Ocean Cay"
//     for a round trip from that home port (sea days as ports; the embarkation port listed
//     as a call; and arrows over a facet array that has no order at all)
//   - NCL cards whose ports were complete but in an order the line never sails
//
// Run: node --test tests/cruise-itinerary-clean.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCalls, isSeaDay, placeName } from "../lib/cruise/itinerary.mjs";

const names = (cs) => cs.map((c) => c.name);

test("sea days are not ports, whatever the line calls them", () => {
  assert.ok(isSeaDay("Day At Sea", "SEADAY"));
  assert.ok(isSeaDay("Cruising Panama Canal and Gatun Lake", null), "Holland");
  assert.ok(isSeaDay("Enter Panama Canal Cristobal", null), "Holland transit marker");
  assert.ok(isSeaDay("Cruising", "CRU"), "Royal");
  assert.ok(isSeaDay("", null), "an empty name is not a port");
  assert.ok(isSeaDay("Inside Passage (Cruising)", null), "the marker trails the place name");
  assert.ok(isSeaDay("Hubbard Glacier (Scenic Cruising)", null));
  assert.ok(!isSeaDay("Roatan", "RTB"));
  assert.ok(!isSeaDay("Ocean Cay MSC Marine Reserve", "1SC"), "'Ocean' must not read as 'at sea'");
});

test("the region is dropped from a port title", () => {
  assert.equal(placeName("Roatan, Honduras"), "Roatan");
  assert.equal(placeName("Galveston, Texas"), "Galveston");
  assert.equal(placeName(null), "");
});

test("the MSC Seashore card, as it should have rendered", () => {
  // Verbatim from the live Algolia response for SH20271205GALGA1, in the order
  // the facet array returned it — which is why ordered:false is the honest flag.
  const raw = [
    { code: "SEADAY", name: "Day At Sea" },
    { code: "SEADAY", name: "Day At Sea" },
    { code: "SJH", name: "St. John's, Antigua and Barbuda" },
    { code: "CHA", name: "Charlotte Amalie (St. Thomas), Virgin Islands" },
    { code: "POP", name: "Puerto Plata, Dominican Republic" },
    { code: "SEADAY", name: "Day At Sea" },
    { code: "GAL", name: "Galveston, Texas" },
    { code: "1SC", name: "Ocean Cay MSC Marine Reserve, Bahamas" },
    { code: "SEADAY", name: "Day At Sea" },
    { code: "POP", name: "Puerto Plata, Dominican Republic" },
    { code: "RTB", name: "Roatan, Honduras" },
  ];
  const out = cleanCalls(raw, {
    ends: [{ code: "GAL", name: "Galveston, Texas" }, { code: "GAL", name: "Galveston, Texas" }],
    ordered: false,
  });
  assert.deepEqual(names(out), [
    "St. John's", "Charlotte Amalie (St. Thomas)", "Puerto Plata",
    "Ocean Cay MSC Marine Reserve", "Roatan",
  ]);
  assert.ok(!names(out).includes("Galveston"), "the ship starting and ending in Galveston is not a call");
  assert.ok(!names(out).some((n) => /sea/i.test(n) && n !== "Ocean Cay MSC Marine Reserve"));
});

test("an unordered list dedupes globally, an ordered one only consecutively", () => {
  const raw = [
    { code: "RTB", name: "Roatan" },
    { code: "RTB", name: "Roatan" },   // overnight — same call
    { code: "CZM", name: "Cozumel" },
    { code: "RTB", name: "Roatan" },   // a genuine second visit later
  ];
  assert.deepEqual(
    names(cleanCalls(raw, { ordered: true })),
    ["Roatan", "Cozumel", "Roatan"],
    "a real return visit survives when the sequence is trustworthy",
  );
  assert.deepEqual(
    names(cleanCalls(raw, { ordered: false })),
    ["Roatan", "Cozumel"],
    "in a set, a repeat carries no information",
  );
});

test("endpoints match by name when the line publishes no codes", () => {
  // Holland gives names only, so the code path cannot be relied on.
  const out = cleanCalls(
    [{ code: null, name: "Galveston, Texas, US" }, { code: null, name: "Aruba" }],
    { ends: [{ name: "Galveston, Texas, US" }, { name: "Galveston" }], ordered: false },
  );
  assert.deepEqual(names(out), ["Aruba"]);
});

test("a port sharing a name with nothing is left alone", () => {
  const out = cleanCalls([{ code: "GCM", name: "Georgetown, Cayman Islands" }], {
    ends: [{ code: "GAL", name: "Galveston" }, { code: "GAL", name: "Galveston" }],
    ordered: true,
  });
  assert.deepEqual(names(out), ["Georgetown"]);
});

test("an Alaska cruisetour does not list its own embarkation port", () => {
  // Royal/Celebrity cruisetours open with LAND days (Denali, Talkeetna,
  // Anchorage) before the ship boards at Seward, so the embarkation port sits
  // partway down the day list rather than at position 0 — 65 live cards read
  // "... → Anchorage → Seward → Hubbard Glacier → ..." until this was fixed.
  const middle = [
    { code: "DNL", name: "Denali" },
    { code: "ANC", name: "Anchorage" },
    { code: "SWD", name: "Seward" },
    { code: "HGL", name: "Hubbard Glacier" },
    { code: "JNU", name: "Juneau" },
    { code: "IPC", name: "Inside Passage (Cruising)" },
  ];
  const out = cleanCalls(middle, {
    ends: [{ code: "TKA", name: "Talkeetna" }, { code: "YVR", name: "Vancouver" }, { code: "SWD", name: "Seward" }],
    ordered: true,
  });
  assert.deepEqual(names(out), ["Denali", "Anchorage", "Hubbard Glacier", "Juneau"]);
  assert.ok(!names(out).includes("Seward"), "the port the ship boards at is not a call");
  assert.ok(!names(out).includes("Inside Passage (Cruising)"), "scenic cruising is not a port");
});
