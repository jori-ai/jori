// watch-db.mjs — shared data layer for the shows & movies list (v2).
//
// Tables (data/migrations/20261004_watch_titles.sql):
//   watch_titles   one row per show/movie/doc  (audience: solo|together|<partner_id>)
//   watch_seasons  one row per season of a show
//   watch_feedback append-only verdicts that recommendations learn from
//
// Every consumer — the `watchlist` CLI, next-show, watchlist-season-check,
// watch-discover, the hum harvesters — goes through this module, so title
// resolution, TMDB lookups and the fully-dropped rule live in exactly one place.
//
// Writes always target ONE row by id. `resolveTitle` turns free text into that
// id and refuses to guess when the text matches more than one title (the v1
// `ilike %title%` writes are what made the old list self-corrupting).

import { createRequire } from "node:module";
import fs from "node:fs";
import nodePath from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const { request } = require("./supabase-rest.js"); // also loads .env
const { instance } = require("./instance.cjs");
import { PARTNER, watchConfig, ownerId } from "./watch-config.mjs";

// ---------------------------------------------------------------------------
// basics

// Today in the installation's local zone (instance().tz). The name is historical.
export function todayEt(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: instance().tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export const AUDIENCES = ["solo", "together", PARTNER];
export const KINDS = ["show", "movie", "documentary"];
// Languages that rank normally; everything else sorts after them (config preferred_languages).
export const PREFERRED_LANGUAGES = new Set(watchConfig().preferred_languages || ["en"]);
export function languageName(code) {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code); } catch { return code; }
}

export const VERDICTS = ["loved", "liked", "meh", "disliked", "dropped", "not_interested"];

// v1 category names are still what chat sessions and old prompts say; accept them.
const AUDIENCE_ALIASES = {
  solo: "solo", my_shows: "solo", mine: "solo", me: "solo",
  together: "together", us: "together", both: "together",
  partner: PARTNER, partner_only: PARTNER, [PARTNER]: PARTNER, [`${PARTNER}_only`]: PARTNER,
  movies: "together", documentaries: "together",
};
export function audienceFrom(v) {
  if (!v) return null;
  return AUDIENCE_ALIASES[String(v).toLowerCase()] || null;
}
export function kindFrom(type, category) {
  const t = String(type || "").toLowerCase();
  if (t === "movie" || t === "film") return "movie";
  if (t === "documentary" || t === "doc") return "documentary";
  if (t === "show" || t === "tv" || t === "series") return "show";
  if (category === "movies") return "movie";
  if (category === "documentaries") return "documentary";
  return null;
}

