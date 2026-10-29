// venue-events/fetchers.mjs — one function per KIND of source. Each returns
// raw records already mapped onto makeEvent()'s fields; venue-ingest owns
// merging, health bookkeeping and the store.
//
// Built-in kinds (rows in agent/local/config/venue-events.json `sources`):
//   tm         Ticketmaster Discovery, by pinned venue id (structured JSON)
//   tribe      The Events Calendar WP REST API (any WordPress venue running it)
//   wpPosts    a plain WP REST post type whose title carries the date
//   cdp        a verified _events-generic browsing skill run in the host's
//              automation Chrome (browsing-skills/skills/_events-generic/sources.json);
//              `date_field` names the row field a custom action puts its start in
//   squarespaceEvents | dice | jsonLdPage
//              calendar platforms with a machine format — sources-generic.mjs
//
// More kinds come from this installation's hook modules,
// lib/venue-events/_ext/*.mjs, each exporting `kinds` ({name: fetcher}) and
// optionally `codeFiles` ({name: repo-relative file}, for skill-repair) and
// `browserKinds` (kinds that need the automation Chrome). A
// venue's own private API or markup belongs there, not here.
//
// No model anywhere in here: these are fetch + parse of machine formats.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeEvent, addDays } from "./normalize.mjs";
import { fetchSquarespaceEvents, fetchDice, fetchJsonLdPage, decodeEntities, stripTags, isoClock } from "./sources-generic.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(__dirname, "..", "..");
const SKILLS = path.join(REPO, "browsing-skills/skills");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (jori venue-ingest)", ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split("?")[0]}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ─── Ticketmaster ──────────────────────────────────────────────────────────

const TM_BASE = "https://app.ticketmaster.com/discovery/v2";

/** TM status code → our status vocabulary (structured, from the API). */
export function tmStatus(code) {
  const c = String(code || "").toLowerCase();
  if (c === "cancelled" || c === "canceled") return "cancelled";
  if (c === "postponed" || c === "rescheduled") return "postponed";
  if (c === "offsale") return "offsale";
  return c ? "onsale" : null;
}

export function tmCategory(ev) {
  const cl = (ev.classifications || [])[0] || {};
  const seg = String(cl.segment?.name || "").toLowerCase();
  const genre = String(cl.genre?.name || "").toLowerCase();
  if (genre === "comedy") return "comedy";
  if (seg === "music") return "music";
  if (seg.startsWith("arts")) return genre === "theatre" ? "theater" : "arts";
  return seg || "other";
}

/** TM hands back affiliate-wrapped links (ticketmaster.evyy.net/...?u=<real>); unwrap to the real event page. */
export function unwrapTmUrl(u) {
  if (!u) return u;
  try {
    const url = new URL(u);
    const inner = url.searchParams.get("u");
    return inner && /^https?:\/\//.test(inner) ? inner : u; // lang-regex-ok: URL scheme check
  } catch { return u; }
}

export function mapTmEvent(ev, src, ref) {
  const venue = ev._embedded?.venues?.[0];
  const cl = (ev.classifications || [])[0] || {};
  const out = makeEvent(src, {
    title: ev.name,
    date: ev.dates?.start?.localDate,
    time: ev.dates?.start?.localTime,
    venue: src.venue || venue?.name,
    url: unwrapTmUrl(ev.url),
    performers: (ev._embedded?.attractions || []).map((a) => a.name),
    category: tmCategory(ev),
    status: tmStatus(ev.dates?.status?.code),
    price_min: ev.priceRanges?.[0]?.min ?? null,
    description: [cl.genre?.name, cl.subGenre?.name].filter((g) => g && g !== "Undefined").join(" / ") || null,
  }, ref);
  // The status is the API's own structured field, so the watch lanes need not
  // send a model to read the page (watch.mjs availability()).
  return out ? { ...out, structured_status: true } : out;
}

export async function fetchTm(src, { ref, apiKey, days = 120 }) {
  if (!apiKey) throw new Error("no TICKETMASTER_CONSUMER_KEY");
  const out = [];
  const start = `${ref}T00:00:00Z`;
  const end = `${addDays(ref, days)}T23:59:59Z`;
  for (let page = 0; page < (src.max_pages || 3); page++) {
    const url = new URL(`${TM_BASE}/events.json`);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("venueId", src.tm_venue_id);
    url.searchParams.set("startDateTime", start);
    url.searchParams.set("endDateTime", end);
    url.searchParams.set("size", "200");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "date,asc");
    if (src.classification) url.searchParams.set("classificationName", src.classification);
    const data = await getJson(url.toString());
    for (const ev of data._embedded?.events || []) {
      const e = mapTmEvent(ev, src, ref);
      if (e) out.push(e);
    }
    const p = data.page || {};
    if (p.number + 1 >= p.totalPages) break;
    await sleep(250); // TM allows 5 req/s
  }
  return out;
}

