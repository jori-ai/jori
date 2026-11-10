// tmdb-providers.test.mjs — unit tests for the tmdb-watch-providers provider
// picker (the group-fallback + reseller-filter tier) and the new-series sweep.
// Run: node --test tests/tmdb-providers.test.mjs
//
// Pure logic — no TMDB or Supabase calls.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pickProviders, isResellerVariant, shortName,
  serviceOf, providerIdsFor, onServices, discoverPath, daysBefore, sweepNewShows, mapLimit,
  DEFAULT_SERVICES, EXCLUDED_TV_GENRE_IDS,
} from "../lib/tmdb-providers.mjs";

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

// --- the new-series sweep (watch-discover's TMDB source) ---------------------------

const prov = (id, provider_name) => ({ provider_id: id, provider_name });


test("serviceOf folds ad tiers, store channels and TMDB's long names into the service", () => {
  assert.equal(serviceOf("Apple TV"), "Apple TV+");
  assert.equal(serviceOf("Apple TV Amazon Channel"), "Apple TV+");
  assert.equal(serviceOf("HBO Max"), "Max");
  assert.equal(serviceOf("HBO Max Amazon Channel"), "Max");
  assert.equal(serviceOf("Amazon Prime Video with Ads"), "Prime Video");
  assert.equal(serviceOf("Paramount Plus Premium"), "Paramount+");
  assert.equal(serviceOf("Paramount Plus Apple TV channel"), "Paramount+");
  assert.equal(serviceOf("Peacock Premium Plus"), "Peacock");
  assert.equal(serviceOf("Disney Plus"), "Disney+");
  assert.equal(serviceOf("Netflix"), "Netflix");
  // An add-on channel sold on top of a service is its own thing, not the service.
  assert.equal(serviceOf("PBS Masterpiece Amazon Channel"), "PBS Masterpiece");
  assert.equal(serviceOf("Apple TV Store"), "Apple TV Store");
});

test("providerIdsFor picks every TMDB id that belongs to the services, once", () => {
  const list = [
    prov(8, "Netflix"), prov(1796, "Netflix Standard with Ads"), prov(350, "Apple TV"), prov(2, "Apple TV Store"),
    prov(1899, "HBO Max"), prov(1825, "HBO Max Amazon Channel"), prov(294, "PBS Masterpiece Amazon Channel"),
    prov(43, "Starz"),
  ];
  assert.deepEqual(providerIdsFor(list, ["Netflix", "Apple TV+", "Max"]).sort((a, b) => a - b), [8, 350, 1825, 1899]);
  assert.deepEqual(providerIdsFor(list, ["Shudder"]), []);
  assert.deepEqual(providerIdsFor(null), []);
});

test("onServices counts subscription, free and ad tiers — never rent/buy or add-on channels", () => {
  const entry = {
    flatrate: [{ provider_name: "PBS Masterpiece Amazon Channel" }],
    buy: [{ provider_name: "Amazon Video" }, { provider_name: "Apple TV Store" }],
  };
  assert.deepEqual(onServices(entry, DEFAULT_SERVICES), []);
  const apple = { flatrate: [{ provider_name: "Apple TV" }, { provider_name: "Apple TV Amazon Channel" }], ads: [{ provider_name: "Amazon Prime Video with Ads" }] };
  assert.deepEqual(onServices(apple, DEFAULT_SERVICES), ["Apple TV+", "Prime Video"]);
  assert.deepEqual(onServices(null), []);
});

test("discoverPath asks for streaming premieres in the window, excluded genres out", () => {
  const p = discoverPath({ providerIds: [8, 350], region: "US", since: "2026-03-14", until: "2026-11-09", page: 3 });
  assert.ok(p.startsWith("discover/tv?"));
  const q = new URLSearchParams(p.split("?")[1]);
  assert.equal(q.get("with_watch_providers"), "8|350");
  assert.equal(q.get("watch_region"), "US");
  assert.equal(q.get("first_air_date.gte"), "2026-03-14");
  assert.equal(q.get("first_air_date.lte"), "2026-11-09");
  assert.equal(q.get("without_genres"), EXCLUDED_TV_GENRE_IDS.join("|"));
  assert.equal(q.get("with_watch_monetization_types"), "flatrate|free|ads");
  assert.equal(q.get("page"), "3");
});

test("daysBefore does calendar arithmetic across month and year ends", () => {
  assert.equal(daysBefore("2026-11-09", 120), "2026-07-12");
  assert.equal(daysBefore("2026-01-05", 10), "2025-12-26");
  assert.equal(daysBefore("2026-03-01", 1), "2026-02-28");
});

test("sweepNewShows pages until TMDB runs out, dedups and sorts by popularity", async () => {
  const calls = [];
  const pages = {
    1: { total_pages: 2, results: [{ id: 1, name: "A", popularity: 5, vote_count: 40, original_language: "en", first_air_date: "2026-09-01" }, { id: 2, name: "B", popularity: 50, vote_count: 3 }] },
    2: { total_pages: 2, results: [{ id: 2, name: "B", popularity: 50 }, { id: 3, name: "C", popularity: 20 }] },
  };
  const tmdbGet = async (p) => {
    calls.push(p);
    if (p.startsWith("watch/providers/tv")) return { results: [prov(8, "Netflix"), prov(350, "Apple TV"), prov(43, "Starz")] };
    return pages[new URLSearchParams(p.split("?")[1]).get("page")];
  };
  const r = await sweepNewShows({ tmdbGet, services: ["Netflix", "Apple TV+"], today: "2026-11-09", lookbackDays: 240, maxPages: 10 });
  assert.deepEqual(r.providerIds.sort((a, b) => a - b), [8, 350]);
  assert.deepEqual(r.shows.map((s) => s.tmdb_id), [2, 3, 1]);
  assert.equal(r.shows.find((s) => s.tmdb_id === 1).original_language, "en");
  assert.equal(calls.filter((c) => c.startsWith("discover/tv")).length, 2);
  assert.ok(calls[1].includes("first_air_date.gte=2026-03-14"));
});

test("sweepNewShows stops at maxPages and refuses when no provider matches", async () => {
  let discover = 0;
  const tmdbGet = async (p) => {
    if (p.startsWith("watch/providers/tv")) return { results: [prov(8, "Netflix")] };
    discover++;
    return { total_pages: 99, results: [{ id: discover, name: `S${discover}`, popularity: discover }] };
  };
  const r = await sweepNewShows({ tmdbGet, services: ["Netflix"], today: "2026-11-09", maxPages: 3 });
  assert.equal(discover, 3);
  assert.equal(r.shows.length, 3);
  await assert.rejects(sweepNewShows({ tmdbGet, services: ["Shudder"], today: "2026-11-09" }), /no TMDB provider ids/);
});

test("mapLimit keeps input order and never runs more than n at once", async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, ms));
    live--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
