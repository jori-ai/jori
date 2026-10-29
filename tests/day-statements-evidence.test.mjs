// day-statements-evidence.test.mjs — the provenance check on day-statements'
// quotes accepts the user's words when they came from more than one message.
//
// 2026-10-15, Old Port: the user wrote "I was at Café Example most of this morning..." and,
// sixteen seconds later, "I was working there from before 9:30 until around
// 12:30pm". The model quoted both as one evidence string joined with " / ", which
// is no contiguous span of the chat, so validate rejected every tier and the
// day was built with none of the user's words. Each piece must still be the user's.
//
// Run: node --test tests/day-statements-evidence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { validate, evidencePieces } = require(path.join(ROOT, "bin/day-statements"));

const CHAT = [
  "[15/10, 18:34] USER: Why Al-Kalha? We had lunch at Guetta… then on the way back stopped to buy Rover dog food at https://maps.app.goo.gl/cxMDjtDcEQQmidN49.",
  "[15/10, 18:44] USER: I was at Café Example most of this morning...",
  "[15/10, 18:44] USER: I was working there from before 9:30 until around 12:30pm",
  "[15/10, 18:45] USER: after 2:26p I was at the airbnb. still here but will leave to pick nana soon",
].join("\n");

const day = (places) => ({ places, all_stops_declared: { value: false, evidence: null } });
const place = (name, evidence) => ({ name, venue: name, evidence });

test("a quote stitched from two of his messages with ' / ' passes", () => {
  const ev = "I was at Café Example most of this morning... / I was working there from before 9:30 until around 12:30pm";
  assert.equal(validate(day([place("Café Example", ev)]), CHAT), null);
});

test("the stitch the model used on 2026-10-15, with the accent dropped, passes", () => {
  const ev = "I was at Cafe Example most of this morning... / I was working there from before 9:30";
  assert.equal(validate(day([place("Café Example", ev)]), CHAT), null);
});

test("pieces joined by an ellipsis character pass", () => {
  const ev = "I was at Café Example most of this morning… I was working there from before 9:30";
  assert.equal(validate(day([place("Café Example", ev)]), CHAT), null);
});

test("a single contiguous quote still passes, curly or straight", () => {
  assert.equal(validate(day([place("Guetta", "We had lunch at Guetta...")]), CHAT), null);
  assert.equal(validate(day([place("Guetta", "We had lunch at Guetta…")]), CHAT), null);
});

test("a stitched quote with one invented piece is still rejected", () => {
  const ev = "I was at Café Example most of this morning... / then we had dinner at Dr Shakshuka";
  assert.ok(String(validate(day([place("Dr Shakshuka", ev)]), CHAT)).startsWith("evidence for \"Dr Shakshuka\" is not in"));
});

test("a short invented piece is rejected too, whatever joins it", () => {
  for (const ev of ["We had lunch at Guetta / Puaa", "We had lunch at Guetta... then Puaa",
                    "We had lunch at Guetta / Dr Shakshuka", "We had lunch at Guetta\u2026 Puaa"]) {
    assert.ok(String(validate(day([place("Puaa", ev)]), CHAT)).startsWith("evidence for \"Puaa\" is not in"), ev);
  }
});

test("an invented single quote is still rejected", () => {
  assert.ok(String(validate(day([place("Puaa", "we had coffee at Puaa in the flea market")]), CHAT)).startsWith("evidence for \"Puaa\" is not in"));
});

test("evidencePieces splits only on the joins, keeping each piece whole", () => {
  assert.deepEqual(evidencePieces("a b c / d e f… g h\ni j"), ["a b c", "d e f", "g h", "i j"]);
  assert.deepEqual(evidencePieces("one piece"), ["one piece"]);
});