/** Normalized comparison key for a title name. */
export function normName(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/**
 * Split a season reference off a title: "Slow Horses Season 5", "Slow Horses S5",
 * "Slow Horses (Season 5)", "Slow Horses: Season 5", "Love Death and Robots Vol 2".
 * Returns { base, season } with season=null when there is no suffix.
 */
export function parseSeasonRef(input) {
  const s = String(input || "").trim();
  // The separator before the keyword is mandatory, and bare "S" must touch its
  // digits, so "Ocean's 11" and "Apollo 13" are not season references.
  const m = s.match(/^(.*?)(?:\s*[:,–-]\s*|\s+|\s*\(\s*)(?:(?:season|series|part|vol(?:ume)?\.?)\s*(\d{1,2})|s(\d{1,2}))\s*\)?$/i);
  if (m && m[1].trim()) return { base: m[1].trim(), season: parseInt(m[2] || m[3], 10) };
  return { base: s, season: null };
}

// ---------------------------------------------------------------------------
// Supabase

export async function rest(path, opts) {
  return request(`/rest/v1/${path}`, opts);
}

export async function loadAll() {
  const [titles, seasons, feedback, prefs, ratings] = await Promise.all([
    rest("watch_titles?select=*&order=name"),
    rest("watch_seasons?select=*&order=title_id,n"),
    rest("watch_feedback?select=*&order=created_at"),
    rest("watch_taste_prefs?select=*"),
    rest("watch_ratings?select=*").catch(() => []),
  ]);
  const byTitle = new Map();
  for (const s of seasons) {
    if (!byTitle.has(s.title_id)) byTitle.set(s.title_id, []);
    byTitle.get(s.title_id).push(s);
  }
  for (const t of titles) t.seasons = byTitle.get(t.id) || [];
  const byIdT = new Map(titles.map((t) => [t.id, t]));
  // Per-person ratings from the ratings site join the feedback stream as one combined
  // verdict per title (newest, so they win latestVerdicts), so every recommender
  // learns from them unchanged. Who said what stays in `ratings`.
  for (const v of combineRatings(ratings, byIdT)) feedback.push(v);
  return { titles, feedback, prefs, ratings };
}

const RATING_SCORE = { loved: 2, liked: 1, meh: 0, disliked: -1 };
const SCORE_VERDICT = { 2: "loved", 1: "liked", 0: "meh", "-1": "disliked" };
/**
 * watch_ratings rows → one synthetic feedback row per title: solo → the user's
 * rating, partner → the partner's, together → the rounded-down mean of whoever rated it
 * (a title one of them disliked shouldn't read as a hit). Pure; exported for tests.
 */
export function combineRatings(ratings, titlesById) {
  const me = ownerId();
  const per = new Map();
  for (const r of ratings || []) {
    if (!(r.verdict in RATING_SCORE)) continue;
    (per.get(r.title_id) || per.set(r.title_id, []).get(r.title_id)).push(r);
  }
  const out = [];
  for (const [id, rs] of per) {
    const aud = titlesById.get(id)?.audience;
    const pick = aud === "solo" ? rs.filter((r) => r.person === me) : aud === PARTNER ? rs.filter((r) => r.person === PARTNER) : rs;
    if (!pick.length) continue;
    const mean = Math.floor(pick.reduce((s, r) => s + RATING_SCORE[r.verdict], 0) / pick.length);
    const at = pick.map((r) => r.updated_at).sort().at(-1);
    out.push({ title_id: id, verdict: SCORE_VERDICT[mean], season_n: null, note: null, source: "web", created_at: at });
  }
  return out;
}

export async function insertTitle(row) {
  const [t] = await rest("watch_titles", { method: "POST", body: row, prefer: "return=representation" });
  return t;
}
export async function patchTitle(id, patch) {
  const [t] = await rest(`watch_titles?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=representation" });
  return t;
}
export async function upsertSeason(titleId, n, patch) {
  const [s] = await rest("watch_seasons?on_conflict=title_id,n", {
    method: "POST",
    body: { title_id: titleId, n, ...patch },
    prefer: "resolution=merge-duplicates,return=representation",
  });
  return s;
}
export async function patchSeason(id, patch) {
  const [s] = await rest(`watch_seasons?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=representation" });
  return s;
}
export async function addFeedback(titleId, verdict, { season = null, note = null, source = "chat" } = {}) {
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
  const [f] = await rest("watch_feedback", {
    method: "POST",
    body: { title_id: titleId, verdict, season_n: season, note, source },
    prefer: "return=representation",
  });
  return f;
}

// ---------------------------------------------------------------------------
// resolution — free text → exactly one title

/**
 * @returns {{title:object}|{ambiguous:object[]}|{none:true}}
 * Order: imdb id → exact normalized name → unique word-boundary prefix →
 * unique substring. Anything matching >1 title at the first tier that matches
 * comes back ambiguous — callers print the choices and stop.
 */
export function resolveTitle(titles, query, { includeRejected = true } = {}) {
  const pool = includeRejected ? titles : titles.filter((t) => t.status !== "rejected");
  const q = String(query || "").trim();
  if (!q) return { none: true };
  if (/^tt\d+$/.test(q)) {
    const t = pool.find((x) => x.imdb_id === q);
    return t ? { title: t } : { none: true };
  }
  const n = normName(q);
  const tiers = [
    (t) => normName(t.name) === n,
    (t) => normName(t.name).startsWith(n + " "),
    (t) => (" " + normName(t.name) + " ").includes(" " + n + " "),
  ];
  for (const test of tiers) {
    const hits = pool.filter(test);
    if (hits.length === 1) return { title: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
  }
  return { none: true };
}

/** Find an existing title for a candidate (dedup on ids first, then name+kind). */
export function findExisting(titles, { imdb_id, tmdb_id, name, kind }) {
  if (imdb_id) { const t = titles.find((x) => x.imdb_id === imdb_id); if (t) return t; }
  if (tmdb_id && kind) { const t = titles.find((x) => x.tmdb_id === tmdb_id && x.kind === kind); if (t) return t; }
  const n = normName(name);
  return titles.find((x) => normName(x.name) === n && (!kind || x.kind === kind || (kind !== "show") === (x.kind !== "show"))) || null;
}

// ---------------------------------------------------------------------------
// TMDB (metadata, seasons, air dates) and OMDb (IMDb rating only)

async function tmdb(path) {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY missing (.env)");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.themoviedb.org/3/${path}${sep}api_key=${key}`, { signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB ${res.status} ${path}`);
  return res.json();
}

export function hasTmdb() { return !!process.env.TMDB_API_KEY; }

/** A raw TMDB v3 GET (parsed JSON, null on 404) — for callers that page TMDB lists themselves. */
export async function tmdbGet(path) { return tmdb(path); }

/** US (or `region`) streaming providers for a TV show or film, as the short names `platform` holds. */
export async function tmdbWatchProviders(media, id, region = "US") {
  const d = await tmdb(`${media}/${id}/watch/providers`);
  return d?.results?.[region] || null;
}

export async function tmdbFindByImdb(imdbId) {
  const d = await tmdb(`find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
  if (d?.tv_results?.length) return { media: "tv", id: d.tv_results[0].id };
  if (d?.movie_results?.length) return { media: "movie", id: d.movie_results[0].id };
  // A season/episode imdb id resolves to its parent show.
  const ep = d?.tv_episode_results?.[0] || d?.tv_season_results?.[0];
  if (ep?.show_id) return { media: "tv", id: ep.show_id };
  return null;
}

export async function tmdbSearch(name, kind, year) {
  const media = kind === "show" ? "tv" : "movie";
  const yq = year ? `&${media === "tv" ? "first_air_date_year" : "year"}=${year}` : "";
  const d = await tmdb(`search/${media}?query=${encodeURIComponent(name)}${yq}`);
  const r = d?.results?.[0];
  return r ? { media, id: r.id } : null;
}

// TMDB returns tv keywords under .results and movie keywords under .keywords.
function keywordList(d) {
  const k = d?.keywords?.results || d?.keywords?.keywords || [];
  return k.map((x) => x.name).join(", ") || null;
}

/** Full metadata for a TMDB id, normalized to watch_titles columns. */
export async function tmdbDetails(media, id) {
  const d = await tmdb(`${media}/${id}?append_to_response=external_ids,keywords`);
  if (!d) return null;
  const genres = (d.genres || []).map((g) => g.name).join(", ") || null;
  const keywords = keywordList(d);
  if (media === "tv") {
    return {
      tmdb_id: d.id,
      name: d.name,
      imdb_id: d.external_ids?.imdb_id || null,
      year_start: d.first_air_date ? parseInt(d.first_air_date.slice(0, 4), 10) : null,
      year_end: d.status === "Ended" && d.last_air_date ? parseInt(d.last_air_date.slice(0, 4), 10) : null,
      genres,
      description: d.overview || null,
      original_language: d.original_language || null,
      keywords,
      _tv: d,
    };
  }
  return {
    tmdb_id: d.id,
    name: d.title,
    imdb_id: d.imdb_id || d.external_ids?.imdb_id || null,
    year_start: d.release_date ? parseInt(d.release_date.slice(0, 4), 10) : null,
    genres,
    description: d.overview || null,
    original_language: d.original_language || null,
    keywords,
    release_date: d.release_date || null,
    is_documentary: (d.genres || []).some((g) => g.name === "Documentary"),
  };
}

/**
 * Per-season air facts for a TV show, from the show's details payload plus one
 * season call for the latest season (the only one whose completeness is in doubt).
 * fully_dropped = every episode of the season has an air date on or before today.
 */
export async function tmdbSeasons(tv, today = todayEt()) {
  const out = [];
  const nextEp = tv.next_episode_to_air;
  const seasons = (tv.seasons || []).filter((s) => s.season_number > 0 && s.air_date);
  const latestN = seasons.reduce((m, s) => Math.max(m, s.season_number), 0);
  for (const s of seasons) {
    const row = {
      n: s.season_number,
      episodes_total: s.episode_count || null,
      premiere_date: s.air_date,
      finale_date: null,
      fully_dropped: false,
    };
    if (s.air_date > today) { out.push(row); continue; }
    const needsDetail = s.season_number === latestN || nextEp?.season_number === s.season_number;
    if (!needsDetail) {
      row.fully_dropped = true;
      if (tv.last_episode_to_air?.season_number === s.season_number) row.finale_date = tv.last_episode_to_air.air_date;
      out.push(row);
      continue;
    }
    const d = await tmdb(`tv/${tv.id}/season/${s.season_number}`);
    const eps = d?.episodes || [];
    const dates = eps.map((e) => e.air_date).filter(Boolean).sort();
    row.episodes_total = eps.length || row.episodes_total;
    row.finale_date = dates.length ? dates[dates.length - 1] : null;
    // A season still airing: how far in, and whether its last episode's date is known yet
    // (TMDB lists the episodes with their scheduled air dates; an undated one = finale TBA).
    row.episodes_aired = dates.filter((x) => x <= today).length;
    row.finale_known = eps.length > 0 && dates.length === eps.length;
    row.fully_dropped = eps.length > 0 && dates.length === eps.length && dates[dates.length - 1] <= today
      && nextEp?.season_number !== s.season_number;
    out.push(row);
  }
  return out;
}

/** Look up a candidate by imdb id or name; returns normalized metadata or null. */
export async function lookupMeta({ imdb_id, name, kind, year }) {
  if (!hasTmdb()) return null;
  let hit = imdb_id ? await tmdbFindByImdb(imdb_id) : null;
  if (!hit && name) hit = await tmdbSearch(name, kind || "show", year);
  if (!hit && name && !kind) hit = await tmdbSearch(name, "movie", year);
  if (!hit) return null;
  const meta = await tmdbDetails(hit.media, hit.id);
  if (!meta) return null;
  meta.kind = hit.media === "tv" ? "show" : meta.is_documentary ? "documentary" : "movie";
  if (kind === "documentary") meta.kind = "documentary";
  return meta;
}

/** OMDb scores for an IMDb id: {imdb, votes, rt (percent), metacritic (0-100)}, nulls when unknown. */
export async function omdbRecord(imdbId) {
  const out = { imdb: null, votes: null, rt: null, metacritic: null };
  const key = process.env.OMDB_API_KEY;
  if (!key || !imdbId) return out;
  try {
    const r = await fetch(`https://www.omdbapi.com/?apikey=${key}&i=${imdbId}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    out.imdb = num(j.imdbRating);
    const votes = parseInt(String(j.imdbVotes || "").split(",").join(""), 10); // "18,702"
    out.votes = Number.isFinite(votes) ? votes : null;
    for (const x of j.Ratings || []) {
      if (x.Source === "Rotten Tomatoes") out.rt = num(x.Value);
      if (x.Source === "Metacritic") out.metacritic = num(x.Value);
    }
  } catch {}
  return out;
}

// ---------------------------------------------------------------------------
// IMDb ratings from IMDb's own daily dataset
//
// OMDb's copy of a new series can lag IMDb by weeks to months (no rating at all for a show
// IMDb has rated on thousands of votes), and a rating gate that reads "no rating yet" as
// "skip" then never adds the show. IMDb publishes every title's rating daily at
// IMDB_RATINGS_URL (title.ratings.tsv.gz: tconst, averageRating, numVotes; ~9 MB, sorted by
// tconst; for personal, non-commercial use). One copy lives in data/imdb/, refreshed when
// older than a day; reads stream it and keep only the ids asked for. OMDb stays the source
// for Rotten Tomatoes / Metacritic and the rating fallback when the dataset is unavailable.

export const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
// Below this many votes a show's IMDb rating is noise (a 9.2 on 13 votes): discovery judges
// such a show on its other reviews (bin/watch-discover), and watchlist-season-check only
// copies a listed show's IMDb rating once it has this many.
export const MIN_SHOW_VOTES = 1000;
export const IMDB_RATINGS_MAX_AGE_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// The show database: every series the discovery sweep lists is a watch_catalog row
// (kind 'show') with its facts, where discovery left it (discover_status/_reason) and one
// rating with its source (bin/watch-discover writes them every run).

// The estimate shrinks thin vote averages toward a typical new show, so a 9.4 on 12 votes
// reads as about 7.2 rather than as a hit.
export const ESTIMATE_PRIOR = 7.0;
export const ESTIMATE_PRIOR_WEIGHT = 100;
export const ESTIMATE_MIN_VOTES = 10;

/**
 * One rating per show, and where it came from:
 *   "imdb"     IMDb's own rating, once it has `minVotes` votes;
 *   "reviews"  else the review check's reading of its other reviews (Rotten Tomatoes,
 *              Metacritic, critics; lib/watch-fit.mjs judgeQuality → `review.equivalent`);
 *   "estimate" else the thin IMDb and TMDB averages weighted by their votes, shrunk toward
 *              ESTIMATE_PRIOR;
 *   null       nothing to go on yet (fewer than ESTIMATE_MIN_VOTES votes anywhere).
 * Pure.
 */
export function showRating({ imdb = null, imdbVotes = null, review = null, tmdbAverage = null, tmdbVotes = null, minVotes = MIN_SHOW_VOTES } = {}) {
  const r1 = (x) => Math.round(x * 10) / 10;
  if (imdb != null && (imdbVotes ?? 0) >= minVotes) return { rating: r1(imdb), source: "imdb" };
  if (review?.equivalent != null) return { rating: r1(review.equivalent), source: "reviews" };
  let sum = 0, w = 0;
  if (imdb != null && imdbVotes > 0) { sum += imdb * imdbVotes; w += imdbVotes; }
  if (tmdbAverage > 0 && tmdbVotes > 0) { sum += tmdbAverage * tmdbVotes; w += tmdbVotes; }
  if (w < ESTIMATE_MIN_VOTES) return { rating: null, source: null };
  return { rating: r1((sum + ESTIMATE_PRIOR * ESTIMATE_PRIOR_WEIGHT) / (w + ESTIMATE_PRIOR_WEIGHT)), source: "estimate" };
}

/**
 * Upsert rows into watch_catalog on (kind, tmdb_id). Null/undefined values are dropped and
 * rows are sent grouped by their column set, so a value a run didn't learn never
 * overwrites one a past run stored, and columns the row doesn't carry (title_id, seen,
 * not_for_us …) are left alone. `send` is injectable for tests. Returns rows written.
 */
export async function upsertCatalogRows(rows, { send = (body) => rest("watch_catalog?on_conflict=kind,tmdb_id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body, timeoutMs: 30000 }) } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v != null));
    if (!clean.kind || !clean.tmdb_id || !clean.title) continue;
    const k = Object.keys(clean).sort().join(",");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(clean);
  }
  let n = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i += 200) { await send(g.slice(i, i + 200)); n += Math.min(200, g.length - i); }
  }
  return n;
}

/** Where the dataset copy lives (gitignored runtime data). */
export function imdbRatingsFile() {
  return require("./root.cjs").installTools("data", "imdb", "title.ratings.tsv.gz");
}

const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

/**
 * Make sure a fresh-enough copy of the dataset is on disk: download when it is missing
 * or older than maxAgeMs. A failed download keeps the old copy (a day-old rating beats
 * none). Returns the file path, or null when there is no copy at all.
 */
export async function ensureImdbRatingsFile({
  file = imdbRatingsFile(), maxAgeMs = IMDB_RATINGS_MAX_AGE_MS, now = Date.now(), fetchImpl = fetch, timeoutMs = 90000,
} = {}) {
  let st = null;
  try { st = fs.statSync(file); } catch {}
  if (st && now - st.mtimeMs < maxAgeMs) return file;
  try {
    const res = await fetchImpl(IMDB_RATINGS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isGzip(buf)) throw new Error("not a gzip file");
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file); // atomic: a concurrent reader sees the old copy or the new, never half
    return file;
  } catch {
    return st ? file : null;
  }
}

/** One dataset line ("tt123\t7.4\t20145") → [id, {rating, votes}]; null for the header or junk. */
export function parseImdbRatingLine(line) {
  const [id, r, v] = String(line).split("\t");
  if (!id || !id.startsWith("tt")) return null;
  const rating = parseFloat(r), votes = parseInt(v, 10);
  if (!Number.isFinite(rating) || !Number.isFinite(votes)) return null;
  return [id, { rating, votes }];
}

/**
 * Ratings for the given IMDb ids: Map(id → {rating, votes}); an id IMDb hasn't rated is
 * absent. Null when the dataset is unavailable (no copy and the download failed), so the
 * caller can fall back to OMDb. opts.file reads a given copy; otherwise ensureImdbRatingsFile(opts).
 */
export async function imdbRatings(ids, opts = {}) {
  const wanted = new Set([].concat(ids || []).filter((x) => typeof x === "string" && x.startsWith("tt")));
  const out = new Map();
  if (!wanted.size) return out;
  const file = opts.file || await ensureImdbRatingsFile(opts);
  if (!file) return null;
  const raw = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: raw.pipe(gunzip), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const tab = line.indexOf("\t");
      if (tab < 0 || !wanted.has(line.slice(0, tab))) continue;
      const hit = parseImdbRatingLine(line);
      if (hit) out.set(hit[0], hit[1]);
      if (out.size === wanted.size) break; // nothing left to find
    }
  } catch {
    return out.size ? out : null; // a corrupt copy reads as unavailable, not as "no ratings"
  } finally {
    rl.close(); gunzip.destroy(); raw.destroy();
  }
  return out;
}

