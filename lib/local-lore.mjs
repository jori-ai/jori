// local-lore.mjs — everything free sources know about the ground within
// PROXIMITY_M of the user, minus what they have already been told.
//
// Sources, both free and both cached per ~110 m cell:
//   - Wikipedia geosearch, local edition + en (lib/place-lore.mjs)
//   - OpenStreetMap history/landmark features via the shared Overpass mirrors
//     (bin/osm-lore → lib/overpass_client.py)
// No Google Places, ever: history explanations are the nearby pings that land
// (in one review every liked nearby ping was history).
//
// Distance is recomputed from the user's position here, because both caches are
// shared by every point in a cell; a subject past PROXIMITY_M is dropped in
// code, not left for a prompt to notice.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { installTools } from "./root.cjs";
import { placeLore, qidLore } from "./place-lore.mjs";
import { PROXIMITY_M, SAME_SPOT_M, haversineM, alreadyTold, readLedger, identitiesOf } from "./local-history-ledger.mjs";

const BIN = installTools("bin");

function osmLore(lat, lon, radiusM, run = execFileSync) {
  try {
    const raw = run(path.join(BIN, "osm-lore"), [String(lat), String(lon), "--radius", String(radiusM), "--limit", "12"],
      { encoding: "utf8", timeout: 70000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(raw || "{}");
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

/**
 * Merge Wikipedia and OSM rows into subjects. An OSM feature and an article
 * are one subject when they share a QID, or the OSM `wikipedia` tag names the
 * article, or they sit within SAME_SPOT_M of each other under the same QID-less
 * pair. The article supplies the text; OSM supplies ids and dated facts.
 * Pure — exported for tests.
 */
export function mergeSubjects({ lat, lon, wiki = [], osm = [], radiusM = PROXIMITY_M }) {
  const subjects = [];
  for (const w of wiki) {
    const d = haversineM(lat, lon, Number(w.lat), Number(w.lon));
    if (!Number.isFinite(d) || d > radiusM) continue;
    subjects.push({
      title: w.title, lat: Number(w.lat), lon: Number(w.lon), distance_m: Math.round(d),
      ids: [w.id, w.qid].filter(Boolean), qid: w.qid || null,
      summary: w.summary || "", url: w.url || null, image: w.image || null, lang: w.lang || null,
      source: "wikipedia", facts: {},
    });
  }
  for (const o of osm) {
    const d = haversineM(lat, lon, Number(o.lat), Number(o.lon));
    if (!Number.isFinite(d) || d > radiusM) continue;
    const wpTitle = o.wikipedia ? String(o.wikipedia).split(":").slice(1).join(":") : null;
    const twin = subjects.find((s) => (o.qid && s.qid === o.qid)
      || (wpTitle && s.title === wpTitle)
      || (!o.qid && !s.qid && haversineM(s.lat, s.lon, Number(o.lat), Number(o.lon)) <= SAME_SPOT_M));
    if (twin) {
      twin.ids = [...new Set([...twin.ids, o.id, o.qid].filter(Boolean))];
      twin.qid = twin.qid || o.qid || null;
      twin.facts = { ...o.facts, ...twin.facts };
      twin.osm_kind = o.kind;
      continue;
    }
    subjects.push({
      title: o.title, lat: Number(o.lat), lon: Number(o.lon), distance_m: Math.round(d),
      ids: [o.id, o.qid].filter(Boolean), qid: o.qid || null,
      summary: "", url: null, image: null, lang: null,
      source: "openstreetmap", osm_kind: o.kind, facts: o.facts || {}, name_local: o.name_local || null,
    });
  }
  subjects.sort((a, b) => a.distance_m - b.distance_m);
  return subjects;
}

/**
 * Subjects within reach the user has not been told about.
 * @returns {{items: object[], told: Array<{title, reason}>}}
 */
export function localLore(lat, lon, { radiusM = PROXIMITY_M, country = null, ledger = null, deps = {} } = {}) {
  const wiki = (deps.placeLore || placeLore)(lat, lon, { radiusM, limit: 8, country }).items || [];
  const osm = (deps.osmLore || osmLore)(lat, lon, radiusM);
  const all = mergeSubjects({ lat, lon, wiki, osm, radiusM });
  // An OSM feature that names its Wikidata item but had no article in the
  // geosearch (a landmark tower, an old inn): fetch the article by QID.
  // Nearest few only — each is a couple of cached keyless calls.
  const enrich = deps.qidLore || qidLore;
  for (const s of all.filter((x) => !x.summary && x.qid).slice(0, 6)) {
    try {
      const a = enrich(s.qid, { country });
      if (!a?.summary) continue;
      s.summary = a.summary;
      s.url = s.url || a.url;
      s.image = s.image || a.image;
      if (a.id) s.ids = [...new Set([...s.ids, a.id])];
    } catch { /* text is optional; the subject still has its OSM facts */ }
  }
  const entries = ledger || readLedger();
  const items = [], told = [];
  for (const s of all) {
    const v = alreadyTold(s, { entries });
    if (v.told) told.push({ title: s.title, reason: v.reason });
    else items.push({ ...s, ids: identitiesOf(s) });
  }
  return { items, told };
}

/** Render for the nearby prompt. Only subjects with something sayable. */
export function renderLocalLoreBlock(items) {
  const lines = (items || []).map((i) => {
    const facts = Object.entries(i.facts || {}).map(([k, v]) => `${k}=${String(v).slice(0, 160)}`).join("; ");
    const body = i.summary ? i.summary : facts ? `(OpenStreetMap: ${i.osm_kind || "feature"}; ${facts})` : `(OpenStreetMap: ${i.osm_kind || "feature"}, no further detail)`;
    return `  - ${i.title} (${i.distance_m}m)\n      ${body}${i.summary && facts ? `\n      [OSM: ${facts}]` : ""}${i.url ? `\n      ${i.url}` : ""}`;
  });
  if (!lines.length) return "";
  return `WHAT IS WITHIN ${PROXIMITY_M}m OF THE USER (Wikipedia + OpenStreetMap, nearest first — this is FACT, and it is the only place a factoid may come from; everything they have already been told is already removed):\n${lines.join("\n")}`;
}
