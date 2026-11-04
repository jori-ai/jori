// place-lore — what an encyclopedia knows about the ground the user is standing on.
//
// WHY. The `nearby` lane offers a "factoid" output and demands something
// "specific and verifiable" about the neighbourhood — then had no source for it.
// Google's `overview` looked like one but usually is not: `build_overview` falls
// back to the first user review, so what reaches the prompt is typically tourist
// chatter ("We came back twice during our 4 day stay"), not fact. A trip
// reservoir carries real material but only exists where a trip was planned, and
// nobody plans one for the cities they already know well.
//
// Wikipedia's geosearch answers exactly this question and needs no key, no
// research pass and no reservoir. Standing on Passage du Maure it returns, in
// metres: Musée de la Poupée (33m), Rambuteau métro (34m), Impasse Berthaud
// (34m), Passage du Maure itself (54m). That is the "covered passage the user
// is walking through" the prompt asks for, sourced, in any city on earth.
//
// Cheap by construction: two HTTP calls, cached per ~110m coordinate cell, and
// the ground truth of a place does not change — so a cell stays warm for weeks.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installRoot } from "./root.cjs";

const CACHE_DIR = path.join(installRoot(), "data", "place-lore");
// A place's history does not go stale. The only reason to re-fetch at all is
// that Wikipedia gains articles.
const TTL_DAYS = 45;
// Bumped whenever an item gains a FIELD, because a warm cell is otherwise
// indistinguishable from a fresh one and would serve the old shape for six
// weeks. v2 added `lat`/`lon`/`image` (2026-08-09, the ping-media work).
const CACHE_V = 3; // 3 (2026-10-20): items carry `id` (wp:<lang>:<pageid>) and `qid` for dedup by identity
// ~110m per 0.001°, so this cell is about the size of the search radius. Two
// ticks a block apart share a cell and the second is free.
const CELL_DP = 3;

// Which Wikipedia to ask. The local-language edition is far richer on local
// streets and buildings than en — fr.wikipedia has an article on Passage du
// Maure; en does not — so we ask both and merge.
//
// Keyed on the country as the geocoder spells it, which is machine-generated
// structure, not anything the user wrote (Rule #0b). Unknown country falls back to
// en alone, which is correct everywhere and merely thinner.
const COUNTRY_WIKI = {
  France: "fr", Israel: "he", Spain: "es", Italy: "it", Portugal: "pt",
  Germany: "de", Netherlands: "nl", Belgium: "fr", Switzerland: "de",
  Austria: "de", Greece: "el", Mexico: "es", Brazil: "pt", Japan: "ja",
};

/**
 * Wikipedia's plaintext extract, flattened to something a prompt can read.
 *
 * Keeps section titles as inline labels so `Origine du nom` still signposts the
 * naming story, drops the blank scaffolding, and cuts before the reference
 * apparatus becomes the bulk of it. No attempt to pick the good sentence — that
 * is the model's job.
 *
 * lang-regex-ok: this parses Wikipedia's own `== Header ==` markup, which is
 * machine-generated document structure, not anything a person said to Jori.
 */
function flatten(text) {
  if (!text) return "";
  return String(text)
    .replace(/^=+\s*(.+?)\s*=+$/gm, "· $1:")   // == Historique == → · Historique:
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    // lang-regex-ok: drops Wikipedia section headers that have no body under
    // them. This is the encyclopedia's own markup, not anything the user wrote.
    .replace(/·\s*[^:]{1,40}:\s*(?=·)/g, "")
    .trim()
    .slice(0, 700);
}

/** Titles differ across language editions for the same subject — "Musée de la
 *  Poupée" vs "Musée de la Poupée - Au Petit Monde Ancien". Compare on a
 *  stripped form and treat containment either way as the same thing. */
function titleKey(t) {
  return String(t)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // lang-regex-ok: unicode accent marks
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();  // lang-regex-ok: punctuation, not meaning
}

function cellKey(lat, lon, radiusM) {
  return `${lat.toFixed(CELL_DP)}_${lon.toFixed(CELL_DP)}_${radiusM}`;
}

function readCache(key) {
  try {
    const p = path.join(CACHE_DIR, `${key}.json`);
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if ((raw?.v || 1) !== CACHE_V) return null;
    const age = (Date.now() - Date.parse(raw?.fetched_at || 0)) / 86400000;
    if (!Number.isFinite(age) || age > TTL_DAYS) return null;
    return raw;
  } catch { return null; }
}

