import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A synthetic installation: owner "Alex" (id alex), partner "Sam" (id sam).
const local = fs.mkdtempSync(path.join(os.tmpdir(), "watch-test-"));
fs.mkdirSync(path.join(local, "config"));
fs.writeFileSync(path.join(local, "config", "watchlist.json"), JSON.stringify({ partner_id: "sam", partner_name: "Sam", preferred_languages: ["en", "fr"] }));
process.env.JORI_LOCAL_DIR = local;
process.env.JORI_OWNER_NAME = "Alex";
process.env.JORI_OWNER_ID = "alex";
process.env.JORI_TZ = "UTC";
const {
  selectPending, rtUrl, tmdbFacts, omdbFacts, renderCard, subjectFor, wikidataRtId,
  pickTrailer, trailerLink, searchHit, imdbSearchUrl, renderNewRows,
} = await import("../lib/watch-intro.mjs");

const now = new Date("2026-10-10T12:00:00Z");
const row = (o) => ({ id: 1, name: "X", kind: "show", status: "queued", audience: "together", added_at: "2026-10-09T00:00:00Z", intro_emailed_at: null, ...o });

test("selectPending: recent, un-introduced, still-wanted titles, newest first", () => {
  const got = selectPending([
    row({ id: 1, added_at: "2026-10-01T00:00:00Z" }),
    row({ id: 2, added_at: "2026-10-09T00:00:00Z" }),
    row({ id: 3, intro_emailed_at: "2026-10-09T00:00:00Z" }),
    row({ id: 4, status: "rejected" }),
    row({ id: 5, status: "watched" }),
    row({ id: 6, added_at: "2026-08-01T00:00:00Z" }),
    row({ id: 7, status: "watching" }),
  ], { now });
  assert.deepEqual(got.map((t) => t.id), [2, 7, 1]);
});

test("rtUrl: Wikidata id when known, search otherwise", () => {
  assert.equal(rtUrl("tv/severance", "Severance"), "https://www.rottentomatoes.com/tv/severance");
  assert.equal(rtUrl(null, "Slow Horses"), "https://www.rottentomatoes.com/search?search=Slow%20Horses");
});

test("tmdbFacts: tv cast from aggregate_credits, creators, images", () => {
  const f = tmdbFacts({
    backdrop_path: "/b.jpg", poster_path: "/p.jpg", overview: "o", number_of_seasons: 2, episode_run_time: [50],
    created_by: [{ name: "Dan Erickson" }],
    aggregate_credits: { cast: [{ name: "Adam Scott", roles: [{ character: "Mark" }], profile_path: "/a.jpg" }] },
  }, "tv");
  assert.equal(f.backdrop, "https://image.tmdb.org/t/p/w780/b.jpg");
  assert.deepEqual(f.cast[0], { name: "Adam Scott", role: "Mark", photo: "https://image.tmdb.org/t/p/w185/a.jpg" });
  assert.deepEqual(f.creators, ["Dan Erickson"]);
  assert.equal(f.seasons, 2);
});

test("tmdbFacts: movie directors from crew", () => {
  const f = tmdbFacts({ runtime: 120, credits: { cast: [], crew: [{ job: "Director", name: "D" }, { job: "Writer", name: "W" }] } }, "movie");
  assert.deepEqual(f.creators, ["D"]);
  assert.equal(f.runtime, 120);
});

test("omdbFacts: ratings by source, N/A awards dropped", () => {
  const f = omdbFacts({ Response: "True", Awards: "N/A", Ratings: [
    { Source: "Internet Movie Database", Value: "8.7/10" }, { Source: "Rotten Tomatoes", Value: "97%" }, { Source: "Metacritic", Value: "83/100" }] });
  assert.deepEqual(f.ratings, { imdb: "8.7/10", rt: "97%", metacritic: "83/100" });
  assert.equal(f.awards, null);
  assert.deepEqual(omdbFacts({ Response: "False" }), {});
});

