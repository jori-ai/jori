// email-triage-report.test.mjs — scoring the strict one-shot's shadow runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { score, shadowOutcome } from "../bin/email-triage-report";

const T = Date.parse("2026-11-01T00:00:00Z");
const run = (id, summaries, extra = {}) => ({ ts: new Date(T).toISOString(), messageId: id, mode: "shadow", outcome: "triaged", summaries, intake_p1: false, ...extra });

test("shadowOutcome reads label and priority from what the run would have done", () => {
  assert.deepEqual(shadowOutcome(run("a", ["gmail-action label a vendor", "gmail-action mark-read a"])), { label: "vendor", priority: "P3" });
  assert.deepEqual(shadowOutcome(run("b", ["gmail-action label b personal"], { intake_p1: true })), { label: "personal", priority: "P1" });
  assert.deepEqual(shadowOutcome(run("c", ["p1-downgrade (x)", "gmail-action label c personal", "gmail-action star c"], { intake_p1: true })), { label: "personal", priority: "P2" });
});

test("score: agreement, missed P1s, escalations set aside, and the bar", () => {
  const actual = { a: { label: "vendor", priority: "P3" }, b: { label: "personal", priority: "P1" }, d: { label: "personal", priority: "P1" } };
  const rows = [
    run("a", ["gmail-action label a vendor"]),
    run("b", ["gmail-action label b personal"], { intake_p1: true }),
    run("d", ["gmail-action label d personal"]),                       // missed P1
    run("e", [], { outcome: "escalated" }),
    run("f", ["gmail-action label f vendor"], { mode: "replay" }),     // not a shadow run
  ];
  const r = score(rows, { now: T + 3600e3, getRow: (id) => actual[id] || null });
  assert.equal(r.scored, 3); assert.equal(r.label_agree, 3); assert.equal(r.priority_agree, 2);
  assert.deepEqual(r.missed_p1, ["d"]); assert.equal(r.escalated, 1);
  assert.equal(r.verdict.ready, false);
  assert.ok(r.verdict.reasons.some((x) => x.includes("missed P1")));
});
