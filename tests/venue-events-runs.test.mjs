// venue-events-runs.test.mjs — keys for titles in non-Latin scripts, and
// theater runs collapsing to one candidate (lib/venue-events/normalize.mjs,
// lanes.mjs, watch.mjs). A feed with Hebrew titles must not collapse every
// show at a venue into one key, and a play's nightly performances reach the model as one row that still says how many dates it has.
// Synthetic venues and titles throughout.
//
// Run: node --test tests/venue-events-runs.test.mjs

import { LOCAL_DIR, writeLocalConfig } from "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

writeLocalConfig("venue-events", { home_metro: "metro_a", metros: ["metro_a", "metro_b"], near_zone: "near" });
void LOCAL_DIR;
const { slug, eventKey } = await import("../lib/venue-events/normalize.mjs");
const { collapseRuns } = await import("../lib/venue-events/lanes.mjs");
const { candidateRows } = await import("../lib/venue-events/watch.mjs");

test("non-Latin titles keep distinct keys; Latin slugs are unchanged", () => {
  assert.equal(slug("Blue Note & Friends — Live!"), "blue-note-and-friends-live");
  // Hebrew letters are kept in the key (the script the slug supports besides Latin).
  const a = eventKey({ venue: "מועדון הים", date: "2026-10-15", title: "להקת הגל" });
  const b = eventKey({ venue: "מועדון הים", date: "2026-10-15", title: "זמרת החוף" });
  assert.notEqual(a, b);
  assert.ok(!a.startsWith("|"), "the title part is not empty");
});

test("theater runs collapse to the next performance, keyed by the run; other rows pass", () => {
  const perf = (date) => ({ key: `x|${date}`, title: "The Seagull", venue: "Teatro da Ribeira", date, category: "theater" });
  const gig = { key: "g", title: "Harbour Quartet", venue: "Cais Club", date: "2026-10-20", category: "music" };
  const out = collapseRuns([perf("2026-10-12"), perf("2026-10-09"), perf("2026-10-10"), gig]);
  assert.equal(out.length, 2);
  const run = out.find((e) => e.category === "theater");
  assert.equal(run.date, "2026-10-09");
  assert.equal(run.run_dates, 3);
  assert.ok(run.key.startsWith("run:"));
  assert.ok(out.some((e) => e.key === "g"));
  assert.equal(candidateRows([run])[0].run_dates, 3, "the model sees the run length");
});
