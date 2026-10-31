// motion-gate.test.mjs — the mobile ping gate: classify motion, park non-urgent
// alerts while moving, let urgent ones through, coalesce on flush.
//
// Run: node --test agent/test/motion-gate.test.mjs
//
// The queue path is redirected via JORI_PING_QUEUE before any import that
// reads it, so nothing here touches the live queue.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_QUEUE = path.join(os.tmpdir(), `ping-hold-test-${process.pid}.json`);
process.env.JORI_PING_QUEUE = TMP_QUEUE;

const { describe, it, beforeEach, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { classifyMotion, TRANSIT_FRESH_MS, OPEN_VISIT_MAX_MS } = await import("../../lib/motion-state.mjs");
const { holdPing, readQueue, writeQueue, partitionQueue, coalesce, MAX_HOLD_MS, MAX_QUEUE } =
  await import("../../lib/ping-hold.mjs");
const { sendApnsPush } = await import("../../lib/apns-push.mjs");

const NOW = Date.parse("2026-08-05T15:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;

function transit(activity, ageMs) {
  return { segment_type: "transit", activity, arrived_at: ago(ageMs), departed_at: null };
}

describe("classifyMotion", () => {
  it("calls fresh walking mobile", () => {
    assert.equal(classifyMotion(transit("walking", 2 * MIN), NOW).state, "mobile");
  });

  it("treats driving as mobile too — a windshield is no better than a pocket", () => {
    assert.equal(classifyMotion(transit("driving", 1 * MIN), NOW).state, "mobile");
    assert.equal(classifyMotion(transit("cycling", 1 * MIN), NOW).state, "mobile");
    assert.equal(classifyMotion(transit("running", 1 * MIN), NOW).state, "mobile");
  });

  it("stops trusting a stale transit row", () => {
    const r = classifyMotion(transit("walking", TRANSIT_FRESH_MS + MIN), NOW);
    assert.equal(r.state, "unknown", "a 13-minute-old walking row proves nothing about now");
  });

  it("calls an open visit stationary at any reasonable age", () => {
    const dinner = { segment_type: "visit", activity: "stationary", arrived_at: ago(3 * 60 * MIN), departed_at: null };
    assert.equal(classifyMotion(dinner, NOW).state, "stationary");
  });

  it("calls an open visit stationary even when the activity reads walking", () => {
    // A browsing stop inside a market is still a stop — the user can look at a screen.
    const market = { segment_type: "visit", activity: "walking", arrived_at: ago(20 * MIN), departed_at: null };
    assert.equal(classifyMotion(market, NOW).state, "stationary");
  });

  it("gives up on an open visit that outlived the phone", () => {
    const zombie = { segment_type: "visit", activity: "stationary", arrived_at: ago(OPEN_VISIT_MAX_MS + MIN), departed_at: null };
    assert.equal(classifyMotion(zombie, NOW).state, "unknown");
  });

  it("fails OPEN on missing, empty and unparseable data", () => {
    assert.equal(classifyMotion(null, NOW).state, "unknown");
    assert.equal(classifyMotion({ segment_type: "transit", activity: "walking", arrived_at: "junk" }, NOW).state, "unknown");
    assert.equal(classifyMotion({ segment_type: "transit", activity: "unknown", arrived_at: ago(MIN) }, NOW).state, "unknown");
  });

  it("does not read clock skew as staleness", () => {
    const future = { segment_type: "transit", activity: "walking", arrived_at: new Date(NOW + 30000).toISOString(), departed_at: null };
    assert.equal(classifyMotion(future, NOW).state, "mobile");
  });
});

describe("hold queue", () => {
  beforeEach(() => { try { fs.unlinkSync(TMP_QUEUE); } catch {} });

  it("round-trips a held ping", () => {
    holdPing({ body: "Falafel 80m away", channel: "chat", reason: "activity=walking" }, { nowMs: NOW });
    const q = readQueue();
    assert.equal(q.length, 1);
    assert.equal(q[0].body, "Falafel 80m away");
    assert.equal(q[0].reason, "activity=walking");
  });

  it("caps the queue so a runaway producer cannot grow the file forever", () => {
    for (let i = 0; i < MAX_QUEUE + 10; i++) holdPing({ body: `p${i}` }, { nowMs: NOW });
    const q = readQueue();
    assert.equal(q.length, MAX_QUEUE);
    assert.equal(q.at(-1).body, `p${MAX_QUEUE + 9}`, "keeps the newest");
  });

  it("survives a corrupt queue file rather than throwing into cron", () => {
    fs.writeFileSync(TMP_QUEUE, "{not json");
    assert.deepEqual(readQueue(), []);
  });

  it("expires alerts held past the cap, keeps the rest", () => {
    const entries = [
      { body: "old", held_at: ago(MAX_HOLD_MS + MIN), channel: "chat" },
      { body: "fresh", held_at: ago(5 * MIN), channel: "chat" },
    ];
    const { due, expired } = partitionQueue(entries, NOW);
    assert.deepEqual(due.map((e) => e.body), ["fresh"]);
    assert.deepEqual(expired.map((e) => e.body), ["old"]);
  });

  it("delivers an entry with no usable timestamp instead of dropping it", () => {
    const { due, expired } = partitionQueue([{ body: "x", held_at: null }], NOW);
    assert.equal(due.length, 1);
    assert.equal(expired.length, 0);
  });
});

describe("coalesce", () => {
  it("passes a lone ping through untouched", () => {
    const [p] = coalesce([{ body: "one thing", channel: "chat", messageId: "m1", held_at: ago(MIN) }]);
    assert.equal(p.body, "one thing");
    assert.equal(p.messageId, "m1");
  });

  it("collapses a walk's worth of pings into one buzz, newest visible", () => {
    const pushes = coalesce([
      { body: "first", channel: "chat", messageId: "m1", held_at: ago(30 * MIN) },
      { body: "second", channel: "chat", messageId: "m2", held_at: ago(20 * MIN) },
      { body: "newest", channel: "chat", messageId: "m3", held_at: ago(2 * MIN) },
    ]);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].body, "newest (+2 more)");
    assert.equal(pushes[0].messageId, "m3", "deep-links to the freshest");
    assert.equal(pushes[0].count, 3);
  });

  it("keeps channels apart — system must not ride a chat badge", () => {
    const pushes = coalesce([
      { body: "chat thing", channel: "chat", held_at: ago(MIN) },
      { body: "ollama restarted", channel: "system", held_at: ago(MIN) },
    ]);
    assert.equal(pushes.length, 2);
    assert.deepEqual(pushes.map((p) => p.channel).sort(), ["chat", "system"]);
  });
});

