// reservoir-dedup — pass 2 invariants.
// Run: node tests/reservoir-dedup.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { dedupeReservoir, applyVerdicts, normDish, similarity } =
  require("../lib/reservoir-dedup.js");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

// A fictional base (placeholder coordinates); P(dLat, dLon) offsets it in units
// of 0.0001 degree, so relative distances are what the assertions test.
const BASE = { lat: 45.6789, lon: -1.2345 };
const P = (dLat, dLon) => ({ lat: +(BASE.lat + dLat / 1e4).toFixed(6), lon: +(BASE.lon + dLon / 1e4).toFixed(6) });
const G = (dLat, dLon) => { const p = P(dLat, dLon); return { latitude: p.lat, longitude: p.lon }; };

const res = (buckets) => ({
  area: "test", label: "Test", ...P(0, 0),
  buckets: {
    must_see: [], optional: [], food_specialties: [],
    unique_experiences: [], time_sensitive: [], ...buckets,
  },
});
const live = (r, b) => (r.buckets[b] || []).filter((e) => e.state !== "duplicate");

t("normDish collapses accents, plurals and 'specialite de'", () => {
  assert.equal(normDish("Galettes de sarrasin"), normDish("galette sarrasin"));
  assert.equal(normDish("Spécialité de crêpe"), normDish("crepes"));
});

t("similarity is 1 for identical, low for unrelated", () => {
  assert.equal(similarity("Le Marché Couvert", "marche couvert"), 1);
  assert.ok(similarity("Cathédrale", "Musée Jules Verne") < 0.4);
});

t("the same dish twice keeps only the better-rated one", () => {
  const r = res({ food_specialties: [
    { id: "fs_a", dish: "Galette de sarrasin", best_place: "Crêperie A", rating: 4.2, ...P(-84, 36) },
    { id: "fs_b", dish: "galettes de sarrasin", best_place: "Crêperie B", rating: 4.7, ...P(816, -464) },
  ] });
  const { stats } = dedupeReservoir(r);
  assert.equal(stats.dishes, 1);
  const kept = live(r, "food_specialties");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "fs_b", "higher rating wins");
  assert.equal(r.buckets.food_specialties[0].dup_of, "fs_b");
});

t("dedup is non-destructive — the loser keeps its row", () => {
  const r = res({ food_specialties: [
    { id: "fs_a", dish: "Crêpe", best_place: "A", rating: 4.0, ...P(-184, 536) },
    { id: "fs_b", dish: "crepes", best_place: "B", rating: 4.5, ...P(816, -464) },
  ] });
  dedupeReservoir(r);
  assert.equal(r.buckets.food_specialties.length, 2, "no entry is spliced out");
  assert.equal(r.buckets.food_specialties[0].state, "duplicate");
});

t("one venue in must_see and optional merges into must_see", () => {
  const r = res({
    must_see: [{ id: "ms_x", name: "Château des Exemples", mapsUri: "https://maps.google.com/?cid=1", ...P(-26, 39) }],
    optional: [{ id: "op_x", name: "Chateau des Exemples de Bretagne", mapsUri: "https://maps.google.com/?cid=1", ...P(-26, 39) }],
  });
  const { stats } = dedupeReservoir(r);
  assert.equal(stats.venues, 1);
  assert.equal(live(r, "must_see").length, 1);
  assert.equal(live(r, "optional").length, 0);
  assert.equal(r.buckets.optional[0].dup_of, "ms_x");
});

t("a food specialty AT a must-see venue is LINKED, not merged", () => {
  // Eating there and visiting it are different intents — both entries survive,
  // but the map must draw one pin.
  const r = res({
    must_see: [{ id: "ms_m", name: "Marché de Talensac", mapsUri: "cid=9", ...P(16, 36) }],
    food_specialties: [{ id: "fs_m", dish: "Huîtres", best_place: "Marché de Talensac", mapsUri: "cid=9", ...P(16, 36) }],
  });
  const { stats } = dedupeReservoir(r);
  assert.equal(stats.venues, 0, "no merge");
  assert.equal(stats.linked, 1);
  assert.equal(live(r, "must_see").length, 1);
  assert.equal(live(r, "food_specialties").length, 1);
  assert.equal(r.buckets.must_see[0].same_venue_as, r.buckets.food_specialties[0].same_venue_as);
});

t("two different venues 40m apart are NOT merged", () => {
  const r = res({ optional: [
    { id: "op_1", name: "Librairie Coiffard", ...P(-44, -34) },
    { id: "op_2", name: "Boulangerie Bourdic", ...P(-41, -34) },
  ] });
  const { stats } = dedupeReservoir(r);
  assert.equal(stats.venues, 0, "proximity alone must not merge distinct names");
  assert.equal(live(r, "optional").length, 2);
});