function writeCache(key, payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const p = path.join(CACHE_DIR, `${key}.json`);
    fs.writeFileSync(p, JSON.stringify(payload, null, 2) + "\n");
  } catch { /* cache is an optimisation; never fail the lane over it */ }
}

function getJson(url) {
  try {
    const raw = execFileSync("curl", ["-s", "--max-time", "12", "-H", "User-Agent: jori/1.0 (personal assistant)", url],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(raw);
  } catch { return null; }
}

/** Articles whose subject sits within `radiusM` of the point, nearest first. */
function geosearch(lang, lat, lon, radiusM, limit) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=geosearch`
    + `&gscoord=${lat}%7C${lon}&gsradius=${Math.min(radiusM, 10000)}&gslimit=${limit}&format=json`;
  const j = getJson(url);
  const rows = j?.query?.geosearch;
  return Array.isArray(rows) ? rows : [];
}

/**
 * The article text — deliberately NOT just the intro.
 *
 * `exintro` was the obvious choice and it is the wrong one: the lead paragraph
 * of a street article is a tautology. Passage du Maure's is "a street situated
 * in the 3rd arrondissement of Paris, France" — true, useless, and the only
 * thing an intro-only fetch would ever have surfaced.
 *
 * The interesting part is further down, under `Origine du nom` and `Historique`:
 * named after a sign depicting a Moor's head that hung on the old rue du Maure,
 * and cut in 1977 during the Quartier de l'Horloge redevelopment. That is a
 * genuine fact about the ground the user is standing on, and exactly what the
 * local-history lane is for.
 *
 * So we take the whole plaintext and let the MODEL decide what is worth saying.
 * Code picking the interesting sentence would mean ranking prose by keyword,
 * which is the judgment half of Rule #0b and not ours to make.
 *
 * ONE PAGE PER CALL, deliberately. `prop=extracts` allows 20 pageids in a batch
 * only for intro-only extracts; ask for full text and `exlimit` is 1, so a
 * batched request silently returns the body of the FIRST page and nothing for
 * the rest. That failure is invisible — the call succeeds, the JSON is
 * well-formed, five of six articles simply have no extract — and it cost this
 * lane four of its six findings before it was spotted. Bounded and cached, so
 * a handful of small calls per new cell is the right trade.
 */
function extracts(lang, pageids) {
  const out = {};
  for (const id of pageids) {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts`
      + `&explaintext=1&redirects=1&pageids=${id}&format=json`;
    const j = getJson(url);
    const pages = j?.query?.pages || {};
    for (const [pid, p] of Object.entries(pages)) {
      const txt = String(p?.extract || "").trim();
      if (txt) out[pid] = txt;
    }
  }
  return out;
}

/**
 * The article's lead image, when it has one.
 *
 * A ping is often read after the fact, so when Wikipedia has an image it is
 * shown: a line about a covered passage means nothing an hour later; a
 * photograph of it is self-explanatory whenever the user opens the app.
 *
 * BATCHED, unlike `extracts` — the one-page-per-call rule above is a quirk of
 * `prop=extracts` with full text (`exlimit` is 1). `prop=pageimages` takes up
 * to 50 pageids per request and answers for all of them, so the whole cell
 * costs one call per language edition.
 *
 * `thumbnail` at 900px rather than `original`: originals are routinely 8-20MB
 * scans, and this is rendered in a chat bubble at ~260pt. The URL points at
 * `upload.wikimedia.org` and keeps its `.jpg`/`.png` path extension, which is
 * what the iOS client's MessageContentParser matches on to render it inline.
 */
