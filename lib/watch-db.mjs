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

/** OMDb scores for an IMDb id: {imdb, rt (percent), metacritic (0-100)}, nulls when unknown. */
export async function omdbRecord(imdbId) {
  const out = { imdb: null, rt: null, metacritic: null };
  const key = process.env.OMDB_API_KEY;
  if (!key || !imdbId) return out;
  try {
    const r = await fetch(`https://www.omdbapi.com/?apikey=${key}&i=${imdbId}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    out.imdb = num(j.imdbRating);
    for (const x of j.Ratings || []) {
      if (x.Source === "Rotten Tomatoes") out.rt = num(x.Value);
      if (x.Source === "Metacritic") out.metacritic = num(x.Value);
    }
  } catch {}
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
