"use strict";
// photo-repo — the photo repository: where each photograph is used, and the
// cover photo of a place, for anything that wants to show one.
//
// A photo is STORED once (system/migrations/0040: a `photos` row keyed by the
// photo library's id, one thumbnail at daily-photos/thumbs/<uuid>.jpg). This
// module never copies bytes: it records links (`photo_links`, 0191) from a
// photo to the pages that show it, and reads them back joined to the photo row.
// The same photo can be linked to any number of targets.
//
// Covers: `places` (0191, written by the place-pages plugin) keeps each place's
// cover. `placeCovers` answers "which of these names, near here, is a place
// with a page, and what does it look like?" — the lookup a card makes to put a
// thumbnail beside an option. Without the plugin the table is empty and every
// lookup returns nothing, so callers need no plugin check.
//
// Matching a card's option to a place is EXACT on the folded name (case,
// accents, punctuation) within a radius: set membership over names our own
// tools wrote, never a reading of what a name means (Rule #0b).

const path = require("node:path");

const DEFAULT_COVER_RADIUS_M = 400;

// lang-regex-ok: folds case, accents and punctuation so two spellings of one name compare equal; decides nothing about meaning
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function haversineM(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== "number" || !Number.isFinite(v))) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

let _request = null;
function liveRequest() {
  if (!_request) _request = require(path.join(__dirname, "supabase-rest.js")).request;
  return _request;
}

const q = encodeURIComponent;
const inList = (xs) => `(${xs.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(",")})`; // lang-regex-ok: PostgREST quoting of ids

/** Photo rows by uuid (chunked: PostgREST URLs have a length limit). */
async function photoRows(uuids, { request = liveRequest(), select = "uuid,taken_at,thumb_url,favorite,labels,media_type,self_captured,hidden,in_trash,latitude,longitude,persons" } = {}) {
  const out = [];
  const ids = [...new Set((uuids || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rows = await request(`/rest/v1/photos?select=${select}&uuid=in.${q(inList(chunk))}`);
    out.push(...(rows || []));
  }
  return out;
}

/**
 * Upsert links. Each: {photo_uuid, target, role?, context?, added_by}. A link
 * the user pinned as a cover keeps its role: a tool's upsert never demotes it.
 */
async function link(links, { request = liveRequest() } = {}) {
  const rows = (links || []).filter((l) => l && l.photo_uuid && l.target && l.added_by)
    .map((l) => ({ photo_uuid: l.photo_uuid, target: l.target, role: l.role || "gallery", context: l.context ?? null, added_by: l.added_by }));
  if (!rows.length) return 0;
  const pinned = new Set((await request(`/rest/v1/photo_links?select=photo_uuid,target&role=eq.cover&photo_uuid=in.${q(inList(rows.map((r) => r.photo_uuid)))}`) || [])
    .map((r) => `${r.photo_uuid}|${r.target}`));
  const write = rows.filter((r) => !pinned.has(`${r.photo_uuid}|${r.target}`));
  for (let i = 0; i < write.length; i += 200) {
    await request("/rest/v1/photo_links?on_conflict=photo_uuid,target", {
      method: "POST", body: write.slice(i, i + 200), prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  return write.length;
}

/** Remove one tool's links from one context (a day re-swept), keeping user-pinned covers. */
async function unlinkContext(addedBy, contextPrefix, { request = liveRequest() } = {}) {
  await request(`/rest/v1/photo_links?added_by=eq.${q(addedBy)}&context=like.${q(`${contextPrefix}*`)}&role=neq.cover`, {
    method: "DELETE", prefer: "return=minimal",
  });
}

/** Links of one target, newest photo first, joined to their photo rows. */
async function photosFor(target, { request = liveRequest() } = {}) {
  const links = await request(`/rest/v1/photo_links?select=photo_uuid,role,context,added_by&target=eq.${q(target)}`) || [];
  if (!links.length) return [];
  const rows = new Map((await photoRows(links.map((l) => l.photo_uuid), { request })).map((r) => [r.uuid, r]));
  return links.map((l) => ({ ...l, photo: rows.get(l.photo_uuid) || null }))
    .filter((l) => l.photo)
    .sort((a, b) => String(b.photo.taken_at).localeCompare(String(a.photo.taken_at)));
}

/** Every target one photo is used on. */
async function usesOf(uuid, { request = liveRequest() } = {}) {
  return await request(`/rest/v1/photo_links?select=target,role,context,added_by,added_at&photo_uuid=eq.${q(uuid)}`) || [];
}

/** Pin a photo as a target's cover (the user's choice; sticky). Any earlier pin on that target is released. */
async function pinCover(target, uuid, { request = liveRequest() } = {}) {
  await request(`/rest/v1/photo_links?target=eq.${q(target)}&role=eq.cover`, { method: "PATCH", body: { role: "gallery" }, prefer: "return=minimal" });
  await request("/rest/v1/photo_links?on_conflict=photo_uuid,target", {
    method: "POST", body: [{ photo_uuid: uuid, target, role: "cover", context: "pinned", added_by: "user" }],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

/** The cover of one page (a place's page), or null. */
async function coverForPage(pageId, { request = liveRequest() } = {}) {
  if (!pageId) return null;
  const rows = await request(`/rest/v1/places?select=id,name,page_id,cover_url,kind&page_id=eq.${q(pageId)}&cover_url=not.is.null&limit=1`) || [];
  return rows[0] ? { url: rows[0].cover_url, place_id: rows[0].id, page_id: rows[0].page_id, name: rows[0].name, kind: rows[0].kind } : null;
}

/**
 * Covers for names near a point: {<name as given>: {url, page_id, place_id, distance_m}}.
 * A name matches a place with a page and a cover whose folded names include it,
 * within `radiusM` of (lat, lon). Without a point, a name matches only when
 * exactly one place carries it (a chain's branches are ambiguous).
 */
async function placeCovers({ lat = null, lon = null, names = [], radiusM = DEFAULT_COVER_RADIUS_M } = {}, { request = liveRequest() } = {}) {
  const want = [...new Set((names || []).map(String).filter((n) => norm(n)))];
  if (!want.length) return {};
  const folded = [...new Set(want.map(norm))];
  const rows = await request(`/rest/v1/places?select=id,name,page_id,cover_url,lat,lon,norm_names&page_id=not.is.null&cover_url=not.is.null&norm_names=ov.${q(`{${folded.map((n) => `"${n}"`).join(",")}}`)}`) || [];
  const out = {};
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
  for (const name of want) {
    const n = norm(name);
    const hits = rows.filter((r) => (r.norm_names || []).includes(n))
      .map((r) => ({ r, d: hasPoint ? haversineM(lat, lon, r.lat, r.lon) : null }));
    let pick = null;
    if (hasPoint) pick = hits.filter((h) => h.d <= radiusM).sort((a, b) => a.d - b.d)[0] || null;
    else if (hits.length === 1) pick = hits[0];
    if (pick) out[name] = { url: pick.r.cover_url, page_id: pick.r.page_id, place_id: pick.r.id, ...(pick.d !== null ? { distance_m: Math.round(pick.d) } : {}) };
  }
  return out;
}

module.exports = {
  DEFAULT_COVER_RADIUS_M,
  norm,
  haversineM,
  photoRows,
  link,
  unlinkContext,
  photosFor,
  usesOf,
  pinCover,
  coverForPage,
  placeCovers,
};