/** Per-artist lookup (watchlist): attraction id by exact-ish name, then its events. */
export async function tmEventsForArtist(name, { apiKey, ref, countryCode = null }) {
  const a = new URL(`${TM_BASE}/attractions.json`);
  a.searchParams.set("apikey", apiKey);
  a.searchParams.set("keyword", name);
  a.searchParams.set("size", "5");
  const ad = await getJson(a.toString());
  const want = name.toLowerCase();
  const att = (ad._embedded?.attractions || []).find((x) => String(x.name).toLowerCase() === want);
  if (!att) return [];
  await sleep(220);
  const e = new URL(`${TM_BASE}/events.json`);
  e.searchParams.set("apikey", apiKey);
  e.searchParams.set("attractionId", att.id);
  e.searchParams.set("size", "50");
  e.searchParams.set("sort", "date,asc");
  e.searchParams.set("startDateTime", `${ref}T00:00:00Z`);
  if (countryCode) e.searchParams.set("countryCode", countryCode);
  const ed = await getJson(e.toString());
  return (ed._embedded?.events || []).map((ev) => {
    const v = ev._embedded?.venues?.[0];
    const src = { key: "tm-artist", category: "music", city: (v?.city?.name || "").toLowerCase() };
    const out = mapTmEvent(ev, { ...src, venue: v?.name }, ref);
    if (out) {
      out.city = v?.city?.name || null;
      out.state = v?.state?.stateCode || null;
      out.country = v?.country?.countryCode || null;
      out.performers = out.performers.length ? out.performers : [att.name];
    }
    return out;
  }).filter(Boolean);
}

// ─── The Events Calendar (tribe) WP REST ───────────────────────────────────

export function mapTribe(ev, src, ref) {
  return makeEvent(src, {
    title: decodeEntities(ev.title),
    date: ev.start_date,
    time: String(ev.start_date || "").slice(11, 16) || null,
    venue: src.venue,
    url: ev.url,
    category: (ev.categories || []).map((c) => c.name).join(" / ") || src.category,
    description: stripHtml(ev.excerpt || ev.description || "").slice(0, 400),
  }, ref);
}

export async function fetchTribe(src, { ref, days = 120 }) {
  const out = [];
  let url = `${src.base}/wp-json/tribe/events/v1/events?per_page=50&start_date=${ref}&end_date=${addDays(ref, days)}`;
  for (let i = 0; url && i < 10; i++) {
    const d = await getJson(url);
    for (const ev of d.events || []) { const e = mapTribe(ev, src, ref); if (e) out.push(e); }
    url = d.next_rest_url || null;
  }
  return out;
}

// ─── Plain WP REST post type whose title carries the date ─────────────────

export async function fetchWpPosts(src, { ref }) {
  const list = await getJson(`${src.api}${src.api.includes("?") ? "&" : "?"}per_page=50&orderby=date&order=desc`);
  return (Array.isArray(list) ? list : []).map((p) => {
    const title = decodeEntities(p.title?.rendered || "");
    return makeEvent(src, { title, date: null, text_date: title, time: title, venue: src.venue, url: p.link, category: src.category }, ref);
  }).filter(Boolean);
}

// ─── Browsing skills via the automation Chrome ─────────────────────────────

function readSources() {
  return JSON.parse(fs.readFileSync(path.join(SKILLS, "_events-generic/sources.json"), "utf8")).sources;
}

// Kinds and their code files from this installation's hook modules
// (lib/venue-events/_ext/*.mjs), filled by loadFetchers().
const EXT_CODE = {};
const BUILTIN_CODE = { squarespaceEvents: "sources-generic.mjs", dice: "sources-generic.mjs", jsonLdPage: "sources-generic.mjs" };

/**
 * Where a source's reading code lives and which page it reads — what the
 * skill-repair job needs to start (lib/skill-repair.mjs). Repo-relative.
 */
export function sourceCodeRef(src) {
  if (src.kind === "cdp") {
    const cfg = readSources()[src.source_key] || {};
    // A generic listing-extract source is fixed in its sources.json selectors;
    // a custom action in its own reference file.
    const file = cfg.action
      ? `browsing-skills/skills/_events-generic/references/${cfg.action}.md`
      : "browsing-skills/skills/_events-generic/sources.json";
    return { action_file: file, url: cfg.url || null };
  }
  const file = EXT_CODE[src.kind] || `lib/venue-events/${BUILTIN_CODE[src.kind] || "fetchers.mjs"}`;
  return { action_file: file, url: src.url || src.api || src.base || null };
}

