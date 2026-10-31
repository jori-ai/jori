// watch-intro.mjs — "new on your watchlist" intro emails (2026-10-10).
//
// When a new show or movie joins the lists, the user gets an email with a writeup
// and photos: what it is about, the main actors, the reviews, a short "why you
// would like it", and links to IMDb and Rotten Tomatoes. One email may carry
// several titles.
//
// Split the usual way: code owns the facts (TMDB cast, images, OMDb ratings,
// IMDb / Rotten Tomatoes links), a model owns the prose (what it's about, how
// critics took it, why they'd like it). This module is the pure half — selection,
// fact gathering and HTML — so it can be tested without the network; the
// network calls take an injectable fetch.
// Bin: bin/watchlist-intro-email. Playbook: ops-agent/jobs/watchlist-intro-email.md.
//
// Every card is a way into the title (2026-10-11: every row needs a tappable link and a
// description, and new films a preview): the picture and the
// name open IMDb, the synopsis falls back through every source that has one, and there is a
// trailer button when one exists. A title TMDB can't place still gets its own description, an
// IMDb search and a trailer search, never a bare card.

import { PARTNER, whoFor, listLabel } from "./watch-config.mjs";

export const LOOKBACK_DAYS = 30;
const SKIP_STATUS = new Set(["rejected", "dropped", "watched"]);
const IMG = "https://image.tmdb.org/t/p";

/** Titles that still need an intro email: added in the lookback, never emailed, still wanted. */
export function selectPending(titles, { now = new Date(), lookbackDays = LOOKBACK_DAYS } = {}) {
  const cutoff = now.getTime() - lookbackDays * 86400000;
  return titles
    .filter((t) => !t.intro_emailed_at && !SKIP_STATUS.has(t.status) && Date.parse(t.added_at) >= cutoff)
    .sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at));
}

export const imdbUrl = (id) => (id ? `https://www.imdb.com/title/${id}/` : null);
/** IMDb title search, for a title we hold no IMDb id for. */
export const imdbSearchUrl = (name, year) =>
  `https://www.imdb.com/find/?q=${encodeURIComponent([name, year].filter(Boolean).join(" "))}&s=tt`;
export const trailerSearchUrl = (name, year) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent([name, year, "trailer"].filter(Boolean).join(" "))}`;

const VIDEO_TYPE_RANK = { Trailer: 0, Teaser: 1 };
const VIDEO_URL = { YouTube: (k) => `https://www.youtube.com/watch?v=${k}`, Vimeo: (k) => `https://vimeo.com/${k}` };

/** The best trailer in a TMDB videos list: Trailer before Teaser, English, official, sharpest, earliest. */
export function pickTrailer(videos) {
  const ok = (videos || []).filter((v) => v?.key && VIDEO_URL[v.site] && v.type in VIDEO_TYPE_RANK);
  ok.sort((a, b) => VIDEO_TYPE_RANK[a.type] - VIDEO_TYPE_RANK[b.type]
    || (b.iso_639_1 === "en") - (a.iso_639_1 === "en")
    || (b.official === true) - (a.official === true)
    || (b.size || 0) - (a.size || 0)
    || String(a.published_at || "").localeCompare(String(b.published_at || "")));
  return ok.length ? VIDEO_URL[ok[0].site](ok[0].key) : null;
}

/**
 * The card's trailer link: TMDB's own video when it has one ({direct: true}); otherwise a YouTube
 * search, but only for a recent release (one almost surely exists) or a title TMDB couldn't
 * match at all. An older title with no video on TMDB gets no button.
 */
export function trailerLink(videos, { name, year, matched = true, now = new Date() } = {}) {
  const url = pickTrailer(videos);
  if (url) return { url, direct: true };
  if (!matched || (year && year >= now.getUTCFullYear() - 1)) return { url: trailerSearchUrl(name, year), direct: false };
  return null;
}

/**
 * The TMDB search result that really is this title: the same name under `norm`, and within a year
 * when both years are known. With no year to check, only a name no other result shares counts.
 * Null rather than a near miss, which would put another title's photos and cast on the card.
 */
export function searchHit(results, { name, year }, norm) {
  const want = norm(name);
  const named = (results || []).filter((r) => norm(r.title || r.name) === want);
  const yearOf = (r) => parseInt(String(r.release_date || r.first_air_date || "").slice(0, 4), 10);
  if (!year) return named.length === 1 ? named[0] : null;
  return named.find((r) => Number.isFinite(yearOf(r)) && Math.abs(yearOf(r) - year) <= 1)
    || (named.length === 1 && !Number.isFinite(yearOf(named[0])) ? named[0] : null);
}

