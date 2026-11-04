// day-statements-companions.test.mjs — the model is told companions are people.
// 2026-10-23: "My cousins and their kids were also there" came back as the
// companion "cousins and their kids", printed in the dinner's header beside the
// cousins the user's correction had named, as if they were more people.
//
// Run: node --test tests/day-statements-companions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const D = require(path.join(ROOT, "bin/day-statements"));

test("the schema asks for people by name", () => {
  assert.ok(D.SCHEMA.includes('"companions": ["<a person, by the name the user uses: Sam, Dana>"'), D.SCHEMA);
});

test("the prompt keeps an unnamed group out of companions and puts it in activity", () => {
  const p = D.prompt("2026-10-23", "Asia/Jerusalem", "(chat)", "(windows)");
  assert.ok(p.includes("Companions are people, one per entry, by the name the user uses for each."), p);
  assert.ok(p.includes("is not a name: never put it in companions, say it in activity instead"), p);
  assert.ok(p.includes("(chat)") && p.includes("(windows)"));
});

// ---------------------------------------------------------------------------
// A stop the user named for an errand done there stays a stop.
// ---------------------------------------------------------------------------
//
// resolve-day applyStatementLabels turns a label that names an activity and no
// place (venue: null) into movement, which is right for "Evening walk with the
// dog" and wrong for an errand: a ten-minute stop the user named for the errand
// done there was flagged is_movement, so the reviewer read its heading as a stop
// that names no place and reported the user's own answer as missing. Whether the
// activity moved is this model's reading (moving), never a pattern; a reading
// without it keeps the old rule. Synthetic stops, no network.

const { _internal: { applyStatementLabels } } = require(path.join(ROOT, "lib/resolve-day.js"));
const { SCHEMA, prompt } = D;
const stop = (name) => ({ id: "s-1", place: { name, source: "user_confirmed", confidence: 1 }, pace_kmh: 0 });
const label = (stored, extra = {}) => ({ labels: [{ stored, venue: null, activity: stored.toLowerCase(), ...extra }] });

test("an errand done in one spot stays a stop under the user's words", () => {
  const s = stop("Dropping off the keys");
  const applied = applyStatementLabels([s], label("Dropping off the keys", { moving: false }));
  assert.equal(s.is_movement, undefined);
  assert.equal(s.activity_stop, true);
  assert.equal(s.place.name, "Dropping off the keys");
  assert.deepEqual(applied, [{ from: "Dropping off the keys", to: "(activity at a stop)" }]);
});

test("a walk is movement, whatever the trace's pace read", () => {
  const s = stop("Strolling the old market");
  applyStatementLabels([s], label("Strolling the old market", { moving: true }));
  assert.equal(s.is_movement, true);
  assert.equal(s.movement_reason, "you named an activity, not a place");
  assert.equal(s.activity_stop, undefined);
});

test("a reading with no moving answer, or an unsure one, keeps the old rule", () => {
  for (const extra of [{}, { moving: null }, { moving: "false" }]) {
    const s = stop("Evening walk with the dog");
    applyStatementLabels([s], label("Evening walk with the dog", extra));
    assert.equal(s.is_movement, true, JSON.stringify(extra));
  }
});

test("a label that names a venue still renames the stop", () => {
  const s = stop("Lunch at Cafe Example");
  applyStatementLabels([s], { labels: [{ stored: "Lunch at Cafe Example", venue: "Cafe Example", activity: "lunch", moving: false }] });
  assert.equal(s.place.name, "Cafe Example");
  assert.equal(s.is_movement, undefined);
});

test("the statement reader is asked whether each label's activity moved", () => {
  assert.match(SCHEMA, /"moving": true\|false\|null/);
  assert.match(prompt("2099-01-01", "UTC", "", ""), /"moving" is true/);
});
