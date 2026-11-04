// Shows & movies list v2 — title resolution and recommendation ranking.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A synthetic installation: owner "Alex" (id alex), partner "Sam" (id sam).
const local = fs.mkdtempSync(path.join(os.tmpdir(), "watch-test-"));
fs.mkdirSync(path.join(local, "config"));
fs.writeFileSync(path.join(local, "config", "watchlist.json"), JSON.stringify({ partner_id: "sam", partner_name: "Sam", preferred_languages: ["en", "fr"], metro_countries: { home_a: "US", home_b: "US", away: "IL" } }));
process.env.JORI_LOCAL_DIR = local;
process.env.JORI_OWNER_NAME = "Alex";
process.env.JORI_OWNER_ID = "alex";
process.env.JORI_TZ = "UTC";
const { parseSeasonRef, resolveTitle, normName, findExisting } = await import("../lib/watch-db.mjs");
const { recommend, genreAffinity, fitScore, prefScore, tasteFit } = await import("../lib/watch-rank.mjs");

const TODAY = "2026-10-04";

test("parseSeasonRef handles every v1 season spelling, not titles with numbers", () => {
  assert.deepEqual(parseSeasonRef("Slow Horses Season 5"), { base: "Slow Horses", season: 5 });
  assert.deepEqual(parseSeasonRef("Slow Horses (Season 5)"), { base: "Slow Horses", season: 5 });
  assert.deepEqual(parseSeasonRef("Slow Horses: Season 5"), { base: "Slow Horses", season: 5 });
  assert.deepEqual(parseSeasonRef("Slow Horses S5"), { base: "Slow Horses", season: 5 });
  assert.deepEqual(parseSeasonRef("Love Death and Robots Vol 2"), { base: "Love Death and Robots", season: 2 });
  assert.deepEqual(parseSeasonRef("Ocean's 11"), { base: "Ocean's 11", season: null });
  assert.deepEqual(parseSeasonRef("Apollo 13"), { base: "Apollo 13", season: null });
  assert.deepEqual(parseSeasonRef("Severance"), { base: "Severance", season: null });
});

const T = (id, name, extra = {}) => ({ id, name, kind: "show", audience: "together", status: "queued", seasons: [], ...extra });

test("resolveTitle never lets a partial match hit several rows", () => {
  const titles = [T(1, "Dune"), T(2, "Dune: Part Two", { kind: "movie" }), T(3, "Dune: Prophecy"), T(4, "The Bear")];
  assert.equal(resolveTitle(titles, "dune").title.id, 1);            // exact wins
  assert.equal(resolveTitle(titles, "Bear").title.id, 4);            // "the" is ignored
  assert.ok(resolveTitle(titles, "Dune Pro").none || resolveTitle(titles, "Dune Pro").title?.id === 3);
  const amb = resolveTitle([T(5, "Slow Horses"), T(6, "Slow Horses Revisited")], "slow");
  assert.equal(amb.ambiguous.length, 2);
  assert.equal(resolveTitle(titles, "Succession").none, true);
});

test("findExisting dedups on ids before names", () => {
  const titles = [T(1, "Pachinko", { imdb_id: "tt8888540", tmdb_id: 86831 })];
  assert.equal(findExisting(titles, { imdb_id: "tt8888540", name: "x", kind: "show" }).id, 1);
  assert.equal(findExisting(titles, { tmdb_id: 86831, name: "x", kind: "show" }).id, 1);
  assert.equal(findExisting(titles, { name: "pachinko", kind: "show" }).id, 1);
  assert.equal(findExisting(titles, { name: "Moving", kind: "show" }), null);
  assert.equal(normName("Shōgun"), "shogun");
});

const season = (n, status, extra = {}) => ({ n, status, fully_dropped: true, premiere_date: "2025-01-01", finale_date: `2025-0${Math.min(n, 9)}-01`, episodes_total: 8, episodes_watched: 0, ...extra });