export async function omdbRating(imdbId) {
  const key = process.env.OMDB_API_KEY;
  if (!key || !imdbId) return null;
  try {
    const r = await fetch(`https://www.omdbapi.com/?apikey=${key}&i=${imdbId}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const v = parseFloat(j.imdbRating);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Per-season IMDb ratings (2026-11-09)
//
// A new season has no rating of its own when it drops, and the viewers don't wait for one:
// it is assumed to be as good as the show's past seasons, i.e. their average (watch-rank
// assumedSeasonRating; the show's own rating when no season is rated). A season's rating
// is the mean of its episodes' IMDb ratings from OMDb's season listing (?i=<id>&Season=<n>).
// watchlist-season-check refreshes them daily into data/watch-discover/season-ratings.json
// ({<imdb id>: {name, seasons: {<n>: {rating, episodes, at}}}}), only for the seasons an
// assumption needs, and everything that ranks reads that file with no network call.

export const SEASON_RATING_MAX_AGE_DAYS = 30;

/** Where the per-season ratings live (gitignored runtime data). */
export function seasonRatingsFile() {
  return require("./root.cjs").installTools("data", "watch-discover", "season-ratings.json");
}

/** The stored per-season ratings ({} when there are none yet). Sync, no network. */
export function readSeasonRatings(file = seasonRatingsFile()) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

/** OMDb's season listing → {rating (mean of rated episodes, 1 decimal), episodes}; rating null when none is rated. Pure. */
export function seasonMean(listing) {
  const xs = (listing?.Episodes || []).map((e) => parseFloat(e?.imdbRating)).filter(Number.isFinite);
  if (!xs.length) return { rating: null, episodes: 0 };
  return { rating: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, episodes: xs.length };
}

/**
 * One season's rating from OMDb. null when OMDb couldn't answer (unreachable, an HTTP
 * error, the daily request limit, a bad key), so it is retried next run instead of being
 * stored as "no rating" for a month; {rating: null} only when OMDb says it has no such
 * season or none of its episodes is rated.
 */
export async function omdbSeasonRating(imdbId, n, { fetchImpl = fetch } = {}) {
  const key = process.env.OMDB_API_KEY;
  if (!key || !imdbId) return null;
  try {
    const r = await fetchImpl(`https://www.omdbapi.com/?apikey=${key}&i=${imdbId}&Season=${n}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j?.Response === "False") {
      // OMDb's own fixed error string (machine output), e.g. "Series or season not found!".
      return String(j.Error || "").toLowerCase().includes("not found") ? { rating: null, episodes: 0 } : null;
    }
    return seasonMean(j);
  } catch { return null; }
}

