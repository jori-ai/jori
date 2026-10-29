// watch-rank.mjs — pure recommendation logic for the shows & movies list.
//
// Inputs are plain rows from watch-db `loadAll()`; no I/O here, so the ranking
// is unit-testable (tests/watch-rank.test.mjs).
//
// Order of what gets recommended (the user prefers new seasons that just
// finished dropping, of shows whose previous seasons they watched):
//   1. watching — a season in progress
//   2. ready    — next season of a show they've watched, fully dropped within the
//                 last year; freshest first (older ones compete in `fresh` as
//                 continuations with a bonus)
//   3. soon     — next season premiered but still airing (never offered as "ready")
//   4. fresh    — titles not started yet, scored on taste fit + rating + recency.
//                 Taste fit = learned genre affinity + stated preferences
//                 (watch_taste_prefs, per audience, e.g. +action together,
//                 -romance for all).
//
// Taste fit is learned from watch_feedback, per audience: verdicts on the
// together list mostly shape together picks, and solo verdicts mostly shape
// solo picks (cross-audience feedback counts at CROSS_WEIGHT).

const VERDICT_WEIGHT = { loved: 2, liked: 1, meh: -0.5, disliked: -1.5, dropped: -1.5, not_interested: -1 };
const IMPLICIT_WATCHED = 0.5;   // finished it, never rated it
const IMPLICIT_REJECTED = -1;   // rejected without a recorded verdict
const CROSS_WEIGHT = 0.3;
const SHRINK = 2;               // genre affinity = sum / (n + SHRINK)
const READY_WINDOW_DAYS = 365;  // "just finished dropping" — older next seasons are backlog
const CONTINUATION_BONUS = 0.5;
const PREF_SCALE = 0.67;        // ×1.2 in scoreTitle ≈ 0.8 per unit of stated preference

import { watchConfig } from "./watch-config.mjs";

const PREFERRED_LANGUAGES = new Set(watchConfig().preferred_languages || ["en"]);
export const foreign = (t) => (t.original_language && !PREFERRED_LANGUAGES.has(t.original_language) ? 1 : 0);

function isRecent(season, today) {
  const ref = season.finale_date || season.premiere_date;
  if (!ref) return false;
  return (Date.parse(today) - Date.parse(ref)) / 86400000 <= READY_WINDOW_DAYS;
}

// "Drama" is on nearly every title on the list, so it carries no information
// about taste — counting it made every drama "fit" (2026-10-04: a 9.1 romance
// drama topped the together list on the strength of the word alone).
const UNINFORMATIVE = new Set(["drama"]);

export function genreTokens(t) {
  return String(t.genres || "")
    .split(/[,/&]| and /i)
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean)
    .map((g) => (g === "sci-fi" || g === "science fiction" ? "sci-fi & fantasy" : g))
    .filter((g) => !UNINFORMATIVE.has(g));
}

function latestVerdicts(feedback) {
  // One verdict per (title, season): the most recent wins.
  const m = new Map();
  for (const f of feedback) m.set(`${f.title_id}:${f.season_n ?? ""}`, f);
  return [...m.values()];
}

/** Map genre → affinity in roughly [-1.5, 2] for one audience. */
export function genreAffinity(titles, feedback, audience) {
  const byId = new Map(titles.map((t) => [t.id, t]));
  const sums = new Map();
  const add = (t, w) => {
    const scale = !audience || t.audience === audience ? 1 : CROSS_WEIGHT;
    for (const g of genreTokens(t)) {
      const cur = sums.get(g) || { s: 0, n: 0 };
      cur.s += w * scale; cur.n += scale;
      sums.set(g, cur);
    }
  };
  const rated = new Set();
  for (const f of latestVerdicts(feedback)) {
    const t = byId.get(f.title_id);
    if (!t) continue;
    rated.add(t.id);
    add(t, VERDICT_WEIGHT[f.verdict] ?? 0);
  }
  for (const t of titles) {
    if (rated.has(t.id)) continue;
    const watchedAny = t.status === "watched" || (t.seasons || []).some((s) => s.status === "watched");
    if (watchedAny) add(t, IMPLICIT_WATCHED);
    else if (t.status === "rejected") add(t, IMPLICIT_REJECTED);
  }
  const out = new Map();
  for (const [g, { s, n }] of sums) out.set(g, s / (n + SHRINK));
  return out;
}

