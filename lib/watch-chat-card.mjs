// watch-chat-card.mjs — how a show or film looks in the Jori chat (2026-10-11).
//
// A chat answer about shows or films comes with images and links. The iOS client (apps/companion/Jori/MessageContentParser.swift) renders an image URL
// standing alone on its line as an inline picture, and markdown links inline. So every title
// is: poster on its own line, the bold headline, a one-line blurb, then
// "[IMDb](…) · [Rotten Tomatoes](…)" inline (inline links, not bare URLs — a bare URL would
// become a full preview card per title and bury the list).
//
// Used by the next-show answer (--format phone), the film recommendations and watch-card.

import { rest } from "./watch-db.mjs";

export const posterUrl = (path, size = "w342") => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);
export const imdbLink = (id) => (id ? `https://www.imdb.com/title/${id}/` : null);
export const rtSearch = (name) => `https://www.rottentomatoes.com/search?search=${encodeURIComponent(name)}`;

/** "[IMDb](…) · [Rotten Tomatoes](…)" (+ extra [label](url) pairs). */
export function linksLine({ imdb_id, name }, extra = []) {
  return [imdb_id && `[IMDb](${imdbLink(imdb_id)})`, `[Rotten Tomatoes](${rtSearch(name)})`,
    ...extra.filter(([, u]) => u).map(([l, u]) => `[${l}](${u})`)].filter(Boolean).join(" · ");
}

/** The lines for one title: poster, headline, blurb, links. */
export function cardLines({ poster_path, poster, headline, blurb, imdb_id, name, extra = [] }) {
  const img = poster || posterUrl(poster_path);
  return [img, headline, blurb || null, linksLine({ imdb_id, name }, extra)].filter(Boolean);
}

/** Posters for watch_titles rows, from the movie/show catalog (title_id → poster_path). */
export async function postersFor(titleIds) {
  const ids = [...new Set(titleIds.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await rest(`watch_catalog?select=title_id,poster_path&title_id=in.(${ids.slice(i, i + 200).join(",")})&poster_path=not.is.null`).catch(() => []);
    for (const r of rows) out.set(r.title_id, r.poster_path);
  }
  return out;
}

/** "Where to watch" from a movie-database row: in theaters, services, free, rent. */
export function whereShort(c) {
  const pv = c?.providers || {};
  return [c?.in_theaters ? "in theaters" : null, ...(pv.stream || []), (pv.free || []).length ? `free on ${pv.free[0]}` : null,
    !c?.in_theaters && !(pv.stream || []).length && !(pv.free || []).length && pv.rent ? "rent/buy" : null].filter(Boolean).join(", ");
}
