// location-enrich gate: a stop whose ask is already composed and waiting in
// the ask queue must NOT wake an agent turn every 15 minutes (2026-10-04:
// 165 no-op dispatches in three days). It wakes again only when the signals
// the ask was composed from change.

import test from "node:test";
import assert from "node:assert/strict";
import { decide, signalHash, features, resolveTz, timeOfDayBucket } from "../lib/location-enrich-gate.mjs";

const now = Date.parse("2026-10-04T18:00:00Z");
const row = (id, extra = {}) => ({
  visit_id: id, asked: false,
  departed_at: "2026-10-04T16:00:00Z", ready_at: "2026-10-04T16:15:00Z",
  candidates: [{ name: "Cafe A", type: "Cafe" }], ...extra,
});

test("unqueued askable stop wakes the agent", () => {
  const r = decide({ pending: [row("v1")], queue: [], state: {}, now });
  assert.deepEqual(r.askable, ["v1"]);
});

test("queued stop with unchanged signals does not wake the agent", () => {
  const first = decide({ pending: [row("v1")], queue: [], state: {}, now });
  const r = decide({ pending: [row("v1")], queue: [{ visit_id: "v1" }], state: first.state, now });
  assert.deepEqual(r.askable, []);
  assert.deepEqual(r.skippedQueued, ["v1"]);
});

test("queued stop with no recorded hash is treated as freshly composed", () => {
  const r = decide({ pending: [row("v1")], queue: [{ visit_id: "v1" }], state: {}, now });
  assert.deepEqual(r.askable, []);
});

test("queued stop whose signals changed recomposes exactly once", () => {
  const s1 = decide({ pending: [row("v1")], queue: [], state: {}, now }).state;
  const changed = row("v1", { movement_evidence: { pattern: "browse" } });
  const r2 = decide({ pending: [changed], queue: [{ visit_id: "v1" }], state: s1, now });
  assert.deepEqual(r2.askable, ["v1"]);
  const r3 = decide({ pending: [changed], queue: [{ visit_id: "v1" }], state: r2.state, now });
  assert.deepEqual(r3.askable, []);
});

test("asked, not-ready and >12h-old stops are never askable", () => {
  const r = decide({
    pending: [
      row("a", { asked: true }),
      row("b", { ready_at: "2026-10-04T19:00:00Z" }),
      row("c", { departed_at: "2026-10-04T04:00:00Z" }),
    ], queue: [], state: {}, now,
  });
  assert.deepEqual(r.askable, []);
});

test("local time follows the phone tz, not the home zone", () => {
  const f = features({ visit_id: "x", arrived_at: "2026-07-19T12:58:46Z", departed_at: "2026-07-19T13:40:00Z", duration_min: 41 }, "Europe/Paris");
  assert.equal(f.arrived_local, "14:58");
  assert.equal(f.time_of_day, "errand_appointment_or_visit");
  assert.equal(f.duration_shape, "sit_down_coffee_quick_meal_haircut");
});

test("stale, missing or bad tz file falls back to the home zone", () => {
  const t = Date.parse("2026-10-04T00:00:00Z");
  assert.equal(resolveTz({ timezone: "Europe/Paris", updated_at: "2026-08-01T00:00:00Z" }, t, "Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(resolveTz(null, t, "Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(resolveTz({ timezone: "Not/AZone" }, t, "Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(resolveTz({ timezone: "Europe/Paris", updated_at: "2026-09-30T00:00:00Z" }, t), "Europe/Paris");
});

test("browse pattern or moving activity flips to walking-led", () => {
  assert.equal(features({ visit_id: "x", movement_evidence: { pattern: "browse", dominant_activity: "stationary" } }, "UTC").movement_led, true);
  assert.equal(features({ visit_id: "x", movement_evidence: { pattern: "dwell", dominant_activity: "stationary" } }, "UTC").movement_led, false);
  assert.equal(features({ visit_id: "x" }, "UTC").movement_led, null);
  assert.equal(timeOfDayBucket("13:10"), "lunch");
});

test("candidate order is part of the hash (it is the ranking signal)", () => {
  const a = signalHash(row("v", { candidates: [{ name: "A" }, { name: "B" }] }));
  const b = signalHash(row("v", { candidates: [{ name: "B" }, { name: "A" }] }));
  assert.notEqual(a, b);
});
