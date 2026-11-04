// reservoir-done — matching + marking invariants.
// Run: node tests/reservoir-done.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { matchEntry, markReservoir, haversineM } = require("../lib/reservoir-done.js");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

// A fictional base (placeholder coordinates); P(dLat, dLon) offsets it in units
// of 0.0001 degree, so relative distances are what the assertions test.
const BASE = { lat: 45.6789, lon: -1.2345 };
const P = (dLat, dLon) => ({ lat: +(BASE.lat + dLat / 1e4).toFixed(6), lon: +(BASE.lon + dLon / 1e4).toFixed(6) });
const G = (dLat, dLon) => { const p = P(dLat, dLon); return { latitude: p.lat, longitude: p.lon }; };

// An attraction near the fictional base.
const MACHINES = { name: "Les Machines de l'île — Le Grand Éléphant", ...P(-119, -114) };
const FAR = { name: "Cathédrale Notre-Dame d'Ailleurs", lat: 34.5678, lon: 23.4567 };
const EMPTY = { summaryText: "", summaryStops: [], gpsVisits: [], gpsTransit: [] };

t("haversine is metres, not km", () => {
  // ~1 degree of latitude is ~111km
  assert.ok(Math.abs(haversineM(0, 0, 1, 0) - 111195) < 500);
});

t("no evidence -> no match", () => {
  assert.equal(matchEntry(MACHINES, EMPTY), null);
});

t("a place named in the vetted summary is done even with no stop", () => {
  // The "we went to the sub base" case: a real visit that never became a stop.
  const hit = matchEntry({ name: "Saint-Nazaire submarine base", ...P(516, -6464) },
    { ...EMPTY, summaryText: "we drove out to the saint nazaire submarine base and walked around" });
  assert.equal(hit.via, "summary-name");
});

t("a nearby resolved stop marks done", () => {
  const hit = matchEntry(MACHINES, { ...EMPTY,
    summaryStops: [{ name: "Carrousel des Mondes Marins", ...P(-122, -144), date: "2026-07-13" }] });
  assert.equal(hit.via, "summary-stop");
  assert.equal(hit.date, "2026-07-13");
});

t("a stop on another continent does NOT mark done", () => {
  // The safety property behind skipping a trip-start date: physical distance is
  // the gate, so days spent elsewhere can never strike a French entry.
  const hit = matchEntry(MACHINES, { ...EMPTY,
    summaryStops: [{ name: "Home", lat: 45.6789, lon: -123.4567, date: "2026-06-01" }] });
  assert.equal(hit, null);
});

t("evidence precedence: summary beats GPS transit", () => {
  const hit = matchEntry(MACHINES, {
    ...EMPTY,
    summaryStops: [{ name: "Galerie des Machines", ...P(-119, -115), date: "2026-07-13" }],
    gpsTransit: [{ ...G(-119, -116), arrived_at: "2026-07-13T10:00:00Z" }],
  });
  assert.equal(hit.via, "summary-stop");
});

t("transit alone still marks done (loose by request)", () => {
  const hit = matchEntry(MACHINES, { ...EMPTY,
    gpsTransit: [{ ...G(-118, -115), arrived_at: "2026-07-13T10:00:00Z" }] });
  assert.equal(hit.via, "gps-transit");
});

t("markReservoir sets state=done + provenance, not a parallel flag", () => {
  const r = { buckets: { must_see: [{ ...MACHINES, state: "open" }] } };
  const { marked } = markReservoir(r, { ...EMPTY,
    summaryStops: [{ name: "Grand Éléphant", ...P(-119, -115), date: "2026-07-13" }] });
  assert.equal(marked.length, 1);
  const e = r.buckets.must_see[0];
  assert.equal(e.state, "done");           // the field the reservoir build carries forward
  assert.equal(e.done, undefined);         // legacy boolean must not linger
  assert.equal(e.done_source, "summary-stop");
  assert.ok(e.done_evidence && e.done_at);
});

t("never removes an entry, and a skipped entry is left alone", () => {
  const r = { buckets: { must_see: [
    { ...MACHINES, state: "skipped", skip_reason: "not interested" },
    { ...FAR, state: "open" },
  ] } };
  const ev = { ...EMPTY, summaryStops: [{ name: "x", ...P(-119, -115), date: "2026-07-13" }] };
  const { marked, already } = markReservoir(r, ev);
  assert.equal(r.buckets.must_see.length, 2);          // nothing dropped
  assert.equal(r.buckets.must_see[0].state, "skipped"); // the user's own call preserved
  assert.equal(already, 1);
  assert.equal(marked.length, 0);                       // FAR is 400km away
});

t("a manual un-mark is NOT re-struck by the sweep", () => {
  // The real trap: the user un-marks a false positive on the site (state back to
  // "open", manual:true). Tonight's sweep still has matching evidence — it must
  // leave that call alone, or the unmark silently reverts and the button looks
  // broken.
  const r = { buckets: { must_see: [
    { ...MACHINES, state: "open", manual: true },
  ] } };
  const ev = { ...EMPTY, summaryStops: [{ name: "Grand Éléphant", ...P(-119, -115), date: "2026-07-13" }] };
  const { marked, already } = markReservoir(r, ev);
  assert.equal(marked.length, 0);
  assert.equal(already, 1);
  assert.equal(r.buckets.must_see[0].state, "open"); // stays as the user left it
});

t("re-running is idempotent", () => {
  const r = { buckets: { must_see: [{ ...MACHINES, state: "open" }] } };
  const ev = { ...EMPTY, summaryStops: [{ name: "x", ...P(-119, -115), date: "2026-07-13" }] };
  const first = markReservoir(r, ev);
  const second = markReservoir(r, ev);
  assert.equal(first.marked.length, 1);
  assert.equal(second.marked.length, 0);
  assert.equal(second.already, 1);
});

console.log(`\n${pass}/${pass} passed`);
