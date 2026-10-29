// tmdb-providers.test.mjs — unit tests for the tmdb-watch-providers provider
// picker (the group-fallback + reseller-filter tier).
// Run: node --test tests/tmdb-providers.test.mjs
//
// Pure logic — no TMDB or Supabase calls.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pickProviders, isResellerVariant, shortName } from "../lib/tmdb-providers.mjs";

const p = (...names) => names.map((provider_name) => ({ provider_name }));

test("normalizes long TMDB names to the short forms the watchlist uses", () => {
  assert.equal(shortName({ provider_name: "Amazon Prime Video" }), "Prime Video");
  assert.equal(shortName({ provider_name: "HBO Max" }), "Max");
  assert.equal(shortName({ provider_name: "Apple TV Plus" }), "Apple TV+");
  assert.equal(shortName({ provider_name: "Shudder" }), "Shudder");
});

test("flags cable bundles, rent/buy storefronts, and reseller suffixes", () => {
  assert.equal(isResellerVariant("YouTube TV"), true);
  assert.equal(isResellerVariant("Apple TV Store"), true);
  assert.equal(isResellerVariant("PBS Documentaries Amazon Channel"), true);
  assert.equal(isResellerVariant("Netflix Standard with Ads"), true);
  assert.equal(isResellerVariant("Netflix"), false);
});

test("prefers flatrate over the lower-priority groups", () => {
  assert.deepEqual(
    pickProviders({ flatrate: p("Netflix"), free: p("Tubi TV"), rent: p("Plex") }),
    ["Netflix"],
  );
});

test("caps the number of providers returned", () => {
  assert.deepEqual(pickProviders({ flatrate: p("Netflix", "Hulu", "Peacock") }), ["Netflix", "Hulu"]);
  assert.deepEqual(pickProviders({ flatrate: p("Netflix", "Hulu", "Peacock") }, 3), [
    "Netflix",
    "Hulu",
    "Peacock",
  ]);
});

test("de-duplicates names that normalize to the same short form", () => {
  assert.deepEqual(pickProviders({ flatrate: p("Amazon Prime Video", "Amazon Video") }), ["Prime Video"]);
});

// Regression: the group loop used to return from the first group that was
// non-empty BEFORE filtering. A title whose only flatrate entry was a reseller
// or cable bundle therefore reported "no providers" and its platform tag went
// stale forever, even though a perfectly good group sat one step down.
test("falls through to the next group when filtering empties the first", () => {
  // "20 Days in Mariupol" — flatrate is a single Amazon Channel reseller, but
  // the title really is free on Kanopy/Hoopla.
  assert.deepEqual(
    pickProviders({
      flatrate: p("PBS Documentaries Amazon Channel"),
      free: p("Kanopy", "Hoopla"),
      rent: p("Amazon Video"),
    }),
    ["Kanopy", "Hoopla"],
  );

  // "The Accountant" — flatrate is YouTube TV (a live-TV bundle we exclude);
  // the real answer is in rent.
  assert.deepEqual(
    pickProviders({
      flatrate: p("YouTube TV"),
      rent: p("Amazon Video", "Apple TV Store", "Google Play Movies", "Plex"),
    }),
    ["Prime Video", "Plex"],
  );
});

test("returns empty only when every group filters down to nothing", () => {
  // "Pig" — rent/buy are all transactional storefronts we exclude.
  assert.deepEqual(
    pickProviders({
      rent: p("Apple TV Store", "Google Play Movies", "YouTube"),
      buy: p("Apple TV Store", "Google Play Movies", "YouTube"),
    }),
    [],
  );
});

test("returns empty for a missing region entry", () => {
  assert.deepEqual(pickProviders(undefined), []);
  assert.deepEqual(pickProviders(null), []);
  assert.deepEqual(pickProviders({}), []);
});
