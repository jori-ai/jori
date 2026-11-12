// lib/speak-gate-live.mjs — the speak gate in front of delivery acts on its
// verdict: send / rewrite deliver, drop / digest / resolve hold a proactive
// message (recorded, never delivered), a reply is never held, and any gate
// failure delivers the original. The judge is a stand-in script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sgl-"));
const sink = path.join(dir, "reviews.jsonl");
process.env.SPEAK_GATE_LIVE = "1";
process.env.SPEAK_GATE_REVIEW_SINK = sink;

function fakeJudge(result) {
  const f = path.join(dir, `judge-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, `process.stdin.resume();process.stdin.on("end",()=>console.log(${JSON.stringify(JSON.stringify(result))}));`);
  process.env.SPEAK_GATE_BIN = f;
}
const rows = () => (existsSync(sink) ? readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const { gateOutbound, recordReview } = await import("../lib/speak-gate-live.mjs");

test("send delivers as written with a review to link", async () => {
  fakeJudge({ verdict: "send", reason: "fine" });
  const r = await gateOutbound({ message: "hello", channel: "chat", sender: "cfo" });
  assert.equal(r.deliver, true);
  assert.equal(r.text, "hello");
  assert.equal(r.review.verdict, "send");
  assert.equal(r.review.original, "hello");
  assert.equal(r.review.conversation_id, "role:cfo");
});

test("rewrite delivers the gate's text and keeps the original", async () => {
  fakeJudge({ verdict: "rewrite", message: "better", reason: "clearer" });
  const r = await gateOutbound({ message: "worse", channel: "chat" });
  assert.equal(r.text, "better");
  assert.equal(r.review.verdict, "rewrite");
  assert.equal(r.review.original, "worse");
});

test("a proactive drop is held and recorded with no message id", async () => {
  fakeJudge({ verdict: "drop", reason: "nothing new" });
  const before = rows().length;
  const r = await gateOutbound({ message: "noise", channel: "chat", sender: "ops-x" });
  assert.equal(r.deliver, false);
  const added = rows().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].held, true);
  assert.equal(added[0].message_id, null);
  assert.equal(added[0].original, "noise");
});

test("resolve keeps what the gate found as the suggestion", async () => {
  fakeJudge({ verdict: "resolve", research_plan: "answered in email", reason: "findable" });
  const before = rows().length;
  const r = await gateOutbound({ message: "did X happen?", channel: "questions" });
  assert.equal(r.deliver, false);
  assert.equal(rows().slice(before)[0].suggestion, "answered in email");
});

test("a reply is never held", async () => {
  fakeJudge({ verdict: "drop", reason: "x" });
  const r = await gateOutbound({ message: "answer", channel: "chat", kind: "reply" });
  assert.equal(r.deliver, true);
  assert.equal(r.review.verdict, "send");
});

test("a gate error delivers the original and records the error", async () => {
  fakeJudge({ verdict: "send", reason: "gate_error:judge_unavailable:timeout" });
  const r = await gateOutbound({ message: "m", channel: "chat" });
  assert.equal(r.deliver, true);
  assert.equal(r.text, "m");
  assert.equal(r.review.verdict, "error");
});

test("a judge that prints nothing fails open", async () => {
  const f = path.join(dir, "silent.mjs");
  writeFileSync(f, "process.stdin.resume();");
  process.env.SPEAK_GATE_BIN = f;
  const r = await gateOutbound({ message: "m2", channel: "chat" });
  assert.equal(r.deliver, true);
  assert.equal(r.text, "m2");
});

test("system channel is not gated", async () => {
  fakeJudge({ verdict: "drop", reason: "x" });
  const r = await gateOutbound({ message: "🔴 disk full", channel: "system" });
  assert.equal(r.deliver, true);
  assert.equal(r.skipped, true);
});

test("recordReview links the review to the delivered row", async () => {
  const before = rows().length;
  await recordReview({ verdict: "send", original: "a" }, "11111111-1111-1111-1111-111111111111");
  assert.equal(rows().slice(before)[0].message_id, "11111111-1111-1111-1111-111111111111");
});

test("the daily summary prints held messages verbatim, in their own section, email only", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { _internal } = require("../lib/daily-summary-render.js");
  const day = { tz: "America/New_York", held_digests: [
    { judged_at: "2026-11-11T14:05:00Z", from: "Ada (CFO)", text: "Card statement posted: $1,240\nNothing due." },
  ] };
  const html = _internal.heldDigestsHtml(day).join("\n");
  for (const want of ["Held for this summary", 'class="held-digest"', "9:05 AM", "Ada (CFO)", "$1,240<br>Nothing due."]) {
    assert.ok(html.includes(want), `missing ${want}`);
  }
  assert.deepEqual(_internal.heldDigestsHtml({}), []);
  assert.ok(_internal.heldDigestsHtml({ held_digests_error: "boom" }).join("").includes("Couldn't read the held messages"));
});