describe("sendApnsPush motion gate", () => {
  beforeEach(() => { try { fs.unlinkSync(TMP_QUEUE); } catch {} });

  // sendApnsPush reads the real clock, so these rows are stamped live-relative
  // rather than against the frozen NOW the pure tests above use.
  const liveAgo = (ms) => new Date(Date.now() - ms).toISOString();
  const liveTransit = (activity, ageMs) => ({
    segment_type: "transit", activity, arrived_at: liveAgo(ageMs), departed_at: null,
  });

  function mockSupabase(row, spy = {}) {
    return {
      from(table) {
        if (table === "location_history") {
          return { select: () => ({ order: () => ({ limit: async () => ({ data: row ? [row] : [], error: null }) }) }) };
        }
        spy.reachedTokens = true;
        return { select: async () => ({ data: [], error: null }) };
      },
    };
  }

  it("parks a non-urgent ping while moving and never reaches APNs", async () => {
    const spy = {};
    const res = await sendApnsPush(mockSupabase(liveTransit("walking", MIN), spy), { body: "Falafel 80m away" });
    assert.equal(res.held, true);
    assert.equal(res.delivered, false);
    assert.ok(!spy.reachedTokens, "gate returns before the token query");
    assert.equal(readQueue().length, 1);
  });

  it("lets an urgent ping through while moving — it gets announced aloud", async () => {
    const spy = {};
    await sendApnsPush(mockSupabase(liveTransit("driving", MIN), spy), { body: "Leave now", urgent: true });
    assert.ok(spy.reachedTokens, "urgent bypasses the gate entirely");
    assert.equal(readQueue().length, 0, "nothing parked");
  });

  it("sends a non-urgent ping when the user is stationary", async () => {
    const spy = {};
    const visit = { segment_type: "visit", activity: "stationary", arrived_at: liveAgo(10 * MIN), departed_at: null };
    await sendApnsPush(mockSupabase(visit, spy), { body: "Finance digest ready" });
    assert.ok(spy.reachedTokens);
    assert.equal(readQueue().length, 0);
  });

  it("sends when motion is unknown — a data gap must never mute Jori", async () => {
    const spy = {};
    await sendApnsPush(mockSupabase(null, spy), { body: "Morning digest" });
    assert.ok(spy.reachedTokens);
    assert.equal(readQueue().length, 0);
  });

  it("honours skipMotionGate so the flusher can deliver what it parked", async () => {
    const spy = {};
    await sendApnsPush(mockSupabase(liveTransit("walking", MIN), spy), { body: "flushed", skipMotionGate: true });
    assert.ok(spy.reachedTokens);
    assert.equal(readQueue().length, 0);
  });
});

after(() => { try { fs.unlinkSync(TMP_QUEUE); } catch {} });