t("near-identical names at one spot merge without asking", () => {
  const r = res({
    must_see: [{ id: "ms_c", name: "Cathédrale Saint-Pierre", ...P(0, 16), rating: 4.6 }],
    optional: [{ id: "op_c", name: "Cathedrale Saint Pierre", ...P(0, 15), rating: 4.5 }],
  });
  const { stats, fuzzy } = dedupeReservoir(r);
  assert.equal(stats.venues, 1);
  assert.equal(fuzzy.filter((f) => f.kind === "venue").length, 0, "certain match is not a candidate");
});

t("same-family dishes come back as candidates instead of being guessed", () => {
  // Bigram similarity scores this pair 0.43 — below any useful threshold — so
  // candidacy has to key on the shared head noun instead.
  const r = res({ food_specialties: [
    { id: "fs_g", dish: "Galette de sarrasin", best_place: "A", ...P(-184, 536) },
    { id: "fs_c", dish: "Galette complète", best_place: "B", ...P(1816, -3464) },
  ] });
  const { stats, fuzzy } = dedupeReservoir(r);
  assert.ok(similarity("Galette de sarrasin", "Galette complète") < 0.5, "string similarity is genuinely low here");
  assert.equal(stats.dishes, 0, "not merged on its own");
  const dish = fuzzy.filter((f) => f.kind === "dish");
  assert.equal(dish.length, 1);
  assert.deepEqual([dish[0].a.id, dish[0].b.id].sort(), ["fs_c", "fs_g"]);
});

t("unrelated dishes are not candidates", () => {
  const r = res({ food_specialties: [
    { id: "fs_h", dish: "Huîtres", best_place: "A", ...P(-184, 536) },
    { id: "fs_g", dish: "Galette de sarrasin", best_place: "B", ...P(1816, -3464) },
  ] });
  const { fuzzy } = dedupeReservoir(r);
  assert.equal(fuzzy.filter((f) => f.kind === "dish").length, 0);
});

t("the dish roster carries every survivor for the whole-set question", () => {
  // Same food, no shared word — no cheap signal exists, so the roster is how
  // the caller's single model call gets a shot at it.
  const r = res({ food_specialties: [
    { id: "fs_g", dish: "Galette de sarrasin", best_place: "A", ...P(-184, 536) },
    { id: "fs_s", dish: "Crêpe salée", best_place: "B", ...P(1816, -3464) },
  ] });
  const { fuzzy, dish_roster } = dedupeReservoir(r);
  assert.equal(fuzzy.filter((f) => f.kind === "dish").length, 0, "no shared token to key on");
  assert.deepEqual(dish_roster.map((d) => d.id).sort(), ["fs_g", "fs_s"]);
});

t("applyVerdicts merges only the pairs marked same", () => {
  const r = res({ food_specialties: [
    { id: "fs_g", dish: "Galette de sarrasin", best_place: "A", rating: 4.1, ...P(-184, 536) },
    { id: "fs_c", dish: "Galette complète", best_place: "B", rating: 4.8, ...P(1816, -3464) },
  ] });
  dedupeReservoir(r);
  const out = applyVerdicts(r, [{ a: "fs_g", b: "fs_c", same: true, reason: "same dish, different wording" }]);
  assert.equal(out.merged, 1);
  assert.equal(live(r, "food_specialties").length, 1);
  assert.equal(live(r, "food_specialties")[0].id, "fs_c");
});

t("applyVerdicts with same:false changes nothing", () => {
  const r = res({ food_specialties: [
    { id: "fs_g", dish: "Galette de sarrasin", best_place: "A", ...P(-184, 536) },
    { id: "fs_c", dish: "Galette complète", best_place: "B", ...P(1816, -3464) },
  ] });
  dedupeReservoir(r);
  applyVerdicts(r, [{ a: "fs_g", b: "fs_c", same: false }]);
  assert.equal(live(r, "food_specialties").length, 2);
});

t("re-running is idempotent and does not cascade", () => {
  const r = res({
    must_see: [{ id: "ms_x", name: "Château", mapsUri: "cid=1", ...P(-184, 536) }],
    optional: [
      { id: "op_x", name: "Chateau", mapsUri: "cid=1", ...P(-184, 536) },
      { id: "op_y", name: "Jardin des Plantes", mapsUri: "cid=2", ...P(16, 136) },
    ],
  });
  const a = dedupeReservoir(r);
  const b = dedupeReservoir(r);
  assert.deepEqual(a.stats, b.stats, "second run reaches the same state");
  assert.equal(live(r, "optional").length, 1);
});

t("a human done mark survives dedup", () => {
  const r = res({ must_see: [
    { id: "ms_k", name: "Machines de l'île", mapsUri: "cid=7", ...P(-184, -64), state: "done", done_source: "manual" },
  ] });
  dedupeReservoir(r);
  assert.equal(r.buckets.must_see[0].state, "done", "dedup must not clear a real visit");
});

console.log(`\n${pass} passed`);