test("renderCard: escapes, links, prose fallback to synopsis", () => {
  const html = renderCard(row({ name: "A <b>", year_start: 2026 }), { overview: "Syn & opsis", imdb: "https://www.imdb.com/title/tt1/", rt: rtUrl(null, "A"), ratings: { rt: "90%" } });
  assert.match(html, /A &lt;b&gt;/);
  assert.match(html, /Syn &amp; opsis/);
  assert.match(html, /imdb\.com\/title\/tt1/);
  assert.match(html, /rottentomatoes\.com\/search/);
  assert.doesNotMatch(html, /will like it/);
  assert.match(html, /Added to Alex &amp; Sam's list/);
  assert.match(renderCard(row({}), { rt: "r" }, { why: "Because Slow Horses." }), /Why Alex &amp; Sam will like it/);
  assert.match(renderCard(row({ audience: "solo" }), { rt: "r" }, { why: "x" }), /Why Alex will like it/);
});

test("subjectFor: 1, 2, many", () => {
  assert.equal(subjectFor([{ name: "A" }]), "New on your watchlist: A");
  assert.equal(subjectFor([{ name: "A" }, { name: "B" }]), "New on your watchlist: A and B");
  assert.equal(subjectFor([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }]), "New on your watchlist: A, B and 2 more");
});

test("wikidataRtId: follows search → claims; null on miss or error", async () => {
  const fetchFn = async (url) => ({ json: async () => url.includes("list=search")
    ? { query: { search: [{ title: "Q1" }] } }
    : { claims: { P1258: [{ mainsnak: { datavalue: { value: "tv/severance" } } }] } } });
  assert.equal(await wikidataRtId("tt11280740", { fetchFn }), "tv/severance");
  assert.equal(await wikidataRtId(null, { fetchFn }), null);
  assert.equal(await wikidataRtId("tt1", { fetchFn: async () => { throw new Error("x"); } }), null);
});

// 2026-10-11 — every row of the weekly movie email needs a tappable link and a description,
// and new films a preview.

const vid = (o) => ({ site: "YouTube", type: "Trailer", official: true, iso_639_1: "en", size: 1080, published_at: "2026-08-05", key: "k", ...o });

test("pickTrailer: Trailer over teaser, English, official, sharpest, earliest; YouTube/Vimeo only", () => {
  assert.equal(pickTrailer([vid({ type: "Teaser", key: "teaser" }), vid({ type: "Featurette", key: "feat" }), vid({ key: "uk" }),
    vid({ key: "final", size: 2160, published_at: "2026-07-15" })]), "https://www.youtube.com/watch?v=final");
  assert.equal(pickTrailer([vid({ key: "fan", official: false }), vid({ key: "off" })]), "https://www.youtube.com/watch?v=off");
  assert.equal(pickTrailer([vid({ key: "fr", iso_639_1: "fr" }), vid({ key: "en", official: false })]), "https://www.youtube.com/watch?v=en");
  assert.equal(pickTrailer([vid({ key: "early", published_at: "2014-07-08" }), vid({ key: "late", published_at: "2020-01-13" })]), "https://www.youtube.com/watch?v=early");
  assert.equal(pickTrailer([vid({ type: "Teaser", key: "t" })]), "https://www.youtube.com/watch?v=t");
  assert.equal(pickTrailer([vid({ site: "Vimeo", key: "9" })]), "https://vimeo.com/9");
  assert.equal(pickTrailer([vid({ site: "Dailymotion" }), vid({ type: "Clip" })]), null);
  assert.equal(pickTrailer(null), null);
});

test("trailerLink: TMDB video direct; else a YouTube search for a recent or unmatched title; else none", () => {
  const now = new Date("2026-10-11T00:00:00Z");
  assert.deepEqual(trailerLink([vid({ key: "x" })], { name: "Runner", year: 2026, now }), { url: "https://www.youtube.com/watch?v=x", direct: true });
  assert.deepEqual(trailerLink([], { name: "Runner", year: 2026, now }),
    { url: "https://www.youtube.com/results?search_query=Runner%202026%20trailer", direct: false });
  assert.equal(trailerLink([], { name: "Runner", year: 2025, now }).direct, false);
  assert.equal(trailerLink([], { name: "Heat", year: 1995, now }), null);
  assert.equal(trailerLink([], { name: "Unknown Show", year: 1995, matched: false, now }).direct, false);
});

test("searchHit: same name and year within one, never a near miss", () => {
  const norm = (x) => String(x).toLowerCase().trim();
  const results = [{ id: 1, name: "The Gentlemen", first_air_date: "2024-03-07" }, { id: 2, title: "Runner", release_date: "2026-09-07" }];
  assert.equal(searchHit(results, { name: "The Gentlemen: Italy", year: 2026 }, norm), null);
  assert.equal(searchHit(results, { name: "runner", year: 2025 }, norm).id, 2);
  assert.equal(searchHit(results, { name: "Runner", year: 2020 }, norm), null);
  assert.equal(searchHit(results, { name: "The Gentlemen", year: null }, norm).id, 1);
  assert.equal(searchHit(undefined, { name: "x" }, norm), null);
  // No year on the row: a name two results share is ambiguous → no match.
  const twins = [{ id: 7, title: "Heat", release_date: "1995-12-15" }, { id: 8, title: "Heat", release_date: "1986-03-14" }];
  assert.equal(searchHit(twins, { name: "Heat", year: null }, norm), null);
  assert.equal(searchHit(twins, { name: "Heat", year: 1995 }, norm).id, 7);
  // Year known, result undated: accepted only when it is the one result with that name.
  assert.equal(searchHit([{ id: 9, title: "Soon" }], { name: "Soon", year: 2027 }, norm).id, 9);
});

