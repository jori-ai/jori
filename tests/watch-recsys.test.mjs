import { test } from "node:test";
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
const R = await import("../lib/watch-recsys.mjs");

const film = (id, o = {}) => ({ kind: "movie", tmdb_id: id, title: `F${id}`, year: 2010, genres: "Crime, Thriller", keywords: "heist", directors: "Michael Mann", cast_names: "Al Pacino", original_language: "en", vote_count: 10000, vote_average: 7.8, features_at: "x", ...o });

test("featuresOf splits TMDB TV genres and namespaces everything", () => {
  const f = R.featuresOf({ genres: "Sci-Fi & Fantasy, Drama", keywords: "Spy|Heist", directors: "A B", cast_names: "C", year: 1994, original_language: "en" });
  for (const x of ["g:science fiction", "g:fantasy", "g:drama", "k:spy", "k:heist", "d:a b", "c:c", "e:1990s", "l:en"]) assert.ok(f.includes(x), x);
});

test("assembleLabels: site rating beats chat verdict beats implicit status; cleanup counts less", () => {
  const titles = [{ id: 1, kind: "movie", tmdb_id: 11, status: "watched" }, { id: 2, kind: "show", tmdb_id: 22, status: "rejected", source: "legacy" }];
  const feedback = [{ title_id: 1, verdict: "liked", source: "chat" }, { title_id: 2, verdict: "not_interested", source: "cleanup" }];
  const ratings = [{ title_id: 1, person: "alex", verdict: "loved" }, { title_id: 1, person: "sam", verdict: "meh" }];
  const L = R.assembleLabels({ titles, feedback, ratings });
  assert.deepEqual([L.get("movie:11").score, L.get("movie:11").why], [1, "rated"]);
  assert.equal(L.get("show:22").score, -1);
  assert.ok(L.get("show:22").conf < 0.6);
});

test("model: liked features push p up, stated dislikes push p down", () => {
  const catalog = [film(1), film(2, { genres: "Horror", keywords: "slasher", directors: "X", cast_names: "Y" }), film(3), film(4, { genres: "Horror", keywords: "ghost", directors: "Z", cast_names: "W" })];
  const labels = new Map([["movie:1", { score: 2, conf: 1 }]]);
  const m = R.buildModel({ catalog, labels, prefs: [{ audience: "all", tag: "horror", weight: -1.5 }] });
  assert.ok(R.predict(m, film(3)).p > R.predict(m, catalog[3]).p);
  assert.ok(R.predict(m, catalog[3]).minus?.f.startsWith("g:horror") || R.predict(m, catalog[3]).minus?.f.startsWith("k:"));
});

test("collaborative edges carry a loved film's score to its neighbours", () => {
  const catalog = [film(1), film(5, { genres: "Comedy", keywords: "", directors: "Q", cast_names: "R" }), film(6, { genres: "Comedy", keywords: "", directors: "S", cast_names: "T" })];
  const labels = new Map([["movie:1", { score: 2, conf: 1 }]]);
  const m = R.buildModel({ catalog, labels, edges: [{ src_tmdb: 1, dst_tmdb: 5, weight: 1 }] });
  assert.ok(R.predict(m, catalog[1]).p > R.predict(m, catalog[2]).p);
});

test("designBatch: five diverse picks, one per question, never two by the same director", () => {
  const pool = Array.from({ length: 80 }, (_, i) => film(100 + i, {
    genres: ["Crime", "Comedy", "Drama", "Western", "Science Fiction", "War"][i % 6], keywords: `k${i}`, directors: `D${i % 25}`, cast_names: `C${i}`, vote_count: 1000 + i * 500,
  }));
  const labels = new Map(Array.from({ length: 20 }, (_, i) => [`movie:${100 + i}`, { score: i % 3 ? 1 : -1, conf: 1 }]));
  const m = R.buildModel({ catalog: pool, labels });
  const b = R.designBatch(m, pool.slice(20));
  assert.equal(b.length, 5);
  assert.deepEqual([...new Set(b.map((x) => x.slot))].sort(), ["confirm", "contrast", "explore", "probe"]);
  const dirs = b.map((x) => x.row.directors);
  assert.equal(new Set(dirs).size, dirs.length);
  assert.ok(b.every((x) => typeof x.why === "string" && x.why.length));
});

test("designBatch never asks about kids' films or TV movies", () => {
  const pool = [film(1, { genres: "Family, Animation" }), film(2, { genres: "TV Movie" }), film(3, { genres: "Crime" })];
  const b = R.designBatch(R.buildModel({ catalog: pool, labels: new Map() }), pool);
  assert.deepEqual(b.map((x) => x.row.tmdb_id), [3]);
});

test("accuracy scores up/down/meh against the logged prediction", () => {
  const a = R.accuracy([{ shown: [{ tmdb_id: 1, p: 0.8 }, { tmdb_id: 2, p: 0.3 }, { tmdb_id: 3, p: 0.5 }, { tmdb_id: 4, p: 0.9 }], marks: { 1: "up", 2: "up", 3: "meh" } }]);
  assert.deepEqual(a, { hit: 2, n: 3 });
});