/**
 * The seasons an assumed rating needs: for every show followed past season 1 (watched
 * through some season, or marked watched) whose next unwatched season exists, each fully
 * dropped season before it with no stored rating or one older than maxAgeDays. Mirrors the
 * `through` / `next` logic in watch-rank recommend(). Pure.
 */
export function seasonsNeedingRatings(titles, store = {}, { now = Date.now(), maxAgeDays = SEASON_RATING_MAX_AGE_DAYS } = {}) {
  const out = [];
  for (const t of titles || []) {
    if (t.kind !== "show" || !t.imdb_id || ["rejected", "dropped"].includes(t.status)) continue;
    const seasons = (t.seasons || []).slice().sort((a, b) => a.n - b.n);
    const through = seasons.reduce((m, s) => (s.status === "watched" ? Math.max(m, s.n) : m), 0);
    if (!(through > 0 || t.status === "watched")) continue;
    const next = seasons.find((s) => s.n > through && s.status === "unwatched");
    if (!next) continue;
    for (const s of seasons) {
      if (s.n < 1 || s.n >= next.n || !s.fully_dropped) continue;
      const have = store?.[t.imdb_id]?.seasons?.[s.n];
      if (have && now - Date.parse(have.at) < maxAgeDays * 86400000) continue;
      out.push({ imdb_id: t.imdb_id, n: s.n, name: t.name });
    }
  }
  return out;
}

