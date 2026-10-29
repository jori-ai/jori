// daily-summary-confirm.test.mjs — the CONFIRMED-FACT backbone for the daily
// summary. Anchored on the 2026-06-27 failures the reframe was built to fix:
//   - a volunteered venue reaches the day as an ADVISORY candidate, bound to
//     the right stop (the regex miner that used to do this was retired per
//     Rule #0b — a model now reads chat into /tmp/day-statements-<date>.json)
//   - a 2-sample osm guess with equidistant alternatives must be WEAK_GUESS
//   - a chat / in-person-card signal must promote a stop to CONFIRMED
//   - an MTA tap must be recovered as mobility, not dropped
// Run: node --test tests/daily-summary-confirm.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { computeProvenance, applyProvenance } = require(
  "../lib/daily-summary-confirm.js",
);
const { matchTransactions, selectMobility } = require(
  "../lib/daily-summary-transactions.js",
);

// A Chinatown lunch stop the resolver only GUESSED (osm, 2 samples, 2 near
// alternatives) — exactly the 2026-06-27 "Nom Wah / Barrio Chino" shape.
const guessLunch = {
  id: "s4", start: "13:15", end: "14:33",
  start_ts_ms: Date.parse("2026-06-27T17:15:00Z"),
  end_ts_ms: Date.parse("2026-06-27T18:33:00Z"),
  pattern: "dwell", sample_count: 2,
  place: { name: "Nom Wah Tea Parlor", source: "osm_overpass", distance_m: 59 },
  alternatives: [
    { name: "Ajisen Ramen", distance_km: 0.04 },
    { name: "Tasty Hand-Pulled Noodles", distance_km: 0.044 },
  ],
};
const home = {
  id: "s5", start: "15:07", end: "18:53",
  start_ts_ms: Date.parse("2026-06-27T19:07:00Z"),
  end_ts_ms: Date.parse("2026-06-27T22:53:00Z"),
  pattern: "dwell", sample_count: 11,
  place: { name: "Home (Eastside)", source: "named_location" },
  alternatives: [],
};

// The regex miner (`mineChatVenues` + `VENUE_PATTERNS`) was DELETED per Rule
// #0b — five grammar patterns over the user's chat that bound a property value
// ("Villa Example is 1.6") and a restaurant recommendation onto real stops.
// A model now writes /tmp/day-statements-<date>.json and `readStatementVenues`
// maps it. These tests follow the capability to its replacement rather than
// asserting the old mechanism still exists.
const STATEMENTS_DIR = fs.mkdtempSync(`${process.env.TMPDIR || "/tmp"}/day-statements-test-`);
process.env.DAY_STATEMENTS_DIR = STATEMENTS_DIR;
const STATEMENTS_FILE = `${STATEMENTS_DIR}/day-statements-2026-06-27.json`;
function withStatements(doc, fn) {
  fs.writeFileSync(STATEMENTS_FILE, JSON.stringify(doc));
  try { return fn(); } finally { try { fs.unlinkSync(STATEMENTS_FILE); } catch {} }
}

test("a volunteered venue binds to the bindable stop, not to home", () => {
  withStatements({
    places: [{
      name: "Ping's", sentiment: "negative", when_hint: "earlier",
      said_at_iso: "2026-06-27T21:35:00Z", evidence: "We went to ping's. It's very disappointing.",
    }],
  }, () => {
    const stops = [structuredClone(guessLunch), structuredClone(home)];
    const r = applyProvenance(stops, { messages: [], transactions: [], date: "2026-06-27" });
    assert.equal(r.chatCandidates.length, 1);
    assert.equal(r.chatCandidates[0].name, "Ping's");
    assert.equal(r.chatCandidates[0].sentiment, "negative");
    assert.equal(r.chatCandidates[0].stop_id, "s4"); // the lunch stop, not home
  });
});

test("NO REGEX FALLBACK: without the model's reading there are zero candidates", () => {
  // The guarantee Rule #0b buys. If the model has not run for a day, chat
  // produces nothing — it must never quietly fall back to grammar matching.
  try { fs.unlinkSync(STATEMENTS_FILE); } catch {}
  const stops = [structuredClone(guessLunch)];
  const r = applyProvenance(stops, {
    messages: [{ role: "user", content: "We went to ping's. It's very disappointing.", created_at: "2026-06-27T21:35:00Z" }],
    transactions: [], date: "2026-06-27",
  });
  assert.equal(r.chatCandidates.length, 0);
});

