"use strict";
// place-photo-store — a Google Places photograph is fetched ONCE, kept in our
// own storage, and every later use reads the copy.
//
// Why: every photo is stored in our own database and nothing is fetched more
// than once. Photo fetches are the one
// Places call with no free allowance to speak of — $7 per thousand — and this
// repo's photo paths all treated a photograph as something to fetch on every
// render: the day renderer pulled six candidates per stop for the vision pick
// on every render, the place-photo CLI re-fetched the winner for every day's
// slug, and the `places` CLI handed out key-bearing media URLs that billed on
// every load by whatever rendered them.
//
// The key is the PLACE and the slot (first photograph, second, …), never the
// photo reference: Google returns a different reference for the same
// photograph on every response, so a cache keyed on references never hits
// (verified against a second Places client's 14-day cache that never hit).
//
// Rows: public.place_photos (data/migrations/20260910_place_photos.sql).
// Bytes: Supabase Storage, bucket daily-photos, place-photos/<placeId>/<slot>.jpg.
// Every path that reaches Google goes through `download` and is logged as a
// photoMedia call by places-log.js, so `places-budget calls` counts them.

const path = require("node:path");
const { createHash } = require("node:crypto");
const { request, SUPABASE_URL } = require(path.join(__dirname, "supabase-rest.js"));
const { logPlacesCall } = require(path.join(__dirname, "places-log.js"));
const { placesBlockReason } = require(path.join(__dirname, "places-guard.js"));

const BUCKET = "daily-photos";
const PREFIX = "place-photos";
const PHOTO_MAX_PX = 900;

function photoKey(placeId, slot) { return `${placeId}:${slot}`; }

/** `places/{placeId}/photos/{photoId}` → placeId, or null. */
function placeIdFromRef(ref) {
  const m = /^places\/([^/]+)\/photos\/[^/]+$/.exec(String(ref || ""));
  return m ? m[1] : null;
}

function serviceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }

const liveDeps = {
  async read(key) {
    const rows = await request(`/rest/v1/place_photos?key=eq.${encodeURIComponent(key)}&select=*&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  },
  async download(ref, tool) {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return null;
    // A store miss is the one place this file spends money. places-client
    // prices it against the month ledger, applies the budget block, and logs it.
    let res;
    try {
      res = await require(path.join(__dirname, "places-client.js")).media(tool || "place-photo-store", ref,
        { maxHeightPx: PHOTO_MAX_PX, key: apiKey, note: "store miss — the one fetch" });
    } catch { return null; }
    if (!res) return null;
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "image/jpeg" };
  },
  async upload(placeId, slot, bytes, contentType) {
    const ext = /png/.test(contentType) ? "png" : /webp/.test(contentType) ? "webp" : "jpg";
    const objectKey = `${PREFIX}/${placeId}/${slot}.${ext}`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectKey}`, {
      method: "POST",
      headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, "Content-Type": contentType,
                 "x-upsert": "true", "cache-control": "public, max-age=31536000, immutable" },
      body: bytes,
    });
    if (!res.ok) throw new Error(`storage upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectKey}`;
  },
  async write(row) {
    await request(`/rest/v1/place_photos?on_conflict=key`, { method: "POST", body: row,
      prefer: "resolution=merge-duplicates,return=minimal" });
  },
  async fetchStored(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  },
};

/**
 * The stored URL for a place's photograph slot. Fetches from Google only if
 * this slot has never been stored. Returns { url, fetched, row } or null when
 * nothing is stored and nothing could be fetched.
 */
async function ensurePlacePhoto(placeId, slot, ref, { tool = "place-photo-store", deps = liveDeps } = {}) {
  if (!placeId) return null;
  const key = photoKey(placeId, slot);
  const stored = await deps.read(key);
  if (stored && stored.url) return { url: stored.url, fetched: false, row: stored };
  if (!ref) return null;
  const got = await deps.download(ref, tool);
  if (!got) return null;
  const url = await deps.upload(placeId, slot, got.bytes, got.contentType);
  const row = {
    key, place_id: placeId, slot, google_ref: ref, url,
    sha256: createHash("sha256").update(got.bytes).digest("hex"),
    bytes: got.bytes.length, content_type: got.contentType, source: "places", fetched_by: tool,
    fetched_at: new Date().toISOString(),
  };
  await deps.write(row);
  return { url, fetched: true, row, bytes: got.bytes };
}

/** The photograph's bytes — from our storage, never from Google twice. */
async function placePhotoBytes(placeId, slot, ref, opts = {}) {
  const deps = opts.deps || liveDeps;
  const r = await ensurePlacePhoto(placeId, slot, ref, opts);
  if (!r) return null;
  if (r.bytes) return { buf: r.bytes, url: r.url, fetched: true };
  const buf = await deps.fetchStored(r.url);
  return buf ? { buf, url: r.url, fetched: false } : null;
}

module.exports = { ensurePlacePhoto, placePhotoBytes, placeIdFromRef, photoKey, BUCKET, PREFIX, PHOTO_MAX_PX, _liveDeps: liveDeps };
