// reservoir-photo-policy — give-up-after-N invariants for entry photos.
// Run: node tests/reservoir-photo-policy.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { MAX_PHOTO_ATTEMPTS, photoAction, recordPhotoFailure, clearPhotoFailures, wantedKind } =
  require("../lib/reservoir-photo-policy.js");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

t("an entry with a photo is left alone", () => {
  assert.equal(photoAction({ photo_url: "https://x/y.jpg" }), "have");
});

t("a DISH entry with a RESTAURANT photo is still re-fetched as a dish shot", () => {
  const dish = { dish: "Kouign-amann", photo_url: "https://x/y.jpg" };
  assert.equal(photoAction(dish, { isFood: true }), "fetch");
  assert.equal(photoAction({ ...dish, photo_kind: "dish" }, { isFood: true }), "have");
});

// The 2026-07-21 schema split. Before it, every food entry was assumed to want
// a DISH photo — including the ones that were really restaurants, whose `dish`
// field held a menu blurb ("cuisine bistrot / navarins, ..."). No image source
// can answer a blurb, so each returned its nearest coincidence: a stock sushi
// platter for "Fresh landed fish and seafood", a photo of Douarnenez harbour
// for "sardines grillées fraîches de la criée du matin".
t("a TABLE entry wants the RESTAURANT photo, and keeps it", () => {
  const table = { kind: "table", known_for: "cuisine familiale, plat du jour", best_place: "Chez Yoyo" };
  assert.equal(photoAction(table, { isFood: true }), "fetch");
  assert.equal(photoAction({ ...table, photo_url: "https://x/y.jpg", photo_kind: "restaurant" }, { isFood: true }), "have");
  // ...and a DISH photo on a table is the wrong kind, so it re-fetches.
  assert.equal(photoAction({ ...table, photo_url: "https://x/y.jpg", photo_kind: "dish" }, { isFood: true }), "fetch");
});

t("wantedKind splits food by kind, and leaves non-food alone", () => {
  assert.equal(wantedKind({ dish: "Canelé" }, true), "dish");
  assert.equal(wantedKind({ kind: "table", best_place: "Chez Yoyo" }, true), "restaurant");
  // A legacy row with neither marker is a table: the dish-shaped ones all have
  // a `dish`, so "no dish" is the safe read.
  assert.equal(wantedKind({}, true), "restaurant");
  assert.equal(wantedKind({ name: "Château de Goulaine" }, false), null);
});

t("a photo-less entry is fetched", () => {
  assert.equal(photoAction({ name: "Château de Goulaine" }), "fetch");
});

t("the 17-every-night loop terminates: N misses -> dead-lettered, never retried", () => {
  // The regression this file exists for. "Place du Martray, Lamballe" is an
  // open-air market keyed on a square's address; Places has no photo for it and
  // never will, so it must stop being retried instead of failing forever.
  const entry = { name: "Lamballe Thursday market" };
  for (let i = 1; i <= MAX_PHOTO_ATTEMPTS; i++) {
    assert.equal(photoAction(entry), "fetch", `attempt ${i} should still be tried`);
    const nowDead = recordPhotoFailure(entry);
    assert.equal(nowDead, i === MAX_PHOTO_ATTEMPTS);
  }
  assert.equal(photoAction(entry), "dead");
  // ...and stays dead on every later run, so the failure count can reach zero.
  assert.equal(photoAction(entry), "dead");
});

t("--retry-failed and --refresh revive a dead-lettered entry", () => {
  const entry = { name: "x", photo_attempts: MAX_PHOTO_ATTEMPTS };
  assert.equal(photoAction(entry), "dead");
  assert.equal(photoAction(entry, { retryFailed: true }), "fetch");
  assert.equal(photoAction(entry, { forceRefresh: true }), "fetch");
});

t("a success clears the miss counter", () => {
  const entry = { name: "x" };
  recordPhotoFailure(entry);
  assert.equal(entry.photo_attempts, 1);
  assert.ok(entry.photo_failed_at);
  clearPhotoFailures(entry);
  assert.equal(entry.photo_attempts, undefined);
  assert.equal(entry.photo_failed_at, undefined);
  assert.equal(photoAction(entry), "fetch");
});

console.log(`\n${pass} passed`);