function pageImages(lang, pageids) {
  const out = {};
  const qids = {};
  if (!pageids.length) return { pics: out, qids };
  // pageprops rides on the same call: the Wikidata QID is the one identity
  // shared by the en and he/fr articles about the same tower, which is what
  // the local-history ledger keys on (lib/local-history-ledger.mjs).
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=pageimages%7Cpageprops`
    + `&piprop=thumbnail&pithumbsize=900&ppprop=wikibase_item&pageids=${pageids.join("%7C")}&format=json`;
  const j = getJson(url);
  const pages = j?.query?.pages || {};
  for (const [pid, p] of Object.entries(pages)) {
    const src = p?.thumbnail?.source;
    if (src) out[pid] = String(src);
    const q = p?.pageprops?.wikibase_item;
    if (q) qids[pid] = String(q);
  }
  return { pics: out, qids };
}

/**
 * Encyclopedic context for a point.
 *
 * @returns {{items: Array<{title,dist_m,lat,lon,summary,url,image,lang}>, langs: string[], cached: boolean}}
 */
export function placeLore(lat, lon, { radiusM = 250, limit = 6, country = null } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { items: [], langs: [], cached: false };

  const key = cellKey(lat, lon, radiusM);
  const hit = readCache(key);
  if (hit) return { items: hit.items || [], langs: hit.langs || [], cached: true };

  const local = country ? COUNTRY_WIKI[country] : null;
  const langs = local && local !== "en" ? [local, "en"] : ["en"];

  const items = [];
  const seen = new Set();
  for (const lang of langs) {
    const rows = geosearch(lang, lat, lon, radiusM, limit);
    if (!rows.length) continue;
    const ids = rows.map((r) => r.pageid).slice(0, limit);
    const ex = extracts(lang, ids);
    const { pics, qids } = pageImages(lang, ids);
    for (const r of rows.slice(0, limit)) {
      const title = String(r.title || "").trim();
      const norm = titleKey(title);
      // Containment either way: the en and fr editions describe one museum
      // under two different titles, and one line about it is enough.
      if (!title || !norm) continue;
      if ([...seen].some((s2) => s2 === norm || s2.includes(norm) || norm.includes(s2))) continue;
      const summary = flatten(ex[String(r.pageid)]);
      // An article with no readable body tells us nothing sayable.
      if (!summary) continue;
      seen.add(norm);
      items.push({
        id: `wp:${lang}:${r.pageid}`,
        qid: qids[String(r.pageid)] || null,
        title,
        dist_m: Math.round(Number(r.dist) || 0),
        // The article's own coordinates, which are the SUBJECT's coordinates —
        // not the user's. That is what makes a "here is you, there is it" map possible
        // without a second lookup.
        lat: Number(r.lat),
        lon: Number(r.lon),
        summary,
        url: `https://${lang}.wikipedia.org/?curid=${r.pageid}`,
        image: pics[String(r.pageid)] || null,
        lang,
      });
    }
  }
  items.sort((a, b) => a.dist_m - b.dist_m);

  const payload = { v: CACHE_V, fetched_at: new Date().toISOString(), items, langs };
  writeCache(key, payload);
  return { items, langs, cached: false };
}

/** Render for a prompt. */
export function renderLoreBlock(lore) {
  if (!lore?.items?.length) return "";
  const lines = lore.items.map((i) =>
    `  - ${i.title} (${i.dist_m}m)\n      ${i.summary}\n      ${i.url}`);
  return `WHAT AN ENCYCLOPEDIA SAYS IS RIGHT HERE (Wikipedia, by distance — this is FACT, and it is where a factoid must come from):
${lines.join("\n")}`;
}

/**
 * Article text for an OpenStreetMap feature that names its Wikidata item but
 * has no article nearby in geosearch (2026-10-20). The QID's sitelinks give the
 * article title in the local edition and en; one extract + image per hit.
 * Cached per QID for TTL_DAYS. Free, keyless; null when there is nothing.
 */
export function qidLore(qid, { country = null } = {}) {
  if (!qid || !String(qid).startsWith("Q")) return null;
  const key = `qid-${qid}`;
  const hit = readCache(key);
  if (hit) return hit.item || null;
  const ent = getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const e = ent?.entities?.[qid];
  const local = country ? COUNTRY_WIKI[country] : null;
  const langs = local && local !== "en" ? ["en", local] : ["en"];
  let item = null;
  for (const lang of langs) {
    const title = e?.sitelinks?.[`${lang}wiki`]?.title;
    if (!title) continue;
    const j = getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageimages&explaintext=1`
      + `&piprop=thumbnail&pithumbsize=900&redirects=1&titles=${encodeURIComponent(title)}&format=json`);
    const page = Object.values(j?.query?.pages || {})[0];
    const summary = flatten(page?.extract);
    if (!summary) continue;
    item = { title, lang, summary, url: `https://${lang}.wikipedia.org/?curid=${page.pageid}`,
      image: page?.thumbnail?.source || null, id: `wp:${lang}:${page.pageid}` };
    break;
  }
  if (!item && e?.descriptions?.en?.value) {
    item = { title: e?.labels?.en?.value || qid, lang: "en", summary: String(e.descriptions.en.value), url: `https://www.wikidata.org/wiki/${qid}`, image: null, id: null };
  }
  writeCache(key, { v: CACHE_V, fetched_at: new Date().toISOString(), item });
  return item;
}