/** Rotten Tomatoes page from its Wikidata id ("m/foo" / "tv/foo"), else an RT search. */
export function rtUrl(rtId, name) {
  if (rtId) return `https://www.rottentomatoes.com/${rtId}`;
  return `https://www.rottentomatoes.com/search?search=${encodeURIComponent(name)}`;
}

/** Shape a TMDB details payload (with credits/aggregate_credits) into the facts the email uses. */
export function tmdbFacts(d, media) {
  if (!d) return {};
  const credits = media === "tv" ? d.aggregate_credits || d.credits : d.credits;
  const cast = (credits?.cast || []).slice(0, 5).map((c) => ({
    name: c.name,
    role: c.character || c.roles?.[0]?.character || null,
    photo: c.profile_path ? `${IMG}/w185${c.profile_path}` : null,
  }));
  const creators = media === "tv"
    ? (d.created_by || []).map((c) => c.name)
    : (d.credits?.crew || []).filter((c) => c.job === "Director").map((c) => c.name);
  return {
    backdrop: d.backdrop_path ? `${IMG}/w780${d.backdrop_path}` : null,
    poster: d.poster_path ? `${IMG}/w342${d.poster_path}` : null,
    tagline: d.tagline || null,
    overview: d.overview || null,
    cast,
    creators: creators.slice(0, 3),
    seasons: media === "tv" ? d.number_of_seasons || null : null,
    runtime: media === "tv" ? d.episode_run_time?.[0] || null : d.runtime || null,
    networks: media === "tv" ? (d.networks || []).map((n) => n.name).slice(0, 2) : [],
    imdb_id: d.imdb_id || d.external_ids?.imdb_id || null,
    videos: d.videos?.results || [],
  };
}

/** OMDb full record → ratings + awards. */
export function omdbFacts(j) {
  if (!j || j.Response === "False") return {};
  const ratings = {};
  for (const r of j.Ratings || []) {
    if (r.Source === "Internet Movie Database") ratings.imdb = r.Value;
    else if (r.Source === "Rotten Tomatoes") ratings.rt = r.Value;
    else if (r.Source === "Metacritic") ratings.metacritic = r.Value;
  }
  if (!ratings.imdb && j.imdbRating && j.imdbRating !== "N/A") ratings.imdb = `${j.imdbRating}/10`;
  return { ratings, awards: j.Awards && j.Awards !== "N/A" ? j.Awards : null, plot: j.Plot && j.Plot !== "N/A" ? j.Plot : null };
}

