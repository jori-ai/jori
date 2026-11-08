// hum-location-context-fallback.test.mjs — regression test for a
// self-improvement fix: location_context's 3 generic, zero-hypothesis
// fallback questions were removed (arrived-no-place-name, departed-no-
// calendar-match, walk-no-routine-walk/calendar-match). They asked the user to do
// hum's information-gathering for it ("Just stopped somewhere — where are
// you?" / "Where are you off to?" / "Just noticed you walking — where are
// you off to?") and were the majority of the lane's candidate volume with
// zero payoff.
//
// The harvester (agent/scripts/hum-harvesters/location_context.mjs) is
// a top-level script that shells out to `gog calendar`, Supabase REST, and
// `location-track` — it has no exported pure functions to unit-test the way
// calendar.mjs does. So this is a static source check: the three
// content-free question strings must never reappear, and the file must
// still fall through to the pre-existing null-emit convention
// (stampRun(TOPIC, false); emitNull(...)) rather than inventing a new one.
//
// Run: node --test tests/hum-location-context-fallback.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(
  __dirname,
  "../agent/scripts/hum-harvesters/location_context.mjs",
);
const src = readFileSync(SRC_PATH, "utf8");

test("the 3 content-free fallback questions are gone", () => {
  assert.ok(
    !src.includes("Just stopped somewhere"),
    "arrived-no-place-name fallback question should be removed",
  );
  assert.ok(
    !src.includes("Where are you off to?"),
    "departed-no-calendar-match fallback question should be removed",
  );
  assert.ok(
    !src.includes("Just noticed you walking"),
    "walk-no-hypothesis fallback question should be removed",
  );
});

test("named/informed hypotheses are untouched", () => {
  assert.ok(src.includes("Out with ${COMPANION} for a"), "in-progress routine-walk hypothesis should remain");
  assert.ok(src.includes("Taking ${COMPANION} for a"), "just-finished routine-walk hypothesis should remain");
  assert.ok(src.includes("At ${placeGuess}?"), "arrived-with-place-name hypothesis should remain");
  assert.ok(src.includes("Heading to ${summary}?"), "departed-with-calendar-event hypothesis should remain");
  assert.ok(src.includes("${verb} ${summary}?"), "calendar-overlap walk hypothesis should remain");
});

test("removed tiers fall through to the file's existing null-emit convention, not a new one", () => {
  // Every other "nothing to say" exit in this file uses this exact shape.
  const nullEmitOccurrences = (
    src.match(/stampRun\(TOPIC, false\);\s*emitNull\(/g) || []
  ).length;
  // Pre-existing: track-fetch-failed, no-edges-or-walks, no-actionable-signal.
  // Plus the final catch-all that now also absorbs the 3 removed tiers.
  assert.ok(
    nullEmitOccurrences >= 4,
    `expected at least 4 stampRun(false)+emitNull exits, found ${nullEmitOccurrences}`,
  );
  // No new "nothing to say" mechanism (e.g. a bare process.exit or a
  // different emit* helper) was invented for the removed tiers.
  assert.ok(
    !/emitNothing|emitSkip|return null;\s*\/\/ no hypothesis/.test(src),
    "should reuse emitNull, not invent a new no-op mechanism",
  );
});

test("SUPABASE_URL is initialized before the queued-ask branch calls shFetch", () => {
  // 2026-11-08: the const sat below the Step 0 retrospective-ask branch, so every tick with a
  // queued ask threw "Cannot access 'SUPABASE_URL' before initialization" (51 errors in a week).
  // The module runs top to bottom, so a const read by shFetch must precede its first call.
  const declAt = src.indexOf("const SUPABASE_URL");
  const firstCallAt = src.search(/[^n] shFetch\(|=\s*shFetch\(/);
  assert.ok(declAt > -1, "SUPABASE_URL declaration not found");
  assert.ok(firstCallAt > -1, "no shFetch call found");
  assert.ok(declAt < firstCallAt, "SUPABASE_URL must be declared before the first shFetch call");
});
