// resolve-day-self-messages.test.mjs — resolve-day's `corrections` and
// `declarative_self_messages` come from day-statements' model reading
// (`self_messages[]`), never from a pattern. No reading = none for the day.
//
// Run: node --test tests/resolve-day-self-messages.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { selfMessageSignals, readDayStatements } = _internal;

const STATEMENTS = {
  places: [], all_stops_declared: { value: false, evidence: null },
  self_messages: [
    { at: "2026-04-16 20:46:00", text: "that's the dog's wash - the time stamps are wrong", kind: "correction", quote: "the time stamps are wrong" },
    { at: "2026-04-16 13:10:00", text: "Had lunch with Dana at Cafe Example", kind: "declarative", quote: "Had lunch with Dana at Cafe Example" },
    { at: "2026-04-16 09:02:00", text: "ok", kind: "chatter", quote: null },
  ],
};

test("the model's kinds become the two lists, in the shape the readers expect", () => {
  const r = selfMessageSignals(STATEMENTS);
  assert.equal(r.total, 3);
  assert.deepEqual(r.corrections, [{ at: "2026-04-16 20:46:00", channel: "imsg_self",
    text: "that's the dog's wash - the time stamps are wrong", quote: "the time stamps are wrong",
    markers: [], reason: "day-statements" }]);
  assert.equal(r.declarative.length, 1);
  assert.equal(r.declarative[0].text, "Had lunch with Dana at Cafe Example");
});

test("no day-statements reading, or one without self_messages: no corrections, no facts", () => {
  for (const s of [null, undefined, { places: [] }, { self_messages: "x" }]) {
    const r = selfMessageSignals(s);
    assert.deepEqual(r.corrections, []);
    assert.deepEqual(r.declarative, []);
    assert.equal(r.total, null);
  }
});

test("a message only a pattern would call a correction stays out without a reading", () => {
  // The words the retired regex matched; chatter by the model's reading.
  const r = selfMessageSignals({ self_messages: [{ at: null, text: "correction: wrong date", kind: "chatter", quote: null }] });
  assert.deepEqual(r.corrections, []);
});

test("resolve-day reads self_messages from the day-statements file", () => {
  const date = "1999-01-03";
  const f = `/tmp/day-statements-${date}.json`;
  fs.writeFileSync(f, JSON.stringify(STATEMENTS));
  try {
    assert.equal(selfMessageSignals(readDayStatements(date)).corrections.length, 1);
  } finally { fs.unlinkSync(f); }
  assert.equal(readDayStatements(date), null);
  assert.deepEqual(selfMessageSignals(readDayStatements(date)).corrections, []);
});

test("the regex classifier is no longer imported", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/resolve-day.js"), "utf8");
  assert.ok(!src.includes('require(path.join(__dirname, "message-classifier.js"))'));
  assert.ok(!src.includes("classifyAll("));
});
