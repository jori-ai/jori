// resolve-day-default-guess.test.mjs — an unanswered "where was this?" card's
// default reaches the day as "probably X", for its own stop only (2026-10-22).
//
// Mason, choosing among the planner's options: apply the default "as a
// low-confidence guess that never names nearby future stops and that any later
// tap or correction overrides". `choice sweep --apply` → `findme guess` writes
// the card's own visit row as place_type='default-applied'; this file pins how
// far resolve-day lets that row reach (one stop, nothing better-named) and how
// the summary words it.
//
// Run: node --test tests/resolve-day-default-guess.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { at as fakeAt } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };
const require = createRequire(import.meta.url);
const { _internal: { applyDefaultGuesses, DEFAULT_GUESS_CONF } } = require("../lib/resolve-day.js");
const { computeProvenance } = require("../lib/daily-summary-confirm.js");
const { _internal: { stopHeaderHtml, mdTitle } } = require("../lib/daily-summary-render.js");

const T = (hm) => Date.parse(`2026-10-10T${hm}:00Z`);
const stop = (id, from, to, place, extra = {}) => ({
  id, start: from, end: to, start_ts_ms: T(from), end_ts_ms: T(to),
  ...LL(0.0, 0.0), place, ...extra,
});
const row = (id, from, to, name, extra = {}) => ({
  id, arrived_at: new Date(T(from)).toISOString(), departed_at: new Date(T(to)).toISOString(),
  ...LLR(0.0, 0.0), place_name: name, place_type: "default-applied", ...extra,
});

test("the guess names the one stop its row describes, at low confidence", () => {
  const stops = [stop("s1", "04:49", "05:20", { name: null, source: "unknown", confidence: 0 })];
  const applied = applyDefaultGuesses(stops, [row("v1", "04:50", "05:18", "Pella")]);
  assert.equal(applied.length, 1);
  assert.equal(stops[0].place.name, "Pella");
  assert.equal(stops[0].place.source, "default_applied");
  assert.equal(stops[0].place.confidence, DEFAULT_GUESS_CONF);
  assert.ok(DEFAULT_GUESS_CONF < 0.6, "below the unknown_stops bar, so the summary still asks about it");
});

test("never spreads: one row names one stop, never a later stop nearby", () => {
  const stops = [
    stop("s1", "04:49", "05:20", { name: null, source: "unknown" }),
    stop("s2", "05:21", "06:30", { name: null, source: "unknown" }),   // same spot, later
  ];
  applyDefaultGuesses(stops, [row("v1", "04:50", "05:18", "Pella")]);
  assert.equal(stops[0].place.name, "Pella");
  assert.equal(stops[1].place.name, null, "the next stop at the same place stays unnamed");
});

test("a stop the row only grazes is not its stop", () => {
  // 10 of the stop's 70 minutes: well under half of the shorter window.
  const stops = [stop("s1", "05:10", "06:20", { name: null, source: "unknown" })];
  assert.equal(applyDefaultGuesses(stops, [row("v1", "04:00", "05:20", "Pella")]).length, 0);
});

test("a stop too far from the row is not its stop", () => {
  const stops = [stop("s1", "04:49", "05:20", { name: null, source: "unknown" }, { lat: 32.0600 })];
  assert.equal(applyDefaultGuesses(stops, [row("v1", "04:50", "05:18", "Pella")]).length, 0);
});

test("anything better-named keeps its name: his answer, a saved place, a photo sign, lodging, a known place", () => {
  for (const source of ["user_confirmed", "saved_place", "photo_text", "accommodation",
    "known_recurring", "named_location", "calendar_corroborated", "confirmed_stop"]) {
    const stops = [stop("s1", "04:49", "05:20", { name: "Theirs", source, confidence: 0.95 })];
    applyDefaultGuesses(stops, [row("v1", "04:50", "05:18", "Pella")]);
    assert.equal(stops[0].place.name, "Theirs", source);
  }
});

test("a stretch that was movement or a non-stop is never renamed", () => {
  for (const extra of [{ is_movement: true }, { user_non_stop: true }, { excursion: { away_m: 400 } }]) {
    const stops = [stop("s1", "04:49", "05:20", { name: null, source: "unknown" }, extra)];
    assert.equal(applyDefaultGuesses(stops, [row("v1", "04:50", "05:18", "Pella")]).length, 0);
  }
});

test("the title says 'probably X', never asserts it", () => {
  const s = stop("s1", "04:49", "05:20", { name: "Pella", source: "default_applied", confidence: 0.4 });
  const p = computeProvenance(s, {});
  assert.equal(p.probable, true);
  assert.equal(p.certainty, "guess");
  assert.equal(p.title, "Pella");
  assert.deepEqual(p.alternatives, []);
  s.provenance = p;
  assert.equal(mdTitle(s), "probably Pella");
  assert.match(stopHeaderHtml(s, {}), /probably<\/span> <span[^>]*>Pella/);
});

test("his answer outranks the guess at provenance too", () => {
  const s = stop("s1", "04:49", "05:20", { name: "Pella", source: "default_applied", confidence: 0.4 });
  const p = computeProvenance(s, { confirmedName: "Cafe Example" });
  assert.equal(p.title, "Cafe Example");
  assert.equal(p.certainty, "answered");
  assert.ok(!p.probable);
});
