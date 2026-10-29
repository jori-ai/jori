// place-photo-cache.test.mjs — a Places photograph is fetched from Google once.
//
// Thousands of photo fetches in ten days were once all photographs already
// fetched before; each test is a way that happened. Every dependency (store
// read/write, download, upload) is a stub: no network.
//
// Run: node --test tests/place-photo-cache.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ensurePlacePhoto, placePhotoBytes, placeIdFromRef, photoKey } = require("../lib/place-photo-store.js");

const PLACE = "ChIJFAKEplace00000example";
const REF = `places/${PLACE}/photos/FAKEphotoRef0001`;
const REF_AGAIN = `places/${PLACE}/photos/a-new-reference-for-the-same-photo`;

function fakeDeps() {
  const rows = new Map();
  const calls = { download: 0, upload: 0, fetchStored: 0 };
  const deps = {
    read: async k => rows.get(k) || null,
    download: async () => { calls.download += 1; return { bytes: Buffer.from("jpeg"), contentType: "image/jpeg" }; },
    upload: async (placeId, slot) => { calls.upload += 1; return `https://store/place-photos/${placeId}/${slot}.jpg`; },
    write: async row => { rows.set(row.key, row); },
    fetchStored: async () => { calls.fetchStored += 1; return Buffer.from("jpeg"); },
  };
  return { deps, rows, calls };
}

test("placeIdFromRef reads the place; anything else is null", () => {
  assert.equal(placeIdFromRef(REF), PLACE);
  assert.equal(placeIdFromRef("places/x"), null);
  assert.equal(placeIdFromRef(undefined), null);
  assert.equal(photoKey(PLACE, 2), `${PLACE}:2`);
});

test("first call fetches and stores; second call for the same slot never touches Google", async () => {
  const { deps, calls } = fakeDeps();
  const a = await ensurePlacePhoto(PLACE, 0, REF, { deps });
  const b = await ensurePlacePhoto(PLACE, 0, REF_AGAIN, { deps });
  assert.equal(a.fetched, true);
  assert.equal(b.fetched, false);
  assert.equal(a.url, b.url);
  assert.equal(calls.download, 1);
});

test("slots are separate photographs", async () => {
  const { deps, calls } = fakeDeps();
  await ensurePlacePhoto(PLACE, 0, REF, { deps });
  await ensurePlacePhoto(PLACE, 1, `places/${PLACE}/photos/b`, { deps });
  assert.equal(calls.download, 2);
});

test("no reference and nothing stored → null, no fetch; a Google refusal stores nothing", async () => {
  const { deps, calls, rows } = fakeDeps();
  assert.equal(await ensurePlacePhoto(PLACE, 0, undefined, { deps }), null);
  deps.download = async () => { calls.download += 1; return null; };
  assert.equal(await ensurePlacePhoto(PLACE, 0, REF, { deps }), null);
  assert.equal(rows.size, 0);
});

test("the row records provenance and the tool that made the one fetch", async () => {
  const { deps, rows } = fakeDeps();
  await ensurePlacePhoto(PLACE, 0, REF, { deps, tool: "trip-day-render" });
  const row = rows.get(photoKey(PLACE, 0));
  assert.equal(row.google_ref, REF);
  assert.equal(row.fetched_by, "trip-day-render");
  assert.equal(row.source, "places");
  assert.ok(row.sha256.length === 64);
});

test("placePhotoBytes returns Google's bytes on the first call and our stored copy after", async () => {
  const { deps, calls } = fakeDeps();
  const first = await placePhotoBytes(PLACE, 0, REF, { deps });
  const second = await placePhotoBytes(PLACE, 0, REF, { deps });
  assert.equal(first.fetched, true);
  assert.equal(second.fetched, false);
  assert.equal(calls.download, 1);
  assert.equal(calls.fetchStored, 1);
  assert.equal(second.buf.toString(), "jpeg");
});
