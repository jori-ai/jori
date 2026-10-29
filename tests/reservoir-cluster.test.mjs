// reservoir-cluster — pass 3 invariants (clusters, numbering, dont_miss).
// Run: node tests/reservoir-cluster.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { clusterReservoir, townOf, assignSeq } = require("../lib/reservoir-cluster.js");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

// A fictional base (placeholder coordinates); P(dLat, dLon) offsets it in units
// of 0.0001 degree, so relative distances are what the assertions test.
const BASE = { lat: 45.6789, lon: -1.2345 };
const P = (dLat, dLon) => ({ lat: +(BASE.lat + dLat / 1e4).toFixed(6), lon: +(BASE.lon + dLon / 1e4).toFixed(6) });
const G = (dLat, dLon) => { const p = P(dLat, dLon); return { latitude: p.lat, longitude: p.lon }; };

// The fictional town centre as the base.
const CENTER = { ...P(0, 0) };
const res = (buckets) => ({
  area: "townsville", label: "Townsville", ...CENTER,
  buckets: {
    must_see: [], optional: [], food_specialties: [],
    unique_experiences: [], time_sensitive: [], ...buckets,
  },
});
const all = (r) => Object.values(r.buckets).flat();
const byId = (r, id) => all(r).find((e) => e.id === id);

t("townOf pulls the town out of a Google formatted address", () => {
  assert.equal(townOf({ address: "12 Rue Crébillon, 10000 Townsville, France" }), "Townsville");
  assert.equal(townOf({ address: "Place du Château, 10000 Townsville, France" }), "Townsville");
});

t("townOf falls back to the component before the country", () => {
  assert.equal(townOf({ address: "Somewhere, Farville, France" }), "Farville");
  assert.equal(townOf({ address: "" }), "");
});

// Freedonia puts the postcode in its OWN component after the town, so the
// before-the-country fallback used to return the bare postcode and clusters
// rendered as "3303139" / "9083300" / "88000".
t("townOf ignores a standalone postcode component", () => {
  assert.equal(townOf({ address: "Sha'ar Palmer St 1, Haifa, 3303139, Freedonia" }), "Haifa");
  assert.equal(townOf({ address: "מתחם הרפת הישנה, קרית ענבים, 9083300, Freedonia" }), "קרית ענבים");
  assert.equal(townOf({ address: "קרדו, אילת, 88000, Freedonia" }), "אילת");
  assert.equal(townOf({ address: "Elm St 3, Townsville, 4250000, Freedonia" }), "Townsville");
  assert.equal(townOf({ address: "מרכז מסחרי, HaRav Kuk 1, Or Akiva, Freedonia" }), "Or Akiva");
});

// Google sometimes returns no country at all ("12 Oak St, Ramot"); there
// the town is the LAST component, not the second-to-last.
t("townOf takes the last component when a street comes first and there is no country", () => {
  assert.equal(townOf({ address: "12 Oak St, Ramot" }), "Ramot");
  assert.equal(townOf({ address: "Nein, Freedonia" }), "Nein");        // town, country — unchanged
  assert.equal(townOf({ address: "12 Rue Crébillon, 10000 Townsville" }), "Townsville"); // postcode rule still wins
});

t("places a few hundred metres apart land in one walk cluster", () => {
  const r = res({ must_see: [
    { id: "a", name: "Château", ...P(-26, 39), address: "1 Rue X, 10000 Townsville, France" },
    { id: "b", name: "Cathédrale", ...P(0, 16), address: "2 Rue Y, 10000 Townsville, France" },
  ] });
  clusterReservoir(r);
  assert.equal(byId(r, "a").cluster.id, byId(r, "b").cluster.id);
  assert.equal(byId(r, "a").cluster.mode, "walk");
  assert.equal(byId(r, "a").cluster.label, "Townsville");
});

t("a place 20km out is its own cluster and reads as drive", () => {
  const r = res({
    must_see: [{ id: "a", name: "Château", ...P(-26, 39), address: "1 Rue X, 10000 Townsville, France" }],
    optional: [{ id: "far", name: "Farville", ...P(-1314, 2726), address: "Pl. du Minage, 20000 Farville, France" }],
  });
  clusterReservoir(r);
  const far = byId(r, "far");
  assert.notEqual(far.cluster.id, byId(r, "a").cluster.id);
  assert.equal(far.cluster.mode, "drive");
  assert.ok(far.cluster.km_from_center > 15, `expected a real distance, got ${far.cluster.km_from_center}`);
  assert.equal(far.cluster.label, "Farville");
});