test("a fully-dropped next season of a watched show outranks every new show", () => {
  const titles = [
    T(1, "Slow Horses", { status: "watched", imdb_rating: 8.2, seasons: [season(1, "watched"), season(2, "watched"), season(3, "unwatched", { finale_date: "2026-09-12" })] }),
    T(2, "Shiny New Show", { imdb_rating: 9.3, year_start: 2026, seasons: [season(1, "unwatched")] }),
  ];
  const r = recommend({ titles, feedback: [], audience: "together", kind: "show", today: TODAY });
  assert.equal(r.ready[0].name, "Slow Horses");
  assert.equal(r.ready[0].season.n, 3);
  assert.equal(r.fresh[0].name, "Shiny New Show");
});

test("a next season that finished long ago is backlog, not 'just dropped'", () => {
  const titles = [
    T(1, "Godfather of Gotham", { status: "watched", imdb_rating: 8.1, seasons: [season(1, "watched"), season(2, "unwatched", { finale_date: "2021-07-11" })] }),
    T(2, "Reacher", { status: "watched", imdb_rating: 8.0, seasons: [season(1, "watched"), season(2, "unwatched", { finale_date: "2026-09-16" })] }),
  ];
  const r = recommend({ titles, feedback: [], audience: "together", kind: "show", today: TODAY });
  assert.deepEqual(r.ready.map((t) => t.name), ["Reacher"]);
  assert.equal(r.fresh[0].name, "Godfather of Gotham");
  assert.equal(r.fresh[0].continuation, true);
  assert.equal(r.fresh[0].season.n, 2);
});

test("a drama-only title gets no taste credit from the word 'Drama'", () => {
  const titles = [T(1, "Watched Drama", { status: "watched", genres: "Drama" }), T(2, "Tangerines", { genres: "Drama" })];
  assert.equal(fitScore(titles[1], genreAffinity(titles, [], "together")), 0);
});

test("still-airing seasons are never ready, and an unstarted show's later seasons never surface as 'ready'", () => {
  const titles = [
    T(1, "Ted Lasso", { status: "watched", seasons: [season(1, "watched"), season(2, "watched"), season(3, "watched"), season(4, "unwatched", { fully_dropped: false, premiere_date: "2026-08-04", finale_date: "2026-10-07" })] }),
    T(2, "House of the Dragon", { seasons: [season(1, "unwatched"), season(2, "unwatched"), season(3, "unwatched")] }),
    T(3, "Brand New Weekly", { seasons: [season(1, "unwatched", { fully_dropped: false, premiere_date: "2026-09-20" })] }),
  ];
  const r = recommend({ titles, feedback: [], audience: "together", kind: "show", today: TODAY });
  assert.equal(r.ready.length, 0);
  assert.equal(r.soon[0].name, "Ted Lasso");
  assert.deepEqual(r.fresh.map((t) => t.name), ["House of the Dragon"]);   // as a show to start, not as "S3 ready"
});

test("audiences are separate lists, and rejected/dropped titles never come back", () => {
  const titles = [
    T(1, "Andor", { audience: "solo", imdb_rating: 8.6 }),
    T(2, "The Diplomat", { imdb_rating: 8.0 }),
    T(3, "Tangerines", { imdb_rating: 9.1, status: "rejected" }),
    T(4, "Dropped Thing", { imdb_rating: 8.9, status: "dropped" }),
  ];
  const together = recommend({ titles, feedback: [], audience: "together", kind: "show", today: TODAY });
  const solo = recommend({ titles, feedback: [], audience: "solo", kind: "show", today: TODAY });
  assert.deepEqual(together.fresh.map((t) => t.name), ["The Diplomat"]);
  assert.deepEqual(solo.fresh.map((t) => t.name), ["Andor"]);
});