test("a thin osm guess with equidistant alternatives is WEAK_GUESS + hedge", () => {
  const p = computeProvenance(guessLunch, {});
  assert.equal(p.tier, "WEAK_GUESS");
  assert.equal(p.hedge, true);
  assert.deepEqual(p.alternatives, ["Ajisen Ramen", "Tasty Hand-Pulled Noodles"]);
});

test("an AGENT-VETTED name promotes a guessed stop to CONFIRMED with sentiment", () => {
  const p = computeProvenance(guessLunch, { confirmedName: "Ping's", sentiment: "negative" });
  assert.equal(p.tier, "CONFIRMED");
  assert.equal(p.hedge, false);
  assert.equal(p.confirmed_name, "Ping's");
  assert.equal(p.display_name, "Ping's");
  assert.equal(p.sentiment, "negative");
});

test("a named_location (home) is CONFIRMED without any external signal", () => {
  assert.equal(computeProvenance(home, {}).tier, "CONFIRMED");
});

test("an in-person card merchant corroborates/names a guessed stop", () => {
  const p = computeProvenance(guessLunch, { txnVenue: { merchant: "Ping's Seafood" } });
  assert.equal(p.tier, "CONFIRMED");
  assert.equal(p.confirmed_name, "Ping's Seafood");
});

test("a raw mined chat candidate does NOT auto-confirm (ambiguity guard)", () => {
  // "Villa Example is 1.6" / "balaboosta is a great rec" must not silently
  // rename a stop — only the agent's vetted `confirmed` map (or a txn) confirms.
  withStatements({
    places: [{ name: "Villa Example", when_hint: "earlier", said_at_iso: "2026-06-27T17:30:00Z",
               evidence: "Villa Example is probably closer to 1.6 now." }],
  }, () => {
    const stops = [structuredClone(guessLunch)];
    const r = applyProvenance(stops, { messages: [], transactions: [], date: "2026-06-27" });
    assert.equal(stops[0].provenance.tier, "WEAK_GUESS"); // stayed a guess
    assert.ok(r.chatCandidates.length >= 1);              // but surfaced as advisory
  });
});

test("selectMobility recovers an MTA subway tap that selectStandouts drops", () => {
  const mta = { amount: 3, merchant_name: "MTA", category_primary: "TRANSPORTATION", payment_channel: "in store", pending: true };
  const m = selectMobility([mta]);
  assert.equal(m.length, 1);
  assert.equal(m[0].mode, "subway");
});

test("applyProvenance: agent-confirmed venue + mobility in one pass, sentiment carried", () => {
  // Sentiment now rides on the model's reading, not on a grammar match over
  // the raw message — so the candidate must come from day-statements.
  withStatements({
    places: [{ name: "Ping's", sentiment: "negative", when_hint: "earlier",
               said_at_iso: "2026-06-27T18:00:00Z", evidence: "We went to ping's. very disappointing." }],
  }, () => {
    const stops = [structuredClone(guessLunch), structuredClone(home)];
    const transactions = [{ amount: 3, merchant_name: "MTA", category_primary: "TRANSPORTATION", payment_channel: "in store" }];
    // Agent vetted the candidate and bound Ping's to s4 (the geographically-correct stop).
    const r = applyProvenance(stops, { messages: [], transactions, confirmed: { s4: "Ping's" }, date: "2026-06-27" });
    assert.equal(stops[0].provenance.tier, "CONFIRMED");
    assert.equal(stops[0].provenance.confirmed_name, "Ping's");
    assert.equal(stops[0].provenance.sentiment, "negative"); // carried from the matching candidate
    assert.equal(stops[1].provenance.tier, "CONFIRMED");      // home
    assert.equal(r.mobility[0].mode, "subway");
  });
});

test("a walk block takes the name he gave it over the one its geometry gave", () => {
  // 2026-10-18: "Walk along the beach", from the user's "took rover for a long walk along the
  // beach", never reached a header titled "Walk to לב תל-אביב".
  const walk = { id: "s-loop", place: { name: "Walk to לב תל-אביב", source: "excursion" },
                 excursion: { away_m: 651, mode: "walking" } };
  const told = computeProvenance(walk, { confirmedName: "Walk along the beach" });
  assert.equal(told.title, "Walk along the beach");
  assert.equal(told.certainty, "answered");
  assert.equal(told.title_kind, "movement");
  assert.equal(told.excursion, true);
  const untold = computeProvenance(walk, {});
  assert.equal(untold.title, "Walk to לב תל-אביב");
  assert.equal(untold.certainty, "known");
});
