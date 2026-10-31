// watch-where.mjs — "where can I actually watch this?" for one title, per
// country, from TMDB's /{movie|tv}/{id}/watch/providers (JustWatch data).
//
// Added 2026-10-06 (self-improvement review, approved): an answer to "what's
// next?" could name a show but not where to press play — the watch_titles
// `platform` tag is one home-region string refreshed weekly by the provider
// sync bin, and says nothing when the user is abroad.
//
// What this adds over that tag:
//   - every way to get the title in a country: stream (subscription), free,
//     with ads, rent, buy
//   - the LOCAL country too whenever the travel timeline puts the user outside
//     the home region, alongside it — a home subscription is not what plays
//     abroad
//   - a 7-day on-disk cache per title (one TMDB response carries every
//     country, so one cached call answers home and abroad alike)
//
// Consumers: `watchlist where` / `watchlist info`, the next-show answer (local country
// when abroad), and the tools-mcp `watch_where` tool (which runs the CLI).
//
// The provider-name normalisation and reseller filter come from
// tmdb-providers.mjs so the `platform` tag and this answer never disagree on
// what "Netflix" is called.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { shortName, isResellerVariant, SUFFIX_FILTERS } from "./tmdb-providers.mjs";
import { watchConfig } from "./watch-config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(HERE, "..", "data", "watch-providers");
const require = createRequire(import.meta.url);

// Streaming availability shifts on licence boundaries (monthly-ish); a week is
// fresh enough to answer "where is it now" and keeps a whole next-show render
// to ~zero TMDB calls on a warm cache.
export const TTL_DAYS = 7;
// Bump when the cached payload changes shape.
const CACHE_V = 1;

// The region whose subscriptions are billed (config home_region).
export const HOME_REGION = String(watchConfig().home_region || "US").toUpperCase();

// ---------------------------------------------------------------------------
// Which country is the user in?

// Travel-timeline metro keys (agent/local/config/travel.json) → ISO 3166-1
// country, from config metro_countries. A metro not listed falls through to the
// label lookup below.
const METRO_COUNTRY = watchConfig().metro_countries || {};

// Country names that Intl.DisplayNames doesn't spell the way travel labels do.
const COUNTRY_ALIASES = {
  "usa": "US", "us": "US", "united states of america": "US", "america": "US",
  "uk": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "britain": "GB", "great britain": "GB",
  "holland": "NL", "czech republic": "CZ", "turkey": "TR", "türkiye": "TR", "turkiye": "TR",
};

let nameToCode = null;
function countryNameTable() {
  if (nameToCode) return nameToCode;
  nameToCode = new Map(Object.entries(COUNTRY_ALIASES));
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const A = "A".charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      let name;
      try { name = dn.of(code); } catch { continue; }
      if (!name || name === code) continue; // unassigned code
      // First code wins: ICU also names a few reserved codes after a real
      // country (FX "France", UK "United Kingdom"), and those sort later.
      if (!nameToCode.has(name.toLowerCase())) nameToCode.set(name.toLowerCase(), code);
    }
  }
  return nameToCode;
}

export function countryName(code) {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch { return code; }
}

/**
 * Country for a `travel where --json` result ({metro, label}). The metro key is
 * authoritative for the cities the timeline knows; otherwise the label's
 * comma-separated parts ("<town>, <country> — <stay>") are looked up as country
 * names. The label is machine-written by `travel`, and this is a table lookup,
 * not interpretation. null = unknown (callers treat that as home).
 */
export function countryFromPresence(p) {
  if (!p) return null;
  const metro = String(p.metro || "");
  if (metro && METRO_COUNTRY[metro]) return METRO_COUNTRY[metro];
  // An ambiguous "<metro>|<metro>" stay: every candidate in one country → that country.
  if (metro.includes("|")) {
    const cs = [...new Set(metro.split("|").map((m) => METRO_COUNTRY[m.trim()] || null))];
    if (cs.length === 1 && cs[0]) return cs[0];
  }
  const table = countryNameTable();
  const parts = String(p.label || "").split("—")[0].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (let k = parts.length - 1; k >= 0; k--) {
    const code = table.get(parts[k]);
    if (code) return code;
  }
  return null;
}

// --- presence: cheap, cached, bounded -------------------------------------
//
// The next-show answer sits on the chat path, so "is the user abroad?" must cost ~nothing at
// home (coordinator review, 2026-10-06). The answer comes from the travel
// library in-process (presence.js resolvePresenceAt + flights.json, the same
// brain as `travel where`), with the travel_segments read capped at
// PRESENCE_TIMEOUT_MS, and is cached for an hour. A timeout or failure means
// home-only, cached briefly so a Supabase outage costs one 2s wait per 10 min,
// not one per answer.

