// tmdb-providers.mjs — pure provider-selection logic for tmdb-watch-providers, and the
// new-series sweep watch-discover uses (TMDB reached through an injected getter).
// Extracted from the bins so the group fallback, filtering and sweep rules are unit
// testable without hitting TMDB or Supabase.

// Provider-name normalization. TMDB returns long names like "Apple TV Plus";
// the watchlist has historically used short forms ("Apple TV+", "Max",
// "Hulu"). Map to the short forms the next-show answer already uses.
export const NORMALIZE = new Map([
  ["Apple TV Plus", "Apple TV+"],
  ["Apple TV+", "Apple TV+"],
  ["Apple TV", "Apple TV+"],
  ["Disney Plus", "Disney+"],
  ["Paramount Plus", "Paramount+"],
  ["Paramount Plus Apple TV Channel ", "Paramount+"],
  ["Paramount Plus Premium", "Paramount+"],
  ["Paramount Plus Essential", "Paramount+"],
  ["Amazon Prime Video", "Prime Video"],
  ["Amazon Video", "Prime Video"],
  ["HBO Max", "Max"],
  ["Hulu", "Hulu"],
  ["Netflix", "Netflix"],
  ["Peacock", "Peacock"],
  ["Peacock Premium", "Peacock"],
  ["Peacock Premium Plus", "Peacock"],
  ["YouTube Premium", "YouTube"],
  ["AMC+", "AMC+"],
  ["AMC Plus", "AMC+"],
]);

// Reseller / ad-tier variants of the same underlying service. They appear
// alongside the canonical name and produce noise like "Netflix / Netflix
// Standard with Ads" or "Apple TV+ / Apple TV Amazon Channel". Filter them
// out — the question is only "where do I press play."
export const SUFFIX_FILTERS = [
  / with Ads$/i,
  / Amazon Channel$/i,
  / Apple TV Channel$/i,
  / Roku Premium Channel$/i,
  / Premium Plus$/i, // covered by NORMALIZE for Peacock; broader catch
];

// Cable/live-TV bundles, transactional (rent/buy) stores, and aggregator
// resellers that show up in the watch-providers feed but aren't where
// the user would actually go to press play. fuboTV bundles are live TV;
// "Apple TV Store" / "Google Play Movies" are rent/buy not subscription.
export const EXCLUDE_PROVIDERS = new Set([
  "fuboTV",
  "YouTube TV",
  "Sling TV",
  "DirecTV",
  "Spectrum On Demand",
  "Xfinity", // kernel-guard-ok: a TMDB provider name (live-TV bundle), not an account
  "Apple TV Store",
  "Apple TV",
  "Google Play Movies",
  "Microsoft Store",
  "Vudu",
  "YouTube",
  "Spectrum",
  "DIRECTV",
  "Fandango At Home",
  "Fandango at Home",
  "Redbox",
  // Cable-network apps that need a TV-provider login, not a service anyone subscribes to.
  "TNT",
  "TBS",
  "tru TV",
]);

// Preference order: stream-with-subscription first, then free, ad-supported,
// and finally transactional.
export const PROVIDER_GROUPS = ["flatrate", "free", "ads", "rent", "buy"];

export function isResellerVariant(name) {
  if (EXCLUDE_PROVIDERS.has(name)) return true;
  return SUFFIX_FILTERS.some((re) => re.test(name));
}

export function shortName(provider) {
  const n = provider.provider_name || "";
  return NORMALIZE.get(n) || n;
}

// Pick up to `cap` provider names from a TMDB region entry.
//
// The group fallback walks flatrate → free → ads → rent → buy and stops at the
// first group that yields at least one provider AFTER normalization and
// reseller/transactional filtering. Stopping on the first group that is merely
// non-empty BEFORE filtering is wrong: a title whose only flatrate entry is
// "YouTube TV" (excluded) or "PBS Documentaries Amazon Channel" (a reseller
// variant) would filter down to nothing and report "no providers" while a
// perfectly good `free` or `rent` group sat one step further down the list.
export function pickProviders(region, cap = 2) {
  if (!region) return [];
  for (const g of PROVIDER_GROUPS) {
    if (!Array.isArray(region[g]) || !region[g].length) continue;
    const picked = region[g]
      .map(shortName)
      .filter((n) => n && !isResellerVariant(n))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, cap);
    if (picked.length) return picked;
  }
  return [];
}

// ---------------------------------------------------------------------------
// New-series sweep — the deterministic half of new-show discovery (bin/watch-discover):
// every new series TMDB lists as streaming on the viewers' services. A model's web search
// alone can come back empty for weeks; TMDB knows, per region, which series stream where
// (JustWatch data, the same source `watchlist where` uses), so code lists them and the
// caller runs each one through the same add rules and fit gate as the model's proposals.
//
// This part maps the configured service names to TMDB provider ids, pages /discover/tv
// for series that premiered in the lookback window on any of them (reality, talk, soap,
// kids and news excluded at the query), and confirms a candidate against its own
// provider list. Season-1 completeness, ratings, taste fit and language are the caller's
// gates. Services come from the watchlist config's `discover_services`; the default is
// the major US subscription services.