/** Run one browsing-skill action in the automation Chrome; its parsed JSON result. */
export async function runSkill(url, skillFile, params) {
  const { runActionCdp, extractActionBlock } = await import(path.join(REPO, "browsing-skills/tools/cdp-runner.mjs"));
  const actionBlock = extractActionBlock(skillFile);
  if (!actionBlock) throw new Error(`no action block in ${skillFile}`);
  const res = await runActionCdp({ url, actionBlock, params, settleMs: 3000, loadTimeoutMs: 20000 });
  if (!res?.ok) throw new Error(res?.error || "cdp action failed");
  const r = res.result;
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : r;
}

export async function fetchCdp(src, { ref }) {
  const cfg = readSources()[src.source_key];
  if (!cfg) throw new Error(`unknown _events-generic source ${src.source_key}`);
  const action = cfg.action || "listing-extract";
  const skillFile = path.join(SKILLS, "_events-generic/references", `${action}.md`);
  const params = cfg.action
    ? { ...(cfg.actionParams || {}), sourceKey: src.source_key }
    : { sourceKey: src.source_key, cardSelector: cfg.cardSelector, fields: cfg.fields, limit: 150, hydrationMs: cfg.hydrationMs || 0 };
  const data = await runSkill(cfg.url, skillFile, params);
  const events = data?.events || [];
  // A custom action that finds nothing says why in `diagnostic` (e.g. "no
  // calendar element on page"). Log it so a zero-row night is self-describing
  // in the ingest log instead of a bare 0: a text-block parser once returned []
  // silently for 10+ nights after a site redesign.
  if (!events.length && data?.diagnostic) console.error(`[venue-ingest] ${src.key}: ${data.diagnostic}`);
  return cdpRows(src, events, { ref, pageUrl: cfg.url });
}

/**
 * A browsing-skill run's rows → events. A custom action whose rows name their
 * start differently (an ISO local date-time under its own field, e.g. a
 * cinema's showtime) says which field with the source row's `date_field`; its
 * clock becomes the time.
 */
export function cdpRows(src, events, { ref, pageUrl = null } = {}) {
  const own = (ev) => (src.date_field ? ev[src.date_field] : null);
  return (events || []).map((ev) => makeEvent(src, {
    title: ev.title,
    date: own(ev) || ev.isoDate || ev.startDate || ev.date || null,
    // Listing cards often carry the date inside the card text. A source opts in
    // to reading the card's description too (`date_in_description`); opt-in so
    // existing rows keep their keys.
    text_date: src.date_in_description ? [ev.title, ev.description].filter(Boolean).join(" ") : ev.title,
    time: Array.isArray(ev.times) ? ev.times[0] : ev.time || isoClock(own(ev)) || undefined,
    url: ev.url || pageUrl,
    venue: ev.venue && src.keep_skill_venue ? ev.venue : src.venue,
    description: ev.description || ev.artists || null,
  }, ref)).filter(Boolean);
}

// ─── helpers ───────────────────────────────────────────────────────────────

export const stripHtml = stripTags;
export { decodeEntities };

/** The built-in kinds. loadFetchers() adds this installation's own. */
export const FETCHERS = {
  tm: fetchTm,
  tribe: fetchTribe,
  wpPosts: fetchWpPosts,
  cdp: fetchCdp,
  squarespaceEvents: fetchSquarespaceEvents,
  dice: fetchDice,
  jsonLdPage: fetchJsonLdPage,
};

/** Kinds that need the automation Chrome (skipped, not failed, when it is down). Hook modules add theirs via `browserKinds`. */
export const BROWSER_KINDS = new Set(["cdp"]);

export const EXT_DIR = path.join(__dirname, "_ext");

/**
 * Built-in kinds plus every kind an _ext module exports. A hook module that
 * fails to load is reported and skipped: one broken private fetcher must not
 * cost every other source its run.
 */
export async function loadFetchers({ dir = EXT_DIR, log = (m) => console.error(m) } = {}) {
  const out = { ...FETCHERS };
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.m?js$/.test(f)).sort(); } catch { return out; }
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      for (const [kind, fn] of Object.entries(mod.kinds || {})) {
        if (typeof fn !== "function") continue;
        out[kind] = fn;
        EXT_CODE[kind] = (mod.codeFiles || {})[kind] || path.relative(REPO, path.join(dir, f));
      }
      for (const kind of mod.browserKinds || []) BROWSER_KINDS.add(kind);
    } catch (e) { log(`venue-events: hook module ${f} failed to load: ${e?.message || e}`); }
  }
  return out;
}