test("feedback moves the ranking, and mostly within its own audience", () => {
  const titles = [
    T(1, "Line of Duty", { status: "watched", genres: "Crime, Drama" }),
    T(2, "Bridgerton", { status: "watched", genres: "Romance, Drama" }),
    T(3, "Crime Pick", { imdb_rating: 7.8, genres: "Crime, Mystery" }),
    T(4, "Romance Pick", { imdb_rating: 8.0, genres: "Romance" }),
  ];
  const feedback = [
    { title_id: 1, verdict: "loved", season_n: null, created_at: "2026-09-01" },
    { title_id: 2, verdict: "disliked", season_n: null, created_at: "2026-09-01" },
  ];
  const r = recommend({ titles, feedback, audience: "together", kind: "show", today: TODAY });
  assert.deepEqual(r.fresh.map((t) => t.name), ["Crime Pick", "Romance Pick"]);
  assert.equal(r.fresh[0].because, "Line of Duty");

  // A solo verdict counts for less on the together list.
  const soloLoved = titles.map((t) => (t.id === 2 ? { ...t, audience: "solo" } : t));
  const fullTogether = genreAffinity(titles, [{ title_id: 2, verdict: "loved" }], "together").get("romance");
  const crossSolo = genreAffinity(soloLoved, [{ title_id: 2, verdict: "loved" }], "together").get("romance");
  assert.ok(crossSolo < fullTogether);
  assert.ok(fitScore({ genres: "Romance" }, genreAffinity(titles, feedback, "together")) < 0);
});

test("movies rank on their own and ignore audience", () => {
  const titles = [
    T(1, "A Movie", { kind: "movie", imdb_rating: 7.9 }),
    T(2, "A Doc", { kind: "documentary", imdb_rating: 8.1, audience: "solo" }),
    T(3, "Seen Movie", { kind: "movie", status: "watched" }),
  ];
  const r = recommend({ titles, feedback: [], kind: "movie", today: TODAY });
  assert.deepEqual(r.fresh.map((t) => t.name), ["A Doc", "A Movie"]);
});

test("preferred-language titles (config: en, fr) always rank before other languages; ready seasons are exempt", () => {
  const titles = [
    T(1, "Tangerines", { imdb_rating: 9.1, original_language: "ko" }),
    T(2, "MobLand", { imdb_rating: 8.0, original_language: "en" }),
    T(3, "Le Bureau", { imdb_rating: 8.5, original_language: "fr" }),
    T(4, "Unknown Lang", { imdb_rating: 7.6 }),
    T(5, "Squid Game", { status: "watched", original_language: "ko", seasons: [season(1, "watched"), season(2, "unwatched", { finale_date: "2026-09-01" })] }),
  ];
  const r = recommend({ titles, feedback: [], audience: "together", kind: "show", today: TODAY });
  assert.deepEqual(r.fresh.map((t) => t.name), ["Le Bureau", "MobLand", "Unknown Lang", "Tangerines"]);
  assert.deepEqual(r.ready.map((t) => t.name), ["Squid Game"]);
});

test("stated preferences: together likes action/spy/comedy, nobody likes romance, sci-fi is solo", () => {
  const prefs = [
    { audience: "together", tag: "action", weight: 1 },
    { audience: "together", tag: "spy", weight: 1 },
    { audience: "together", tag: "comedy", weight: 1 },
    { audience: "all", tag: "romance", weight: -1.5 },
    { audience: "solo", tag: "sci-fi", weight: 1 },
    { audience: "together", tag: "sci-fi", weight: -0.5 },
  ];
  const titles = [
    T(1, "Spy Thing", { imdb_rating: 7.8, genres: "Drama, Crime", keywords: "espionage, mi6" }),
    T(2, "Love Story", { imdb_rating: 8.4, genres: "Drama", keywords: "love story" }),
    T(3, "Space Show", { imdb_rating: 8.0, genres: "Sci-Fi & Fantasy" }),
    T(4, "Space Solo", { imdb_rating: 8.0, genres: "Sci-Fi & Fantasy", audience: "solo" }),
  ];
  const together = recommend({ titles, feedback: [], prefs, audience: "together", kind: "show", today: TODAY });
  assert.deepEqual(together.fresh.map((t) => t.name), ["Spy Thing", "Space Show", "Love Story"]);
  assert.deepEqual(together.fresh[0].liked_tags, ["spy"]);
  assert.ok(prefScore(titles[2], prefs, "solo").pref > prefScore(titles[2], prefs, "together").pref);
  assert.ok(tasteFit(titles[1], new Map(), prefs, "together") < -0.4);   // discovery gate rejects romance
});