// Stated preferences (watch_taste_prefs) name tags; a tag matches TMDB genres
// and, where TMDB has no genre for it (spy), TMDB keyword names. These are
// structured TMDB vocabularies, not free text.
const TAG_MATCH = {
  action: { genres: ["action", "action & adventure"] },
  comedy: { genres: ["comedy"], keywords: ["dark comedy", "black comedy", "satire"] },
  drama: { genres: ["drama"] },
  romance: { genres: ["romance"], keywords: ["romance", "love story", "romantic comedy", "love triangle", "forbidden love", "romantic drama"] },
  "sci-fi": { genres: ["science fiction", "sci-fi & fantasy"], keywords: ["science fiction", "dystopia", "time travel", "artificial intelligence", "space travel", "alien"] },
  // TMDB has a Horror genre for films but none for TV, so series match on keywords.
  horror: { genres: ["horror"], keywords: ["horror", "supernatural horror", "psychological horror", "folk horror", "body horror", "slasher", "haunted house", "zombie", "vampire", "possession", "demon", "ghost"] },
  // Comic-book / shared-universe films. TMDB keyword names.
  superhero: { keywords: ["superhero", "based on comic", "based on graphic novel", "marvel cinematic universe (mcu)", "dc extended universe (dceu)", "dc universe (dcu)", "superhero team", "super power", "comic book", "marvel comics", "dc comics", "shared universe"] },
  spy: { keywords: ["spy", "espionage", "secret agent", "intelligence agency", "cia", "mi6", "mossad", "kgb", "double agent", "spy thriller", "undercover agent", "intelligence officer", "cold war"] },
};

function rawGenres(t) {
  return String(t.genres || "").split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);
}
function rawKeywords(t) {
  return String(t.keywords || "").split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);
}

export function matchesTag(t, tag) {
  const m = TAG_MATCH[tag] || { genres: [tag] };
  const gs = rawGenres(t), ks = rawKeywords(t);
  return (m.genres || []).some((g) => gs.includes(g)) || (m.keywords || []).some((k) => ks.includes(k));
}

/** Sum of stated-preference weights that apply to this title for `audience`, clamped to [-2, 2]. */
export function prefScore(t, prefs = [], audience = null) {
  const aud = audience || "together";
  let sum = 0;
  const liked = [];
  for (const p of prefs) {
    if (p.audience !== "all" && p.audience !== aud) continue;
    if (!matchesTag(t, p.tag)) continue;
    sum += Number(p.weight);
    if (Number(p.weight) > 0 && p.tag !== "drama") liked.push(p.tag);
  }
  return { pref: Math.max(-2, Math.min(2, sum)), liked };
}

/** Learned genre fit + stated preferences — what discovery gates on and ranking weighs. */
export function tasteFit(t, affinity, prefs, audience) {
  return fitScore(t, affinity) + PREF_SCALE * prefScore(t, prefs, audience).pref;
}

export function fitScore(t, affinity) {
  const gs = genreTokens(t);
  if (!gs.length) return 0;
  return gs.reduce((a, g) => a + (affinity.get(g) || 0), 0) / gs.length;
}

function ratingScore(r) {
  if (r == null) return -0.5;
  return Math.max(-1.5, Math.min(1.5, Number(r) - 7.5));
}

function recencyScore(t, year) {
  const y = t.year_start;
  if (!y) return 0;
  if (y >= year - 1) return 0.5;
  if (y >= year - 3) return 0.2;
  if (y <= year - 8) return -0.3;
  return 0;
}

export function scoreTitle(t, affinity, today, prefs = [], audience = null) {
  const year = parseInt(today.slice(0, 4), 10);
  const learned = fitScore(t, affinity);
  const { pref, liked } = prefScore(t, prefs, audience);
  const fit = learned + PREF_SCALE * pref;
  return {
    score: ratingScore(t.imdb_rating) + 1.2 * fit + recencyScore(t, year),
    fit,
    learned_fit: learned,
    liked_tags: liked,
  };
}

