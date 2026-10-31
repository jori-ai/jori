// tmdb-providers.mjs — pure provider-selection logic for tmdb-watch-providers.
// Extracted from the bin so the group fallback + filtering rules are unit
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