test("tmdbFacts + omdbFacts: IMDb id from TMDB, videos, OMDb plot", () => {
  const f = tmdbFacts({ external_ids: { imdb_id: "tt9" }, videos: { results: [vid({})] } }, "tv");
  assert.equal(f.imdb_id, "tt9");
  assert.equal(f.videos.length, 1);
  assert.equal(tmdbFacts({ imdb_id: "tt1" }, "movie").imdb_id, "tt1");
  assert.equal(omdbFacts({ Response: "True", Plot: "A plot." }).plot, "A plot.");
  assert.equal(omdbFacts({ Response: "True", Plot: "N/A" }).plot, null);
});

test("renderCard: picture and name open IMDb, trailer button, never bare without TMDB", () => {
  const html = renderCard(row({ name: "Runner", kind: "movie", year_start: 2026 }),
    { backdrop: "https://img/b.jpg", imdb: "https://www.imdb.com/title/tt31349844/", rt: "r", trailer: { url: "https://www.youtube.com/watch?v=m8", direct: true } });
  assert.match(html, /<a href="https:\/\/www\.imdb\.com\/title\/tt31349844\/" style="display:block;"><img src="https:\/\/img\/b\.jpg"/);
  assert.match(html, /<h2[^>]*><a href="https:\/\/www\.imdb\.com\/title\/tt31349844\/"[^>]*>Runner<\/a><\/h2>/);
  assert.match(html, /youtube\.com\/watch\?v=m8"[^>]*>&#9654;&#xFE0E; Trailer</);
  // No TMDB match, no IMDb id: the list's own description, an IMDb search, a trailer search.
  const bare = renderCard(row({ name: "The Gentlemen: Italy", year_start: 2026, description: "Own words & all." }),
    { trailer: { url: "https://www.youtube.com/results?search_query=x", direct: false } });
  assert.match(bare, /Own words &amp; all\./);
  assert.ok(bare.includes(`href="${imdbSearchUrl("The Gentlemen: Italy", 2026).replace(/&/g, "&amp;")}"`));
  assert.match(bare, /Find the trailer/);
  assert.match(bare, /rottentomatoes\.com\/search/);
  // Nothing to say about it at all → no empty "What it's about" heading.
  assert.doesNotMatch(renderCard(row({ description: null }), { rt: "r" }), /What it's about/);
});

test("renderNewRows: every row has a synopsis, opens IMDb, and links the trailer", () => {
  const runner = { tmdb_id: 1377237, imdb_id: "tt31349844", title: "Runner", year: 2026, poster_path: "/p.jpg", genres: "Action, Comedy",
    model_p: 0.875, imdb_rating: 6.6, in_theaters: true, providers: { stream: [] },
    overview: "A former soldier is thrown into a race against time.", trailer: { url: "https://www.youtube.com/watch?v=m8", direct: true } };
  const html = renderNewRows([runner]);
  assert.match(html, /A former soldier is thrown into a race against time\./);
  assert.match(html, /<a href="https:\/\/www\.imdb\.com\/title\/tt31349844\/" style="display:block;"><img/);
  assert.equal(html.split("https://www.imdb.com/title/tt31349844/").length - 1, 3); // poster, name + synopsis, button
  assert.match(html, /youtube\.com\/watch\?v=m8"[^>]*>&#9654;&#xFE0E; Trailer</);
  assert.match(html, /88% match<\/b> · IMDb 6\.6 · Action, Comedy/);
  assert.match(html, /in theaters now/);
  // No IMDb id and no trailer: an IMDb search link, no trailer button.
  const noIds = renderNewRows([{ ...runner, imdb_id: null, trailer: null }]);
  assert.match(noIds, /imdb\.com\/find\/\?q=Runner%202026&amp;s=tt/);
  assert.doesNotMatch(noIds, /Trailer/);
  assert.equal(renderNewRows([]), "");
});