/** Best-loved title sharing the most genres with `t` — used for a "because you loved X" line. */
function becauseOf(t, titles, feedback, audience) {
  const loved = new Set(latestVerdicts(feedback).filter((f) => f.verdict === "loved" || f.verdict === "liked").map((f) => f.title_id));
  const gs = new Set(genreTokens(t));
  let best = null, bestN = 0;
  for (const o of titles) {
    if (!loved.has(o.id) || o.id === t.id) continue;
    if (audience && o.audience !== audience) continue;
    const n = genreTokens(o).filter((g) => gs.has(g)).length;
    if (n > bestN) { best = o; bestN = n; }
  }
  return best ? best.name : null;
}

/**
 * @param {object} p
 * @param {object[]} p.titles    rows with .seasons
 * @param {object[]} p.feedback
 * @param {string}   [p.audience]  solo | together | <partner_id>  (shows)
 * @param {string}   [p.kind]      show | movie            (movie also covers documentary)
 * @param {string}   p.today       YYYY-MM-DD (local)
 */
export function recommend({ titles, feedback, prefs = [], audience = null, kind = "show", today }) {
  const prefAudience = kind === "show" ? audience : "together"; // movies are mostly a together thing
  const affinity = genreAffinity(titles, feedback, kind === "show" ? audience : null);
  const pool = titles.filter((t) => (kind === "show" ? t.kind === "show" : t.kind !== "show"))
    .filter((t) => (kind === "show" && audience ? t.audience === audience : true));

  const watching = [], ready = [], soon = [], fresh = [];
  for (const t of pool) {
    if (t.status === "rejected" || t.status === "dropped") continue;
    const seasons = (t.seasons || []).slice().sort((a, b) => a.n - b.n);

    if (t.kind === "show") {
      const inProgress = seasons.find((s) => s.status === "watching");
      if (inProgress || t.status === "watching") {
        watching.push({ ...t, season: inProgress || null });
        continue;
      }
      const through = seasons.reduce((m, s) => (s.status === "watched" ? Math.max(m, s.n) : m), 0);
      if (through > 0 || t.status === "watched") {
        const next = seasons.find((s) => s.n > through && s.status === "unwatched");
        if (!next) continue;
        const entry = { ...t, season: next, watched_through: through, ...scoreTitle(t, affinity, today, prefs, prefAudience) };
        if (next.fully_dropped && isRecent(next, today)) ready.push(entry);
        else if (next.fully_dropped) {
          // A season that finished long ago isn't "just dropped" — it's backlog.
          // Still a strong candidate (they're invested), so it competes with new
          // titles with a bonus instead of being pinned above them.
          fresh.push({ ...entry, continuation: true, score: entry.score + CONTINUATION_BONUS });
        }
        else if (next.premiere_date && next.premiere_date <= today) soon.push(entry);
        continue;
      }
      // Not started. Only offer it once its first season has fully dropped.
      const first = seasons.find((s) => s.n >= 1);
      if (first && !first.fully_dropped) continue;
    } else if (t.status !== "queued") {
      continue;
    }
    if (t.status !== "queued") continue;
    const s = scoreTitle(t, affinity, today, prefs, prefAudience);
    fresh.push({ ...t, ...s, because: s.learned_fit > 0 ? becauseOf(t, titles, feedback, kind === "show" ? audience : null) : null });
  }

  ready.sort((a, b) => (b.season.finale_date || "").localeCompare(a.season.finale_date || "") || b.score - a.score);
  soon.sort((a, b) => (a.season.finale_date || "9999").localeCompare(b.season.finale_date || "9999"));
  // Preferred languages first, other languages after them — a partition, not a
  // penalty, so no rating can lift a foreign-language title above them
  // (foreign-language titles are fine, at the end of the list). Unknown
  // language counts as preferred (fail-open). `ready` is untouched: a fresh
  // season of a show they already watch was chosen in its own language.
  fresh.sort((a, b) => foreign(a) - foreign(b) || b.score - a.score);
  return { watching, ready, soon, fresh, affinity };
}
