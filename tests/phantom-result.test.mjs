// Regression test for the resume-handshake phantom `result` that made
// turn-watchdog hang recovery self-defeating.
//
// The fixtures below are verbatim from agent/logs/supervisor-ops/
// events.ndjson — the phantom that ate the system-issue-review
// retry, and the legitimate zero-turn context-guard results it must not be
// confused with. See agent/lib/phantom-result.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT as ROOT } from "../lib/root.cjs";
import { isPhantomResult } from "../agent/lib/phantom-result.mjs";
import { Dispatcher } from "../agent/supervisor/dispatcher.mjs";
import { PriorityDispatcher } from "../agent/lib/priority-dispatcher.mjs";

// The phantom: emitted ~2s after the retry was dispatched into a `--resume`
// child, closing out the turn the watchdog had SIGKILLed.
const PHANTOM = {
  type: "result", subtype: "success", is_error: false,
  duration_ms: 83, duration_api_ms: 0, num_turns: 0, result: "",
  session_id: "00000000-0000-4000-8000-000000000001", total_cost_usd: 0,
};

// Legitimate zero-turn results — context-guard /compacts.
// They report num_turns 0 too, so cost is the only thing separating them.
const REAL_ZERO_TURN = [
  { type: "result", subtype: "success", is_error: false, duration_ms: 61878, duration_api_ms: 0, num_turns: 0, result: "", total_cost_usd: 2.2373155500000004 },
  { type: "result", subtype: "success", is_error: false, duration_ms: 117270, duration_api_ms: 0, num_turns: 0, result: "", total_cost_usd: 0.22917465 },
  { type: "result", subtype: "success", is_error: false, duration_ms: 76573, duration_api_ms: 0, num_turns: 0, result: "", total_cost_usd: 3.801029399999999 },
];

test("isPhantomResult: recognizes the resume-handshake result", () => {
  assert.equal(isPhantomResult(PHANTOM), true);
});

test("isPhantomResult: does not swallow legitimate zero-turn /compact results", () => {
  for (const ev of REAL_ZERO_TURN) {
    assert.equal(isPhantomResult(ev), false, `misclassified $${ev.total_cost_usd} compaction as phantom`);
  }
});

test("isPhantomResult: does not swallow ordinary turns", () => {
  assert.equal(isPhantomResult({ num_turns: 18, total_cost_usd: 5.4917, is_error: false }), false);
});

test("isPhantomResult: lets genuine zero-cost FAILURES through to the normal path", () => {
  // An auth outage / immediate refusal must reach the crash-loop and
  // auth-outage detectors rather than being silently ignored.
  assert.equal(isPhantomResult({ num_turns: 0, total_cost_usd: 0, is_error: true }), false);
});

// --- the actual bug, end to end ------------------------------------------

function fakeSession() {
  const s = new EventEmitter();
  s.sent = [];
  s.send = (c) => s.sent.push(c);
  return s;
}

test("Dispatcher: a phantom does not complete the in-flight item", () => {
  const session = fakeSession();
  const d = new Dispatcher(session);
  d.dispatch("SYSTEM ISSUE REVIEW ...", "system-issue-review");
  assert.ok(d.inFlight, "item should be in flight after dispatch");
  const id = d.inFlight.id;

  let phantoms = 0;
  d.on("phantom_result", () => phantoms++);
  session.emit("result", PHANTOM);

  assert.equal(phantoms, 1, "phantom should be surfaced, not silent");
  assert.ok(d.inFlight, "item must stay in flight — the real turn is still running");
  assert.equal(d.inFlight.id, id);
  assert.equal(d.completed, 0, "a phantom is not a completed turn");

  // ...and the genuine result that lands later completes it normally.
  let completed = 0;
  d.on("turn_complete", () => completed++);
  session.emit("result", { num_turns: 18, total_cost_usd: 5.4917, duration_ms: 280140 });
  assert.equal(completed, 1);
  assert.equal(d.inFlight, null);
  assert.equal(d.completed, 1);
});

