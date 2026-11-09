// The show database (lib/watch-db.mjs): one rating per show with its source, the catalog
// upsert that never blanks a stored value, and a running season's finale facts.
// Run: node --test tests/watch-show-db.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const local = fs.mkdtempSync(path.join(os.tmpdir(), "watch-showdb-test-"));
fs.mkdirSync(path.join(local, "config"));
fs.writeFileSync(path.join(local, "config", "watchlist.json"), JSON.stringify({ partner_id: "sam", partner_name: "Sam", preferred_languages: ["en"] }));
process.env.JORI_LOCAL_DIR = local;
process.env.JORI_OWNER_NAME = "Alex";
process.env.JORI_OWNER_ID = "alex";
process.env.JORI_TZ = "UTC";
const { showRating, upsertCatalogRows, MIN_SHOW_VOTES, ESTIMATE_PRIOR } = await import("../lib/watch-db.mjs");

test("showRating: IMDb wins once it has enough votes", () => {
  assert.deepEqual(showRating({ imdb: 6.2, imdbVotes: 4486, review: { equivalent: 8.0 }, tmdbAverage: 6.9, tmdbVotes: 28 }), { rating: 6.2, source: "imdb" });
});

test("showRating: thin IMDb → the review check's reading", () => {
  assert.deepEqual(showRating({ imdb: 9.1, imdbVotes: 40, review: { equivalent: 7.84 } }), { rating: 7.8, source: "reviews" });
});

test("showRating: no review → an estimate shrunk toward the prior", () => {
  const r = showRating({ imdb: 9.4, imdbVotes: 12, tmdbAverage: null, tmdbVotes: 0 });
  assert.equal(r.source, "estimate");
  assert.ok(r.rating > ESTIMATE_PRIOR && r.rating < 7.5, `9.4 on 12 votes must not read as a hit (${r.rating})`);
  // More votes pull it toward the observed average.
  const many = showRating({ imdb: 8.6, imdbVotes: MIN_SHOW_VOTES - 1, tmdbAverage: 8.2, tmdbVotes: 300 });
  assert.equal(many.source, "estimate");
  assert.ok(many.rating > 8.2, String(many.rating));
});

test("showRating: nothing to go on → null", () => {
  assert.deepEqual(showRating({ imdb: null, imdbVotes: null, tmdbAverage: 8, tmdbVotes: 3 }), { rating: null, source: null });
  assert.deepEqual(showRating({}), { rating: null, source: null });
});

test("upsertCatalogRows: drops nulls and groups rows by column set", async () => {
  const sent = [];
  const n = await upsertCatalogRows([
    { kind: "show", tmdb_id: 1, title: "A", imdb_rating: null, rating: 7.1 },
    { kind: "show", tmdb_id: 2, title: "B", imdb_rating: 8.0, rating: 8.0 },
    { kind: "show", tmdb_id: 3, title: "C", imdb_rating: undefined, rating: 6.5 },
    { kind: "show", tmdb_id: 4, title: null },  // no title → can't be inserted, skipped
  ], { send: async (body) => sent.push(body) });
  assert.equal(n, 3);
  for (const batch of sent) {
    const keys = batch.map((r) => Object.keys(r).sort().join(","));
    assert.equal(new Set(keys).size, 1, "one column set per request");
    for (const r of batch) for (const v of Object.values(r)) assert.notEqual(v, null);
  }
  assert.equal(sent.flat().find((r) => r.tmdb_id === 1).imdb_rating, undefined, "a null never overwrites a stored rating");
});

test("upsertCatalogRows: keepNull writes an explicit null for the named columns only", async () => {
  const sent = [];
  await upsertCatalogRows([{ kind: "show", tmdb_id: 9, title: "D", season_finale_date: null, rating: null }], { keepNull: ["season_finale_date"], send: async (b) => sent.push(b) });
  assert.deepEqual(sent[0][0], { kind: "show", tmdb_id: 9, title: "D", season_finale_date: null });
});

test("tmdbSeasons: a running season's finale date, episodes aired and whether the finale is dated", async () => {
  const { tmdbSeasons } = await import("../lib/watch-db.mjs");
  process.env.TMDB_API_KEY = "test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /tv\/77\/season\/1/);
    return new Response(JSON.stringify({ episodes: [
      { air_date: "2026-10-01" }, { air_date: "2026-10-08" }, { air_date: "2026-11-12" }, { air_date: "2026-11-19" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const tv = { id: 77, seasons: [{ season_number: 1, air_date: "2026-10-01", episode_count: 4 }], next_episode_to_air: { season_number: 1, air_date: "2026-11-12" } };
    const [s1] = await tmdbSeasons(tv, "2026-11-09");
    assert.equal(s1.finale_date, "2026-11-19");
    assert.equal(s1.episodes_aired, 2);
    assert.equal(s1.finale_known, true);
    assert.equal(s1.fully_dropped, false);
  } finally { globalThis.fetch = realFetch; }
});