export const DEFAULT_SERVICES = ["Netflix", "Prime Video", "Apple TV+", "Max", "Hulu", "Disney+", "Paramount+", "Peacock"];

// TMDB TV genre ids that never qualify: Kids, News, Reality, Soap, Talk.
export const EXCLUDED_TV_GENRE_IDS = [10762, 10763, 10764, 10766, 10767];

/**
 * The service a TMDB provider entry belongs to, in the short form the list uses
 * ("HBO Max Amazon Channel" → "Max", "Netflix Standard with Ads" → "Netflix",
 * "Apple TV" → "Apple TV+"). Ad tiers and store channels count as the service.
 */
export function serviceOf(providerName) {
  let n = String(providerName || "").trim();
  for (const re of SUFFIX_FILTERS) n = n.replace(re, "").trim();
  return NORMALIZE.get(n) || NORMALIZE.get(`${n} `) || n;
}

/** TMDB provider ids (from /watch/providers/tv) that belong to the given services. */
export function providerIdsFor(providerList, services = DEFAULT_SERVICES) {
  const want = new Set(services);
  return [...new Set((providerList || [])
    .filter((p) => want.has(serviceOf(p.provider_name)))
    .map((p) => p.provider_id))];
}

/**
 * Which of the services a title streams on, from its TMDB watch-providers entry for the
 * region (flatrate, free or with-ads; rent/buy and paid add-on channels don't count).
 * TMDB's /discover index can disagree with a title's own providers (a series sold only
 * through an add-on channel can come back from a query on the subscription services), so
 * the sweep confirms every candidate here. Pure; exported for tests.
 */
export function onServices(regionEntry, services = DEFAULT_SERVICES) {
  const want = new Set(services);
  const found = [];
  for (const g of ["flatrate", "free", "ads"]) {
    for (const p of regionEntry?.[g] || []) {
      const s = serviceOf(p.provider_name);
      if (want.has(s) && !found.includes(s)) found.push(s);
    }
  }
  return found;
}

/** The /discover/tv path for one page. Pure; exported for tests. */
export function discoverPath({ providerIds, region = "US", since, until, page = 1, excludeGenres = EXCLUDED_TV_GENRE_IDS }) {
  const q = new URLSearchParams({
    watch_region: region,
    with_watch_providers: providerIds.join("|"),
    with_watch_monetization_types: "flatrate|free|ads",
    "first_air_date.gte": since,
    "first_air_date.lte": until,
    without_genres: excludeGenres.join("|"),
    include_adult: "false",
    sort_by: "popularity.desc",
    page: String(page),
  });
  return `discover/tv?${q.toString()}`;
}

/** YYYY-MM-DD `days` before the date string `today` (UTC arithmetic on a calendar date). */
export function daysBefore(today, days) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Every series that premiered in [today - lookbackDays, today] on the services.
 * deps.tmdbGet(path) → parsed JSON (watch-db's tmdbGet). Returns
 * { services, providerIds, shows: [{tmdb_id, name, original_language, first_air_date,
 * vote_average, vote_count, popularity}] } sorted by popularity, or throws when TMDB
 * can't list the providers (the caller reports it and carries on with the model's list).
 */
// maxPages is a runaway guard only (TMDB serves at most 500 pages): the sweep reads every
// page TMDB has. It was 25 until 2026-11-09, which silently cut 546 shows to the 500 most popular.
export async function sweepNewShows({ tmdbGet, services = DEFAULT_SERVICES, region = "US", today, lookbackDays = 240, maxPages = 100 }) {
  const list = await tmdbGet(`watch/providers/tv?watch_region=${encodeURIComponent(region)}`);
  const providerIds = providerIdsFor(list?.results, services);
  if (!providerIds.length) throw new Error(`no TMDB provider ids for ${services.join(", ")} in ${region}`);
  const since = daysBefore(today, lookbackDays);
  const seen = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const d = await tmdbGet(discoverPath({ providerIds, region, since, until: today, page }));
    for (const r of d?.results || []) {
      if (seen.has(r.id)) continue;
      seen.set(r.id, {
        tmdb_id: r.id, name: r.name, original_language: r.original_language || null,
        first_air_date: r.first_air_date || null, vote_average: r.vote_average ?? null,
        vote_count: r.vote_count ?? 0, popularity: r.popularity ?? 0,
      });
    }
    if (page >= (d?.total_pages || 1)) break;
  }
  return { services, providerIds, shows: [...seen.values()].sort((a, b) => b.popularity - a.popularity) };
}

/** Run fn over items with at most `n` in flight; results in input order. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
