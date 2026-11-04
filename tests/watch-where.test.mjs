// watch-where.test.mjs — where-to-watch lookup (lib/watch-where.mjs).
// Run: node --test tests/watch-where.test.mjs
//
// No network: TMDB is replaced by a fetch stub serving the fixture responses in
// tests/fixtures/tmdb-watch-providers-*.json, and the cache lives in a
// temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A synthetic installation: owner "Alex" (id alex), partner "Sam" (id sam).
const local = fs.mkdtempSync(path.join(os.tmpdir(), "watch-test-"));
fs.mkdirSync(path.join(local, "config"));
fs.writeFileSync(path.join(local, "config", "watchlist.json"), JSON.stringify({ partner_id: "sam", partner_name: "Sam", preferred_languages: ["en", "fr"], metro_countries: { home_a: "US", home_b: "US", away: "IL" } }));
process.env.JORI_LOCAL_DIR = local;
process.env.JORI_OWNER_NAME = "Alex";
process.env.JORI_OWNER_ID = "alex";
process.env.JORI_TZ = "UTC";

const {
  regionAvailability, shortAvailability, longAvailability, isEmpty,
  countryFromPresence, regionsToShow, currentPresence, PRESENCE_TIMEOUT_MS, fetchProviders, whereToWatch, formatWhere, TTL_DAYS,
} = await import("../lib/watch-where.mjs");

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const tvFixture = JSON.parse(fs.readFileSync(path.join(FIX, "tmdb-watch-providers-tv.json"), "utf8"));
const movieFixture = JSON.parse(fs.readFileSync(path.join(FIX, "tmdb-watch-providers-movie.json"), "utf8"));

function stubFetch(body) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  fn.calls = calls;
  return fn;
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "watch-where-"));
const NOW = Date.parse("2026-10-06T12:00:00Z");

// --- region shaping ---------------------------------------------------------

test("stream list drops ad-tier variants and follows TMDB display priority", () => {
  const us = regionAvailability(tvFixture.results.US);
  assert.deepEqual(us.stream, ["Netflix"]);
  assert.equal(us.link, "https://www.themoviedb.org/tv/65495-fauda/watch?locale=US");
  const il = regionAvailability(tvFixture.results.IL);
  assert.deepEqual(il.stream, ["Netflix", "yes+"]);
});

test("rent/buy storefronts are an answer here (unlike the platform tag)", () => {
  const a = regionAvailability(movieFixture.results.US);
  // flatrate was only an Amazon Channel reseller → filtered
  assert.deepEqual(a.stream, []);
  assert.deepEqual(a.ads, ["Tubi TV"]);
  assert.deepEqual(a.rent, ["Prime Video", "Apple TV", "Google Play"]);
  // buy entries already offered for rent are not repeated
  assert.deepEqual(a.buy, ["Fandango at Home"]);
  assert.equal(shortAvailability(a), "free with ads on Tubi TV");
  assert.equal(longAvailability(a), "free with ads: Tubi TV · rent: Prime Video, Apple TV, Google Play · buy: Fandango at Home");
});

test("missing region reads as not available", () => {
  const a = regionAvailability(movieFixture.results.IL);
  assert.equal(a, null);
  assert.equal(isEmpty(a), true);
  assert.equal(shortAvailability(a), null);
  assert.equal(longAvailability(a), "not available to stream, rent or buy");
});

// --- which country -----------------------------------------------------------

test("country comes from the travel metro, then the label", () => {
  assert.equal(countryFromPresence({ metro: "away", label: null }), "IL");
  assert.equal(countryFromPresence({ metro: "home_a" }), "US");
  assert.equal(countryFromPresence({ metro: "home_b|home_a" }), "US");
  assert.equal(countryFromPresence({ metro: "elsewhere", label: "Old Town, France — gîte" }), "FR");
  assert.equal(countryFromPresence({ metro: "elsewhere", label: "Hill Town, Greece" }), "GR");
  assert.equal(countryFromPresence({ metro: "london", label: "London, England" }), "GB");
  assert.equal(countryFromPresence({ metro: null, label: null, source: "unknown" }), null);
  assert.equal(countryFromPresence(null), null);
});

test("US always; local country added only when abroad", async () => {
  assert.deepEqual(await regionsToShow({ presence: { metro: "away" } }), { regions: ["US", "IL"], local: "IL", presence: { metro: "away" } });
  assert.deepEqual((await regionsToShow({ presence: { metro: "home_a" } })).regions, ["US"]);
  assert.deepEqual((await regionsToShow({ presence: null })).regions, ["US"]);
  assert.deepEqual((await regionsToShow({ override: ["il", "gb"] })).regions, ["IL", "GB"]);
});

// --- presence lookup: cached, bounded, falls back to US ----------------------

test("presence is cached for an hour: one resolver call per hour", async () => {
  const dir = tmpDir();
  let calls = 0;
  const resolver = async () => { calls++; return { metro: "away", label: "Away City" }; };
  const r1 = await regionsToShow({ presenceOpts: { dir, now: NOW, resolver } });
  assert.deepEqual(r1.regions, ["US", "IL"]);
  const r2 = await regionsToShow({ presenceOpts: { dir, now: NOW + 59 * 60000, resolver } });
  assert.deepEqual(r2.regions, ["US", "IL"]);
  assert.equal(calls, 1);
  await currentPresence({ dir, now: NOW + 61 * 60000, resolver });
  assert.equal(calls, 2);
});