/**
 * Fetch the ratings seasonsNeedingRatings asks for (at most maxCalls OMDb calls a run; the
 * rest come on the next run) and write the file. Returns {needed, calls, updated}.
 */
export async function refreshSeasonRatings(titles, { maxCalls = 60, file = seasonRatingsFile(), fetchSeason = omdbSeasonRating, now = Date.now() } = {}) {
  const store = readSeasonRatings(file);
  const todo = seasonsNeedingRatings(titles, store, { now });
  let calls = 0, updated = 0;
  for (const { imdb_id, n, name } of todo) {
    if (calls >= maxCalls) break;
    calls++;
    const r = await fetchSeason(imdb_id, n);
    if (!r) continue; // OMDb unreachable: try again next run
    const e = (store[imdb_id] ||= { name, seasons: {} });
    e.name = name;
    (e.seasons ||= {})[n] = { rating: r.rating, episodes: r.episodes, at: new Date(now).toISOString() };
    updated++;
  }
  if (updated) {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, file);
  }
  return { needed: todo.length, calls, updated };
}

/**
 * Refresh a show's watch_seasons from TMDB. Inserts seasons we don't have,
 * updates air facts on the ones we do, never touches viewing state.
 * @returns {Promise<{added:number[], nowDropped:number[]}>}
 */