test("PriorityDispatcher: a phantom does not complete the in-flight item", () => {
  const session = fakeSession();
  const d = new PriorityDispatcher(session);
  d.dispatch("hey jori", "phone-channel");
  assert.ok(d.inFlight);
  const id = d.inFlight.id;

  let phantoms = 0;
  d.on("phantom_result", () => phantoms++);
  session.emit("result", PHANTOM);

  assert.equal(phantoms, 1);
  assert.ok(d.inFlight, "a dropped chat item is a user message that never gets answered");
  assert.equal(d.inFlight.id, id);
  assert.equal(d.completed, 0);
});

test("Dispatcher: the sessionNotFound requeue guard still wins over the phantom guard", () => {
  // Both match a turns=0/cost=0 result, but they need opposite handling: a
  // dead session must requeue (the child is invalid), a live resume must not
  // (the turn is running). sessionNotFound is checked first.
  const session = fakeSession();
  session.sessionNotFound = true;
  const d = new Dispatcher(session);
  d.dispatch("NIGHTLY REPORT", "cron");

  let requeued = 0, phantoms = 0;
  d.on("requeued", () => requeued++);
  d.on("phantom_result", () => phantoms++);
  session.emit("result", PHANTOM);

  assert.equal(requeued, 1, "invalid session must requeue the item");
  assert.equal(phantoms, 0);
  assert.equal(d.inFlight, null);
  assert.equal(d.queue.length, 1, "item goes back on the queue for the fresh session");
});

// --- cold start: a restored queue must drain ------------------------------
//
// Guards the watchdog's "Supervisor stale: lastEventAge=… queueDepth=N —
// triggering /restart" for the other restart path. A fresh supervisor process
// replays its persisted queue with Dispatcher.restore(), which only reloads it,
// and the one drain kick after setup used to run only for items handed over by
// an in-process restart. A fresh process has none, so a restored queue sat
// idle until some new dispatch arrived (for a quiet tier, an hour or more).
// The supervisor is not booted here (it spawns a claude -p child): the wiring
// is pinned from the live source, the dispatcher half with a fake session.

function queued(id) {
  return { id, source: "webhook", content: `task ${id}`, enqueuedAt: new Date().toISOString() };
}

test("Dispatcher: restore() alone dispatches nothing; the first drain sends the head", () => {
  const session = fakeSession();
  const d = new Dispatcher(session);
  d.restore({ queue: [queued("a1"), queued("b2")], inFlight: null });
  assert.equal(session.sent.length, 0, "restore() must not dispatch: the supervisor kicks the drain once its listeners are attached");
  d._drain();
  assert.equal(session.sent.length, 1);
  assert.equal(d.inFlight.id, "a1");
});

test("Dispatcher: a restored queue still waits while held for the usage limit or paused", () => {
  const held = fakeSession();
  const d1 = new Dispatcher(held);
  d1.restore({ queue: [queued("c3")] });
  d1.hold(Date.now() + 60_000);
  d1._drain();
  assert.equal(held.sent.length, 0, "the cold-start kick must not override a quota hold");
  d1.dispose();

  const paused = fakeSession();
  const d2 = new Dispatcher(paused);
  d2.restore({ queue: [queued("d4")] });
  d2.setPaused(true);
  d2._drain();
  assert.equal(paused.sent.length, 0, "nor an auth pause");
});

test("supervisor: drains whenever the new dispatcher has a queue, restored or transferred", () => {
  const SRC = fs.readFileSync(path.join(ROOT, "agent/supervisor/index.mjs"), "utf8");
  const start = SRC.indexOf("this.dispatcher.restore(persisted)");
  assert.ok(start > -1, "cold-start restore not found in supervisor/index.mjs: was it renamed?");
  const kick = SRC.indexOf("this.dispatcher._drain()", start);
  assert.ok(kick > start, "no _drain() call after the cold-start restore");
  const line = SRC.slice(SRC.lastIndexOf("\n", kick) + 1, SRC.indexOf("\n", kick));
  assert.match(line, /this\.dispatcher\.queue\.length/, "the kick must be gated on the queue, not only on items transferred in-process");
  // It has to follow the listeners it relies on (turn watchdog arm, event
  // log), or the first restored turn runs unwatched.
  const listener = SRC.indexOf('this.dispatcher.on("dispatching"', start);
  assert.ok(listener > start && listener < kick, "the drain must follow the dispatching listener");
});