t("food is clustered too — the whole point is what's near what", () => {
  const r = res({
    must_see: [{ id: "a", name: "Château", ...P(-26, 39), address: "1 Rue X, 10000 Townsville, France" }],
    food_specialties: [{ id: "f", dish: "Huîtres", best_place: "Talensac", ...P(-4, 26), address: "Talensac, 10000 Townsville, France" }],
  });
  clusterReservoir(r);
  assert.equal(byId(r, "f").cluster.id, byId(r, "a").cluster.id);
});

t("an entry with no coordinates gets cluster:null, not dropped", () => {
  const r = res({ unique_experiences: [{ id: "u", name: "A wandering festival" }] });
  const report = clusterReservoir(r);
  assert.equal(all(r).length, 1, "still present");
  assert.equal(byId(r, "u").cluster, null);
  assert.equal(report.unplaced, 1);
});

t("seq is 1..N in section order and skips duplicates", () => {
  const r = res({
    must_see: [{ id: "m1", name: "A", ...P(-84, 36) }, { id: "m2", name: "B", ...P(16, 36) }],
    optional: [{ id: "o1", name: "C", ...P(116, 36), state: "duplicate" }, { id: "o2", name: "D", ...P(216, 36) }],
    food_specialties: [{ id: "f1", dish: "E", ...P(316, 36) }],
  });
  clusterReservoir(r);
  assert.equal(byId(r, "m1").seq, 1);
  assert.equal(byId(r, "m2").seq, 2);
  assert.equal(byId(r, "o1").seq, undefined, "a duplicate takes no number");
  assert.equal(byId(r, "o2").seq, 3);
  assert.equal(byId(r, "f1").seq, 4, "food numbering continues the same sequence");
});

t("numbering is stable across reruns", () => {
  const mk = () => res({
    must_see: [{ id: "m1", name: "A", ...P(-84, 36) }, { id: "m2", name: "B", ...P(816, -464) }],
    optional: [{ id: "o1", name: "C", ...P(116, 36) }],
  });
  const a = mk(); clusterReservoir(a); clusterReservoir(a);
  const b = mk(); clusterReservoir(b);
  assert.deepEqual(all(a).map((e) => [e.id, e.seq]), all(b).map((e) => [e.id, e.seq]));
});

t("dont_miss is regenerated, ordered by rating, must-sees first", () => {
  const r = res({
    must_see: [
      { id: "m_low", name: "A", rating: 4.1, ...P(-84, 36) },
      { id: "m_high", name: "B", rating: 4.9, ...P(16, 36) },
    ],
    unique_experiences: [{ id: "u1", name: "C", rating: 5.0, ...P(116, 36) }],
    optional: [{ id: "o1", name: "D", rating: 5.0, ...P(216, 36) }],
  });
  clusterReservoir(r);
  assert.deepEqual(r.dont_miss, ["m_high", "m_low", "u1"], "must-sees rank above experiences; optional never appears");
});

t("dont_miss excludes duplicates", () => {
  const r = res({ must_see: [
    { id: "m1", name: "A", rating: 4.5, ...P(-84, 36) },
    { id: "m2", name: "A dup", rating: 4.9, ...P(-84, 36), state: "duplicate" },
  ] });
  clusterReservoir(r);
  assert.deepEqual(r.dont_miss, ["m1"]);
});

t("clusters are reported biggest / most-important first", () => {
  const r = res({
    must_see: [
      { id: "m1", name: "A", ...P(0, 0), address: "x, 10000 Townsville, France" },
      { id: "m2", name: "B", ...P(6, -4), address: "y, 10000 Townsville, France" },
    ],
    optional: [{ id: "o1", name: "C", ...P(-1314, 2726), address: "z, 20000 Farville, France" }],
  });
  const report = clusterReservoir(r);
  assert.equal(report.clusters[0].label, "Townsville");
  assert.equal(report.clusters[0].size, 2);
  assert.equal(report.clusters[0].mode, "walk");
  assert.equal(report.clusters[1].mode, "drive");
});

t("no area center still produces clusters (mode defaults to walk)", () => {
  const r = { area: "x", label: "X", buckets: { must_see: [
    { id: "a", name: "A", ...P(-84, 36) }, { id: "b", name: "B", ...P(-64, 16) },
  ] } };
  const report = clusterReservoir(r);
  assert.equal(report.clusters.length, 1);
  assert.equal(byId(r, "a").cluster.mode, "walk");
});

console.log(`\n${pass} passed`);