test("a slow travel lookup times out fast and falls back to US only", async () => {
  const dir = tmpDir();
  let calls = 0;
  const hang = () => { calls++; return new Promise(() => {}); }; // never settles
  const t0 = Date.now();
  const r = await regionsToShow({ presenceOpts: { dir, now: NOW, resolver: hang, timeoutMs: 50 } });
  assert.ok(Date.now() - t0 < 1000, "bounded by the timeout");
  assert.deepEqual(r, { regions: ["US"], local: null, presence: null });
  // the failure is cached briefly: no second wait 5 minutes later...
  await currentPresence({ dir, now: NOW + 5 * 60000, resolver: hang, timeoutMs: 50 });
  assert.equal(calls, 1);
  // ...but it is retried after 10 minutes
  await currentPresence({ dir, now: NOW + 11 * 60000, resolver: hang, timeoutMs: 50 });
  assert.equal(calls, 2);
});

test("a throwing or empty travel lookup also means US only", async () => {
  const boom = async () => { throw new Error("supabase down"); };
  assert.deepEqual((await regionsToShow({ presenceOpts: { dir: tmpDir(), now: NOW, resolver: boom } })).regions, ["US"]);
  const empty = async () => null;
  assert.deepEqual((await regionsToShow({ presenceOpts: { dir: tmpDir(), now: NOW, resolver: empty } })).regions, ["US"]);
});

test("default presence timeout is 2s or less", () => {
  assert.ok(PRESENCE_TIMEOUT_MS <= 2000);
});

// --- fetch + cache -----------------------------------------------------------

test("fetches once, then serves both regions from the 7-day cache", async () => {
  const dir = tmpDir();
  const f = stubFetch(tvFixture);
  const w1 = await whereToWatch({ media: "tv", id: 65495 }, ["US", "IL"], { fetchImpl: f, apiKey: "k", dir, now: NOW });
  assert.equal(w1.cached, false);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /\/3\/tv\/65495\/watch\/providers\?api_key=k$/);
  assert.deepEqual(w1.regions.IL.stream, ["Netflix", "yes+"]);
  assert.ok(fs.existsSync(path.join(dir, "tv-65495.json")));

  // a different region next day: no new call
  const w2 = await whereToWatch({ media: "tv", id: 65495 }, ["GB"], { fetchImpl: f, apiKey: "k", dir, now: NOW + 86400000 });
  assert.equal(w2.cached, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(w2.regions.GB.stream, ["Netflix"]);
});

test("cache expires after TTL_DAYS; refresh bypasses it", async () => {
  const dir = tmpDir();
  const f = stubFetch(tvFixture);
  await fetchProviders("tv", 65495, { fetchImpl: f, apiKey: "k", dir, now: NOW });
  await fetchProviders("tv", 65495, { fetchImpl: f, apiKey: "k", dir, now: NOW + (TTL_DAYS + 1) * 86400000 });
  assert.equal(f.calls.length, 2);
  await fetchProviders("tv", 65495, { fetchImpl: f, apiKey: "k", dir, now: NOW + (TTL_DAYS + 1) * 86400000, refresh: true });
  assert.equal(f.calls.length, 3);
});

test("movie and tv ids don't share a cache entry", async () => {
  const dir = tmpDir();
  const f = stubFetch(movieFixture);
  await fetchProviders("movie", 65495, { fetchImpl: f, apiKey: "k", dir, now: NOW });
  const ft = stubFetch(tvFixture);
  const r = await fetchProviders("tv", 65495, { fetchImpl: ft, apiKey: "k", dir, now: NOW });
  assert.equal(r.cached, false);
  assert.equal(ft.calls.length, 1);
});

test("no key → clear error, never a request", async () => {
  const f = stubFetch(tvFixture);
  await assert.rejects(fetchProviders("tv", 1, { fetchImpl: f, apiKey: "", dir: tmpDir(), now: NOW }), /TMDB_API_KEY missing/);
  assert.equal(f.calls.length, 0);
});

test("TMDB error surfaces with status", async () => {
  const f = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(fetchProviders("movie", 1, { fetchImpl: f, apiKey: "k", dir: tmpDir(), now: NOW }), /TMDB 401/);
});

test("formatted answer flags the local country and credits JustWatch", async () => {
  const w = await whereToWatch({ media: "tv", id: 65495 }, ["US", "GB"], { fetchImpl: stubFetch(tvFixture), apiKey: "k", dir: tmpDir(), now: NOW });
  const out = formatWhere("Fauda", w, { local: "GB" });
  assert.equal(out, [
    "Where to watch Fauda:",
    "  United States: stream: Netflix",
    "  United Kingdom (where you are now): stream: Netflix",
    "  https://www.themoviedb.org/tv/65495-fauda/watch?locale=US",
    "  (JustWatch via TMDB, as of 2026-10-06)",
  ].join("\n"));
});