export const PRESENCE_TIMEOUT_MS = 2000;
export const PRESENCE_TTL_MS = 60 * 60 * 1000;
export const PRESENCE_FAIL_TTL_MS = 10 * 60 * 1000;
const PRESENCE_FILE = "presence.json";

/** In-process `travel where now`. Returns null on failure. */
async function resolvePresenceNow({ timeoutMs }) {
  const P = require("./presence.js");
  const { fetchJson } = require("./supabase-rest.js");
  // Same query as presence.js fetchSegments, but with our own (short) timeout.
  // fetchJson resolves null on error/timeout and destroys the socket, so no
  // request outlives the answer.
  const segments = await fetchJson("/rest/v1/travel_segments?select=*&order=arrive_at.asc", { timeoutMs });
  if (!Array.isArray(segments)) return null;
  return P.resolvePresenceAt(Date.now(), segments, P.loadFlights());
}

/**
 * Where the user is now, for region choice. Never throws; null = unknown (-> home only).
 * @param {object} [o]
 * @param {() => Promise<object|null>} [o.resolver]  injectable for tests
 */
export async function currentPresence({
  dir = CACHE_DIR, now = Date.now(), timeoutMs = PRESENCE_TIMEOUT_MS, resolver = null,
} = {}) {
  const file = path.join(dir, PRESENCE_FILE);
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const age = now - Date.parse(c.fetched_at || 0);
    const ttl = c.ok ? PRESENCE_TTL_MS : PRESENCE_FAIL_TTL_MS;
    if (Number.isFinite(age) && age >= 0 && age < ttl) return c.presence ?? null;
  } catch { /* no cache yet */ }

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); timer.unref?.(); });
  let presence;
  try {
    presence = await Promise.race([(resolver || (() => resolvePresenceNow({ timeoutMs })))(), timeout]);
  } catch { presence = undefined; }
  clearTimeout(timer);
  const ok = presence !== undefined && presence !== null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetched_at: new Date(now).toISOString(), ok, presence: ok ? presence : null }) + "\n");
    fs.renameSync(tmp, file);
  } catch { /* cache is an optimisation */ }
  return ok ? presence : null;
}

/**
 * Regions to show: the home region always (it's where the subscriptions are billed),
 * plus the local country when the timeline puts the user elsewhere. An explicit region
 * list overrides both (and skips the presence lookup entirely).
 * @returns {Promise<{regions:string[], local:string|null, presence:object|null}>}
 */
export async function regionsToShow({ override = null, presence = undefined, presenceOpts = {} } = {}) {
  if (override && override.length) {
    return { regions: [...new Set(override.map((r) => r.toUpperCase()))], local: null, presence: null };
  }
  const p = presence === undefined ? await currentPresence(presenceOpts) : presence;
  const c = countryFromPresence(p);
  if (c && c !== HOME_REGION) return { regions: [HOME_REGION, c], local: c, presence: p };
  return { regions: [HOME_REGION], local: null, presence: p };
}

// ---------------------------------------------------------------------------
// Shaping one region's TMDB entry

// Rent/buy storefronts are excluded from the `platform` tag (not "where you
// press play" on a subscription), but for "where can I watch this" they ARE
// an answer — so they get their own short names instead of being dropped.
const STORE_NAMES = new Map([
  ["Apple TV Store", "Apple TV"], ["Apple TV", "Apple TV"],
  ["Amazon Video", "Prime Video"], ["Amazon Prime Video", "Prime Video"],
  ["Google Play Movies", "Google Play"], ["YouTube", "YouTube"],
  ["Fandango At Home", "Fandango at Home"], ["Fandango at Home", "Fandango at Home"],
  ["Microsoft Store", "Microsoft Store"], ["Vudu", "Fandango at Home"],
]);

const uniq = (a) => a.filter((v, i) => v && a.indexOf(v) === i);

function byPriority(list) {
  return [...(list || [])].sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999));
}

function subscriptionNames(list) {
  return uniq(byPriority(list).map(shortName).filter((n) => n && !isResellerVariant(n)));
}

function storeNames(list) {
  return uniq(byPriority(list)
    .map((p) => STORE_NAMES.get(p.provider_name) || p.provider_name)
    .filter((n) => n && !SUFFIX_FILTERS.some((re) => re.test(n))));
}

/**
 * One region's TMDB entry → {stream, free, ads, rent, buy, link}. Pure.
 * `free` and `ads` are kept apart (Tubi vs Netflix-with-ads are different
 * answers). A name already listed as `stream` is not repeated under ads.
 */
export function regionAvailability(entry) {
  if (!entry) return null;
  const stream = subscriptionNames(entry.flatrate);
  const free = subscriptionNames(entry.free).filter((n) => !stream.includes(n));
  const ads = subscriptionNames(entry.ads).filter((n) => !stream.includes(n) && !free.includes(n));
  const rent = storeNames(entry.rent);
  const buy = storeNames(entry.buy).filter((n) => !rent.includes(n));
  return { stream, free, ads, rent, buy, link: entry.link || null };
}