/** The Rotten Tomatoes id Wikidata holds for an IMDb id (P345 → P1258), or null. */
export async function wikidataRtId(imdbId, { fetchFn = fetch } = {}) {
  if (!imdbId) return null;
  try {
    const s = await (await fetchFn(`https://www.wikidata.org/w/api.php?action=query&list=search&format=json&srsearch=haswbstatement:P345=${imdbId}`,
      { signal: AbortSignal.timeout(8000) })).json();
    const q = s?.query?.search?.[0]?.title;
    if (!q) return null;
    const e = await (await fetchFn(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&entity=${q}&property=P1258`,
      { signal: AbortSignal.timeout(8000) })).json();
    return e?.claims?.P1258?.[0]?.mainsnak?.datavalue?.value || null;
  } catch { return null; }
}

// Names, never pronouns: the email names who each title is for, so both readers
// know who is meant.
const AUDIENCE_LABEL = { solo: listLabel("solo"), together: listLabel("together"), [PARTNER]: listLabel(PARTNER) };
export const WHO = { solo: whoFor("solo"), together: whoFor("together"), [PARTNER]: whoFor(PARTNER) };
const KIND_LABEL = { show: "Series", movie: "Film", documentary: "Documentary" };

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); // lang-regex-ok: HTML escaping
}
const P = (txt, style = "") => (txt ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#222;${style}">${escapeHtml(txt)}</p>` : "");
// Labels are code constants (HTML allowed); hrefs are escaped. U+FE0E keeps ▶ a glyph, not an emoji.
const btn = (href, label, bg, size = 14) => `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:${size < 14 ? "7px 12px" : "9px 16px"};background:${bg};color:#fff;text-decoration:none;border-radius:6px;font-size:${size}px;font-weight:600;">${label}</a>`;
const trailerLabel = (tr) => (tr.direct ? "&#9654;&#xFE0E; Trailer" : "&#9654;&#xFE0E; Find the trailer");

/** One title's card. `w` = the model's prose {about, reviews, why}. */
export function renderCard(t, f, w = {}) {
  const meta = [
    KIND_LABEL[t.kind] || t.kind,
    t.year_start,
    t.genres,
    f.seasons ? `${f.seasons} season${f.seasons === 1 ? "" : "s"}` : null,
    f.runtime ? `${f.runtime} min${t.kind === "show" ? "/ep" : ""}` : null,
    f.where || (t.platform ? `on ${t.platform}` : null),
  ].filter(Boolean).join(" · ");
  const r = f.ratings || {};
  const ratingBits = [
    r.imdb && `<b>IMDb</b> ${escapeHtml(r.imdb)}`,
    r.rt && `<b>Rotten Tomatoes</b> ${escapeHtml(r.rt)}`,
    r.metacritic && `<b>Metacritic</b> ${escapeHtml(r.metacritic)}`,
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const hero = f.backdrop || f.poster;
  const imdb = f.imdb || imdbSearchUrl(t.name, t.year_start);
  const about = w.about || f.overview || t.description || f.plot;
  const castCells = (f.cast || []).slice(0, 4).map((c) => `
      <td align="center" valign="top" style="padding:0 6px;width:25%;">
        ${c.photo ? `<img src="${escapeHtml(c.photo)}" width="72" height="108" alt="${escapeHtml(c.name)}" style="display:block;margin:0 auto 6px;border-radius:6px;object-fit:cover;">` : ""}
        <div style="font-size:13px;font-weight:600;color:#222;">${escapeHtml(c.name)}</div>
        ${c.role ? `<div style="font-size:12px;color:#777;">${escapeHtml(c.role)}</div>` : ""}
      </td>`).join("");
  return `
<div style="margin:0 0 36px;border:1px solid #e6e6e6;border-radius:10px;overflow:hidden;background:#fff;">
  ${hero ? `<a href="${escapeHtml(imdb)}" style="display:block;"><img src="${escapeHtml(hero)}" width="600" alt="${escapeHtml(t.name)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></a>` : ""}
  <div style="padding:18px 20px 20px;">
    <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#888;margin:0 0 4px;">Added to ${escapeHtml(AUDIENCE_LABEL[t.audience] || "the list")}</div>
    <h2 style="margin:0 0 4px;font-size:22px;color:#111;"><a href="${escapeHtml(imdb)}" style="color:#111;text-decoration:none;">${escapeHtml(t.name)}</a></h2>
    <div style="font-size:13px;color:#666;margin:0 0 14px;">${escapeHtml(meta)}</div>
    ${f.tagline ? P(`“${f.tagline}”`, "font-style:italic;color:#555;") : ""}
    ${about ? `<h3 style="margin:16px 0 6px;font-size:15px;color:#111;">What it's about</h3>
    ${P(about)}` : ""}
    ${f.creators?.length ? P(`${t.kind === "show" ? "Created by" : "Directed by"} ${f.creators.join(", ")}`, "font-size:13px;color:#666;") : ""}
    ${castCells ? `<h3 style="margin:16px 0 8px;font-size:15px;color:#111;">Starring</h3>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px;"><tr>${castCells}</tr></table>` : ""}
    <h3 style="margin:16px 0 6px;font-size:15px;color:#111;">The reviews</h3>
    ${ratingBits ? `<div style="font-size:14px;color:#333;margin:0 0 8px;">${ratingBits}</div>` : ""}
    ${P(w.reviews)}
    ${f.awards ? P(f.awards, "font-size:13px;color:#666;") : ""}
    ${w.why ? `<div style="margin:16px 0 16px;padding:12px 14px;background:#f5f8ff;border-left:4px solid #3b6fd8;border-radius:4px;">
      <div style="font-size:13px;font-weight:700;color:#3b6fd8;margin:0 0 4px;">Why ${escapeHtml(WHO[t.audience] || "you")} will like it</div>
      <div style="font-size:15px;line-height:1.5;color:#222;">${escapeHtml(w.why)}</div></div>` : ""}
    <div style="margin:14px 0 0;">
      ${btn(imdb, "IMDb", "#c9a400")}${f.trailer ? btn(f.trailer.url, trailerLabel(f.trailer), "#222") : ""}${btn(f.rt || rtUrl(null, t.name), "Rotten Tomatoes", "#d63c2f")}
    </div>
  </div>
</div>`;
}

export function renderEmail(cards, { intro } = {}) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f4;">
<div style="max-width:640px;margin:0 auto;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  ${intro ? `<p style="font-size:16px;line-height:1.5;color:#222;margin:0 0 22px;">${escapeHtml(intro)}</p>` : ""}
  ${cards.join("\n")}
  <p style="font-size:12px;color:#999;border-top:1px solid #ddd;padding-top:12px;margin:8px 0 0;">
    Tap any picture or title to open it on IMDb. Not interested in one? Just tell Jori and it comes off the list for good.
    Photos, cast, synopses and trailers from TMDB; ratings from OMDb.
    This product uses the TMDB API but is not endorsed or certified by TMDB.
  </p>
</div></body></html>`;
}

export function subjectFor(titles) {
  const names = titles.map((t) => t.name);
  if (names.length === 1) return `New on your watchlist: ${names[0]}`;
  if (names.length === 2) return `New on your watchlist: ${names[0]} and ${names[1]}`;
  return `New on your watchlist: ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** "Where to watch" from a movie-database row (the film catalog refresh): in theaters, services, free, rent. */
export function whereText(c) {
  if (!c) return null;
  const pv = c.providers || {};
  const bits = [c.in_theaters ? "in theaters now" : null, (pv.stream || []).length ? `on ${pv.stream.join(" / ")}` : null,
    (pv.free || []).length ? `free on ${pv.free.slice(0, 2).join(" / ")}` : null,
    !c.in_theaters && !(pv.stream || []).length && !(pv.free || []).length && pv.rent ? "to rent or buy" : null].filter(Boolean);
  return bits.join(", ") || null;
}

/**
 * The weekly email's "also new and likely for you both" rows: films new in theaters or on
 * streaming this week, not on the list, best predicted first. Compact, but every row is a way in:
 * poster, name and synopsis open IMDb, with IMDb and trailer buttons under them. Each row may
 * carry `trailer` ({url, direct}, from trailerLink) and a filled-in `overview` / `imdb_id`.
 */
export function renderNewRows(rows) {
  if (!rows.length) return "";
  const li = rows.map((c) => {
    const img = c.poster_path ? `${IMG}/w154${c.poster_path}` : null;
    const link = imdbUrl(c.imdb_id) || imdbSearchUrl(c.title, c.year);
    const meta = [`<b>${Math.min(99, Math.round((c.model_p || 0) * 100))}% match</b>`, c.imdb_rating ? `IMDb ${escapeHtml(c.imdb_rating)}` : null,
      c.genres ? escapeHtml(c.genres.split(", ").slice(0, 2).join(", ")) : null].filter(Boolean).join(" · ");
    const where = whereText(c);
    return `<tr>
      <td valign="top" style="padding:0 14px 20px 0;width:92px;">${img ? `<a href="${escapeHtml(link)}" style="display:block;"><img src="${escapeHtml(img)}" width="92" alt="${escapeHtml(c.title)}" style="display:block;border-radius:6px;border:0;"></a>` : ""}</td>
      <td valign="top" style="padding:0 0 20px;font-size:14px;line-height:1.45;color:#222;">
        <a href="${escapeHtml(link)}" style="display:block;color:#222;text-decoration:none;">
          <span style="font-size:16px;font-weight:700;color:#1a3d8f;">${escapeHtml(c.title)}</span> <span style="color:#888;">${c.year || ""}</span><br>
          <span style="font-size:13px;color:#444;">${meta}</span>
          ${where ? `<br><span style="font-size:13px;color:#555;">${escapeHtml(where)}</span>` : ""}
          ${c.overview ? `<span style="display:block;margin:8px 0 0;font-size:14px;line-height:1.5;color:#333;">${escapeHtml(c.overview)}</span>` : ""}
        </a>
        <div style="margin:10px 0 0;">${btn(link, "IMDb", "#c9a400", 13)}${c.trailer ? btn(c.trailer.url, trailerLabel(c.trailer), "#222", 13) : ""}</div>
      </td></tr>`;
  }).join("");
  return `<div style="background:#fff;border-radius:10px;padding:18px 18px 4px;margin:0 0 22px;">
  <div style="font-size:17px;font-weight:700;color:#222;margin:0 0 12px;">Also new this week, and likely for ${escapeHtml(whoFor("together"))}</div>
  <table cellpadding="0" cellspacing="0" border="0" width="100%">${li}</table></div>`;
}

export function moviesSubject(titles, extra) {
  const names = titles.map((t) => t.name);
  if (!names.length) return `New movies this week: ${extra} you'd likely enjoy`;
  if (names.length === 1) return `This week's movie: ${names[0]}`;
  return `This week's movies: ${names[0]}, ${names[1]}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`;
}
