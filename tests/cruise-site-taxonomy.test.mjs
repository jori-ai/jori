// cruise-site-taxonomy.test.mjs — pins the grouping vocabulary the
// cruise site's filters are built on.
//
// Neither of these facts is in the database. Port names arrive however each
// line's API spells them ("Galveston", "Galveston, Texas", "Galveston, Texas, US"
// are all one port), and `departure_port_region` is null on every row, so "region"
// is derived from the departure port. Both are the kind of mapping that rots
// quietly: a line changes a spelling, one port silently splits into two filter
// rows with half the count each, and nothing errors.
//
// Run: node --test tests/cruise-site-taxonomy.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// normalizePort ships beside the encoder that applies it; regions and price
// bands beside the filters that render them. Neither file imports the other.
// The cruise app: apps/cruises once the sites have moved, web/cruises before.
const APP = ["apps/cruises", "web/cruises"].map((d) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", d))
  .find((d) => existsSync(path.join(d, "package.json")));
const { normalizePort } = await import(path.join(APP, "lib/sailing-row.ts"));
const { regionForPort, REGIONS, PRICE_BANDS } = await import(
  path.join(APP, "lib/sailing-taxonomy.ts")
);

test("the three spellings of one port collapse to one name", () => {
  // Three rows in an un-normalized filter, one port.
  for (const raw of ["Galveston", "Galveston, Texas", "Galveston, Texas, US"]) {
    assert.equal(normalizePort(raw), "Galveston", raw);
  }
});

test("administrative suffixes are dropped", () => {
  assert.equal(normalizePort("Seattle, Washington, US"), "Seattle");
  assert.equal(normalizePort("Boston, Massachusetts, US"), "Boston");
  assert.equal(normalizePort("Philadelphia, Pennsylvania"), "Philadelphia");
  assert.equal(normalizePort("Athens (Piraeus), Greece"), "Athens");
});

test("a metro/terminal pair resolves to the port, whichever half is in parens", () => {
  // The port is the parenthetical here...
  assert.equal(normalizePort("Orlando (Port Canaveral)"), "Port Canaveral"); // kernel-guard-ok: vendor spellings of public cruise ports, world data
  assert.equal(normalizePort("Port Canaveral (Orlando), Florida"), "Port Canaveral"); // kernel-guard-ok: vendor spellings of public cruise ports, world data
  assert.equal(normalizePort("Orlando (Port Canaveral), Florida"), "Port Canaveral"); // kernel-guard-ok: vendor spellings of public cruise ports, world data
  assert.equal(normalizePort("Oahu (Honolulu)"), "Honolulu");
  assert.equal(normalizePort("Honolulu (Oahu)"), "Honolulu");
  // ...and the lead word here.
  assert.equal(normalizePort("Rome (Civitavecchia)"), "Rome");
  assert.equal(normalizePort("Cape Liberty (New York)"), "Cape Liberty"); // kernel-guard-ok: vendor spellings of public cruise ports, world data
  assert.equal(normalizePort("Tokyo (Yokohama)"), "Tokyo");
  assert.equal(normalizePort("Shanghai (Baoshan)"), "Shanghai");
  assert.equal(normalizePort("Ravenna (Venice)"), "Ravenna");
  assert.equal(normalizePort("Benoa (Bali)"), "Bali");
});

test("a doubled city/state name does not survive normalization", () => {
  assert.equal(normalizePort("New York, New York"), "New York"); // kernel-guard-ok: vendor spellings of public cruise ports, world data
});

test("an unknown port passes through rather than vanishing", () => {
  // A new port must still appear in the filter, just ungrouped.
  assert.equal(normalizePort("Lisbon"), "Lisbon");
  assert.equal(normalizePort("Someport, Nowhere"), "Someport");
  assert.equal(regionForPort("Someport"), "Other");
});

test("empty and missing values do not crash the encoder", () => {
  assert.equal(normalizePort(null), "");
  assert.equal(normalizePort(undefined), "");
  assert.equal(normalizePort("   "), "");
});

test("every real port lands in a named region, not Other", () => {
  // The live port list as of 2026-08-31, post-normalization. A line adding a
  // port is fine (it falls to "Other"); a line RENAMING one silently drops a
  // whole region's inventory into Other, which this catches.
  const live = [
    "Miami", "Fort Lauderdale", "Port Canaveral", "Tampa", "Galveston", "San Juan", "New Orleans", // kernel-guard-ok: vendor spellings of public cruise ports, world data
    "Vancouver", "Seward", "Seattle",
    "Barcelona", "Rome", "Athens", "Ravenna", "Istanbul", "Lisbon",
    "Singapore", "Shanghai", "Hong Kong", "Tokyo", "Seoul", "Bali",
    "New York", "Cape Liberty", "Philadelphia", "Baltimore", "Boston", // kernel-guard-ok: vendor spellings of public cruise ports, world data
    "Los Angeles", "San Diego",
    "Sydney", "Brisbane", "Auckland",
    "Colón", "Cartagena", "Buenos Aires",
    "Southampton", "Amsterdam", "Reykjavik",
    "Honolulu",
  ];
  const orphans = live.filter((p) => regionForPort(p) === "Other");
  assert.deepEqual(orphans, [], "these ports have no region mapping");
});

test("the big departure clusters map where a booker would expect", () => {
  assert.equal(regionForPort("Galveston"), "Caribbean & Bahamas");
  assert.equal(regionForPort("Seward"), "Alaska");
  assert.equal(regionForPort("Barcelona"), "Mediterranean");
  assert.equal(regionForPort("Cape Liberty"), "Northeast US");
  assert.equal(regionForPort("Honolulu"), "Hawaii");
});

test("Other sorts last so it never heads the region list", () => {
  assert.equal(REGIONS[REGIONS.length - 1], "Other");
});

test("price bands tile the whole range with no gap and no overlap", () => {
  // Bands are matched with >= min && < max, so each band's max must be the
  // next one's min or a sailing priced exactly on a boundary disappears.
  for (let i = 1; i < PRICE_BANDS.length; i++) {
    assert.equal(PRICE_BANDS[i].min, PRICE_BANDS[i - 1].max, `gap at band ${i}`);
  }
  assert.equal(PRICE_BANDS[0].min, 0);
  assert.equal(PRICE_BANDS[PRICE_BANDS.length - 1].max, Infinity);

  // Every observed price finds exactly one band (corpus spans $59–$1,272).
  for (const p of [59, 99.99, 100, 149.99, 150, 200, 299.99, 300, 1272]) {
    const hits = PRICE_BANDS.filter((b) => p >= b.min && p < b.max);
    assert.equal(hits.length, 1, `$${p} matched ${hits.length} bands`);
  }
});

// ---- Repositioning is a REGION change, not merely a different end port ----
// Two back-to-back Mariner of the Seas cards were both badged Repositioning —
// which can't be: the same ship can't reposition to Europe week after week.
// They were the same ship
// running Barcelona→Lisbon and then Lisbon→Barcelona: one-way itineraries
// inside one cruising region, not seasonal relocations. Conflating the two
// badged 973 sailings as repositioning when 143 actually are.

test("a same-region one-way is not a repositioning cruise", () => {
  const repo = (from, to) => {
    const a = normalizePort(from), b = normalizePort(to);
    if (!a || !b || a === b) return false;
    const ra = regionForPort(a), rb = regionForPort(b);
    return ra !== "Other" && rb !== "Other" && ra !== rb;
  };
  assert.equal(repo("Barcelona", "Lisbon"), false, "the Mariner shuttle — both Mediterranean");
  assert.equal(repo("Lisbon", "Barcelona"), false, "and its mirror image the next week");
  assert.equal(repo("Vancouver", "Anchorage"), false, "an Alaska one-way stays in Alaska");
  assert.equal(repo("Seward", "Fairbanks"), false, "a cruisetour ends inland, still Alaska");
  assert.equal(repo("Galveston", "Galveston"), false, "a round trip is not one-way at all");

  assert.equal(repo("Tampa", "Barcelona"), true, "a genuine transatlantic");
  assert.equal(repo("Boston", "Rome (Civitavecchia)"), true, "normalized on both sides first");
  assert.equal(repo("Los Angeles", "Valparaiso"), true, "west coast to South America");
});

test("an unmapped port makes no repositioning claim", () => {
  // Two unknowns both resolve to "Other" and would compare equal; an unknown
  // against a known one would read as a region change on no evidence.
  assert.equal(regionForPort("Nowhere-on-the-map"), "Other");
});