export function isEmpty(a) {
  return !a || !(a.stream.length || a.free.length || a.ads.length || a.rent.length || a.buy.length);
}

/** "Netflix" / "free on Tubi" / "rent on Apple TV, Prime Video" / null. */
export function shortAvailability(a, cap = 2) {
  if (isEmpty(a)) return null;
  if (a.stream.length) return a.stream.slice(0, cap).join(", ");
  if (a.free.length) return `free on ${a.free.slice(0, cap).join(", ")}`;
  if (a.ads.length) return `free with ads on ${a.ads.slice(0, cap).join(", ")}`;
  if (a.rent.length) return `rent on ${a.rent.slice(0, cap).join(", ")}`;
  return `buy on ${a.buy.slice(0, cap).join(", ")}`;
}

/** Full one-line answer for a region: "stream: Netflix · rent: Apple TV, Prime Video". */
export function longAvailability(a) {
  if (isEmpty(a)) return "not available to stream, rent or buy";
  const parts = [];
  if (a.stream.length) parts.push(`stream: ${a.stream.join(", ")}`);
  if (a.free.length) parts.push(`free: ${a.free.join(", ")}`);
  if (a.ads.length) parts.push(`free with ads: ${a.ads.join(", ")}`);
  if (a.rent.length) parts.push(`rent: ${a.rent.join(", ")}`);
  if (a.buy.length) parts.push(`buy: ${a.buy.join(", ")}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// TMDB fetch + cache

function cachePath(media, id, dir) {
  return path.join(dir, `${media}-${id}.json`);
}

function readCache(media, id, { dir, now }) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(media, id, dir), "utf8"));
    if (raw?.v !== CACHE_V) return null;
    const ageDays = (now - Date.parse(raw.fetched_at || 0)) / 86400000;
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > TTL_DAYS) return null;
    return raw;
  } catch { return null; }
}

function writeCache(media, id, payload, { dir }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = cachePath(media, id, dir);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload) + "\n");
    fs.renameSync(tmp, p);
  } catch { /* the cache is an optimisation; never fail the answer over it */ }
}

/**
 * Raw per-country provider map for a title ({US: {...}, IL: {...}, ...}),
 * from the cache when it is under TTL_DAYS old, else from TMDB.
 * @param {"tv"|"movie"} media
 * @returns {Promise<{results:object, fetched_at:string, cached:boolean}>}
 */
export async function fetchProviders(media, id, {
  fetchImpl = globalThis.fetch, apiKey = process.env.TMDB_API_KEY,
  dir = CACHE_DIR, now = Date.now(), refresh = false,
} = {}) {
  if (media !== "tv" && media !== "movie") throw new Error(`media must be tv|movie, got ${media}`);
  if (!refresh) {
    const hit = readCache(media, id, { dir, now });
    if (hit) return { results: hit.results || {}, fetched_at: hit.fetched_at, cached: true };
  }
  if (!apiKey) throw new Error("TMDB_API_KEY missing (.env)");
  const res = await fetchImpl(`https://api.themoviedb.org/3/${media}/${id}/watch/providers?api_key=${apiKey}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TMDB ${res.status} ${media}/${id}/watch/providers`);
  const data = await res.json();
  const payload = { v: CACHE_V, media, id, fetched_at: new Date(now).toISOString(), results: data.results || {} };
  writeCache(media, id, payload, { dir });
  return { results: payload.results, fetched_at: payload.fetched_at, cached: false };
}

export function mediaOf(title) {
  return title.kind === "show" ? "tv" : "movie";
}

/**
 * Where-to-watch for one title across `regions`.
 * @returns {Promise<{regions:Object<string,object|null>, link:string|null, fetched_at:string, cached:boolean}>}
 */
export async function whereToWatch({ media, id }, regions, opts = {}) {
  const raw = await fetchProviders(media, id, opts);
  const out = {};
  let link = null;
  for (const r of regions) {
    out[r] = regionAvailability(raw.results[r]);
    link ||= out[r]?.link || null;
  }
  return { regions: out, link, fetched_at: raw.fetched_at, cached: raw.cached };
}

/**
 * Human answer, one line per region, local country flagged. JustWatch is
 * credited because TMDB's licence for this data requires it.
 */
export function formatWhere(name, w, { local = null } = {}) {
  const L = [`Where to watch ${name}:`];
  for (const [r, a] of Object.entries(w.regions)) {
    const here = r === local ? " (where you are now)" : "";
    L.push(`  ${countryName(r)}${here}: ${longAvailability(a)}`);
  }
  if (w.link) L.push(`  ${w.link}`);
  L.push(`  (JustWatch via TMDB, as of ${w.fetched_at.slice(0, 10)})`);
  return L.join("\n");
}