export async function syncShowSeasons(title, today = todayEt()) {
  if (title.kind !== "show" || !title.tmdb_id) return { added: [], nowDropped: [] };
  const tv = await tmdb(`tv/${title.tmdb_id}?append_to_response=keywords`);
  if (!tv) return { added: [], nowDropped: [] };
  const facts = await tmdbSeasons(tv, today);
  const have = new Map((title.seasons || []).map((s) => [s.n, s]));
  const added = [], nowDropped = [];
  for (const f of facts) {
    const cur = have.get(f.n);
    const patch = {
      episodes_total: f.episodes_total,
      premiere_date: f.premiere_date,
      finale_date: f.finale_date,
      fully_dropped: f.fully_dropped,
    };
    if (!cur) {
      await upsertSeason(title.id, f.n, patch);
      added.push(f.n);
      if (f.fully_dropped) nowDropped.push(f.n);
      continue;
    }
    const changed = Object.entries(patch).some(([k, v]) => (cur[k] ?? null) !== (v ?? null));
    if (changed) {
      await patchSeason(cur.id, patch);
      if (f.fully_dropped && !cur.fully_dropped) nowDropped.push(f.n);
    }
  }
  const meta = {};
  if (tv.status === "Ended" && tv.last_air_date && !title.year_end) meta.year_end = parseInt(tv.last_air_date.slice(0, 4), 10);
  if (tv.original_language && tv.original_language !== title.original_language) meta.original_language = tv.original_language;
  const kw = keywordList(tv);
  if (kw && kw !== title.keywords) meta.keywords = kw;
  if (Object.keys(meta).length) await patchTitle(title.id, meta);
  return { added, nowDropped };
}

/** Highest season number marked watched (0 = none). */
export function watchedThrough(title) {
  return (title.seasons || []).reduce((m, s) => (s.status === "watched" ? Math.max(m, s.n) : m), 0);
}