test("a 👎'd franchise is settled: none of its films are offered again", () => {
  const pirates = (id) => film(id, { genres: "Adventure, Fantasy", keywords: "pirate", directors: `V${id}`, cast_names: "Johnny Depp", collection: "Pirates of the Caribbean Collection" });
  const pool = [pirates(1), pirates(2), pirates(3), ...Array.from({ length: 12 }, (_, i) => film(10 + i, { genres: ["Crime", "Drama", "War", "Western"][i % 4], directors: `D${i}`, keywords: `k${i}`, cast_names: `C${i}` }))];
  const labels = new Map([["movie:1", { score: -1, conf: 0.9 }]]);
  const m = R.buildModel({ catalog: pool, labels });
  const b = R.designBatch(m, pool.slice(1));
  assert.ok(!b.some((x) => x.row.collection), b.map((x) => x.row.title).join(","));
});

test("a stated dislike is a dealbreaker, not averaged away by other genres", () => {
  const pool = [film(1, { genres: "Horror, Mystery, Thriller", keywords: "", directors: "J", cast_names: "P" }), film(2, { genres: "Mystery, Thriller", keywords: "", directors: "K", cast_names: "Q" })];
  const m = R.buildModel({ catalog: pool, labels: new Map(), prefs: [{ audience: "all", tag: "horror", weight: -1.5 }] });
  assert.ok(R.predict(m, pool[1]).p - R.predict(m, pool[0]).p > 0.25);
});

test("fitTaste learns a direction from labelled film vectors", () => {
  const E = new Map([[1, [1, 0]], [2, [0.9, 0.1]], [3, [-1, 0]], [4, [-0.9, -0.1]], [5, [0.95, 0.05]], [6, [-0.95, 0]]]);
  const labels = new Map([["movie:1", { score: 2, conf: 1 }], ["movie:2", { score: 1, conf: 1 }], ["movie:3", { score: -1, conf: 1 }], ["movie:4", { score: -1, conf: 1 }]]);
  const t = R.fitTaste(labels, E);
  assert.ok(t.mu[0] > 0.5 && t.n === 4);
  const catalog = [5, 6].map((id) => film(id, { genres: "Drama", keywords: "", directors: `D${id}`, cast_names: `C${id}` }));
  const m = R.buildModel({ catalog, labels, embeddings: E });
  assert.ok(R.predict(m, catalog[0]).p > R.predict(m, catalog[1]).p);
});

test("committee batch: four learning picks + one likely favourite once the taste is fitted", () => {
  const E = new Map(), catalog = [];
  for (let i = 0; i < 120; i++) {
    const r = R.rng(i + 1); const v = Array.from({ length: 8 }, () => r() * 2 - 1); const n = Math.hypot(...v); E.set(1000 + i, v.map((x) => x / n));
    catalog.push(film(1000 + i, { genres: ["Crime", "Drama", "War", "Western", "Comedy", "History"][i % 6], keywords: `k${i}`, directors: `D${i}`, cast_names: `C${i}`, vote_count: 2000 + i * 100 }));
  }
  const labels = new Map(Array.from({ length: 30 }, (_, i) => [`movie:${1000 + i * 4}`, { score: E.get(1000 + i * 4)[0] > 0 ? 1 : -1, conf: 1 }]));
  const m = R.buildModel({ catalog, labels, embeddings: E });
  const b = R.designBatch(m, catalog.filter((r) => !labels.has(`movie:${r.tmdb_id}`)), { seed: 7 });
  assert.equal(b.length, 5);
  assert.deepEqual(b.map((x) => x.slot), ["learn", "learn", "learn", "learn", "confirm"]);
});

test("horror rule: horror-led films only; hybrids are exempt", () => {
  assert.equal(R.isHorrorLed("Horror, Thriller"), true);
  assert.equal(R.isHorrorLed("Horror, Mystery, Fantasy"), true);
  assert.equal(R.isHorrorLed("Horror, Science Fiction"), false);
  assert.equal(R.isHorrorLed("Comedy, Horror"), false);
  assert.equal(R.isHorrorLed("Drama, Thriller"), false);
});

test("a new release with one 10/10 vote does not get the quality of a 10", () => {
  const base = { kind: "movie", genres: "Drama", features_at: "x" };
  const m = R.buildModel({ catalog: [], labels: new Map(), prefs: [] });
  const one = R.predict(m, { ...base, tmdb_id: 1, vote_average: 10, vote_count: 1 }).p;
  const many = R.predict(m, { ...base, tmdb_id: 2, vote_average: 8.5, vote_count: 20000 }).p;
  assert.ok(many > one, `established 8.5 (${many}) should beat a single 10 vote (${one})`);
});
