// Regression tests for the location-ask queue — the chokepoint that stopped
// "did you stop somewhere?" questions from bypassing hum's ranker (2026-08-04).
//
// The behaviours locked in here are the ones whose absence produced the
// measured failure: 46 asks in seven days, a stop asked about twice in an hour
// with the answer sitting in chat in between, and a 40-hour-old question
// silently absorbing a fresh reply.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the lib at a scratch file before importing it — QUEUE_PATH is resolved
// at module load, so the env has to be right first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ask-queue-test-"));
process.env.HOME = scratch;
fs.mkdirSync(path.join(scratch, "Dev/jori/data"), { recursive: true });

const q = await import("../lib/location-ask-queue.mjs");

function reset() {
  try { fs.unlinkSync(q.QUEUE_PATH); } catch {}
}

test("a queued ask round-trips and is visible to the harvester", () => {
  reset();
  q.add({ visit_id: "v1", message: "38m near Rue de Choiseul — did you stop?", score_hint: 0.55 });
  const head = q.peek();
  assert.equal(head.visit_id, "v1");
  assert.equal(head.score_hint, 0.55);
});

test("re-composing the same visit REPLACES rather than queueing a second question", () => {
  // This is the Les Turbines case: the enrich job re-composes the same stop on
  // its next 15-min run. Two entries for one stop is two interrupts about one
  // moment, which is exactly what happened on 2026-08-04 at 12:30 and 13:16.
  reset();
  q.add({ visit_id: "v1", message: "first phrasing" });
  q.add({ visit_id: "v1", message: "second phrasing" });
  assert.equal(q.list().length, 1);
  assert.equal(q.peek().message, "second phrasing");
});

test("the freshest ask is offered first, not the oldest", () => {
  // FIFO is what let a stale question absorb a fresh reply (2026-07-31). The
  // most answerable question is the most recent one.
  reset();
  q.add({ visit_id: "old", message: "old stop" });
  const state = JSON.parse(fs.readFileSync(q.QUEUE_PATH, "utf8"));
  state.queue[0].composed_at = new Date(Date.now() - 3 * 3600_000).toISOString();
  fs.writeFileSync(q.QUEUE_PATH, JSON.stringify(state));
  q.add({ visit_id: "new", message: "new stop" });
  assert.equal(q.peek().visit_id, "new");
});

test("entries past the 12h horizon are dropped, not merely deprioritised", () => {
  // The user will not remember yesterday's stop, and an unanswerable question is pure
  // interruption. Expiry has to remove it from reach, not sort it last.
  reset();
  q.add({ visit_id: "stale", message: "stale stop" });
  const state = JSON.parse(fs.readFileSync(q.QUEUE_PATH, "utf8"));
  state.queue[0].composed_at = new Date(Date.now() - (q.MAX_AGE_H + 1) * 3600_000).toISOString();
  fs.writeFileSync(q.QUEUE_PATH, JSON.stringify(state));
  assert.equal(q.peek(), null);
  assert.equal(q.list().length, 0);
});

test("an entry with an unparseable composed_at is dropped rather than treated as fresh", () => {
  reset();
  fs.writeFileSync(q.QUEUE_PATH, JSON.stringify({
    queue: [{ visit_id: "bad", message: "x", composed_at: "not-a-date" }],
  }));
  assert.equal(q.peek(), null);
});

test("drop removes exactly one visit and leaves the rest askable", () => {
  reset();
  q.add({ visit_id: "a", message: "a" });
  q.add({ visit_id: "b", message: "b" });
  assert.equal(q.drop("a"), 1);
  assert.deepEqual(q.list().map((e) => e.visit_id), ["b"]);
});

test("add refuses an entry with no message — an empty ask must never reach the ranker", () => {
  reset();
  assert.throws(() => q.add({ visit_id: "v", message: "   " }));
  assert.throws(() => q.add({ message: "orphan with no visit" }));
});

test("a missing or corrupt queue file reads as empty rather than throwing", () => {
  // The harvester calls peek() on every tick. A malformed file must degrade to
  // "no ask this tick", never take the lane down.
  reset();
  assert.equal(q.peek(), null);
  fs.writeFileSync(q.QUEUE_PATH, "{ not json");
  assert.equal(q.peek(), null);
  assert.deepEqual(q.list(), []);
});
