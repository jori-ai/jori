// question-dismiss.test.mjs — a question dismissed in the app is closed at its
// source, silently, with no agent turn.
//
// Run: node --test tests/question-dismiss.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "question-dismiss-"));
process.env.JORI_DATA_DIR = tmp;
const { isDismissal, dismissQuestion } = await import("../lib/question-dismiss.mjs");
const { handleChoiceReply } = await import("../lib/choice-reply.mjs");

const deps = (over = {}) => {
  const calls = { retired: [], stamped: [], declined: [], decisions: [] };
  return {
    calls,
    getQuestion: (id) => ({ id, msg_ids: ["m1", "m2"], memory_hook: over.hook || null }),
    recordRetired: (id, why) => { calls.retired.push([id, why]); return { id }; },
    stampRows: async (ids, state) => { calls.stamped.push([ids.sort(), state]); return ids.length; },
    declineIdea: async (id) => { calls.declined.push(id); return true; },
    dismissDecision: async (ref) => { calls.decisions.push(ref); return true; },
  };
};

test("a dismissal is a user reply carrying question_dismiss", () => {
  assert.equal(isDismissal({ role: "user", reply_to: "p", metadata: { question_dismiss: "1" } }), true);
  assert.equal(isDismissal({ role: "user", reply_to: "p", metadata: {} }), false);
  assert.equal(isDismissal({ role: "user", metadata: { question_dismiss: "1" } }), false);
  assert.equal(isDismissal({ role: "assistant", reply_to: "p", metadata: { question_dismiss: "1" } }), false);
});

test("a ledger question is retired and every copy stamped dismissed", async () => {
  const d = deps();
  const r = await dismissQuestion({ id: "m3", metadata: { question_id: "q1" } }, d);
  assert.deepEqual([r.handled, r.reply], [true, null]);
  assert.deepEqual(d.calls.retired, [["q1", "dismissed by the user"]]);
  assert.deepEqual(d.calls.stamped, [[["m1", "m2", "m3"], "dismissed"]]);
  assert.deepEqual(d.calls.declined, []);
});

test("a hum improvement ask also declines its idea, so hum_asks stops re-asking", async () => {
  const d = deps({ hook: "hum_improvement:idea-7" });
  await dismissQuestion({ id: "m3", metadata: { question_id: "q1" } }, d);
  assert.deepEqual(d.calls.declined, ["idea-7"]);
});

test("a decision card is closed in its source", async () => {
  const d = deps();
  const choices = JSON.stringify({ v: 1, kind: "decision", ref: "ppl:abc", options: [{ label: "Yes" }, { label: "No" }] });
  await dismissQuestion({ id: "m9", metadata: { choices } }, d);
  assert.deepEqual(d.calls.decisions, ["ppl:abc"]);
  assert.deepEqual(d.calls.stamped, [[["m9"], "dismissed"]]);
  assert.deepEqual(d.calls.retired, []);
});

test("the decision source entry becomes dismissed and is no longer open", async () => {
  const dq = await import("../lib/decision-queue.mjs");
  const q = { id: "abc", status: "open", question: "Stay in touch?", options: ["Yes", "No"] };
  fs.writeFileSync(dq.PATHS.people(), JSON.stringify({ questions: [q] }));
  const { dismissDecision } = await import("../lib/question-dismiss.mjs");
  assert.equal(await dismissDecision("ppl:abc"), true);
  const doc = JSON.parse(fs.readFileSync(dq.PATHS.people(), "utf8"));
  assert.equal(doc.questions[0].status, "dismissed");
  assert.equal(dq.isOpen(doc.questions[0]), false);
  assert.equal(await dismissDecision("ppl:abc"), false);
});

test("choice-reply takes the dismissal before any option match, silently", async () => {
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "p1", metadata: {} } }) }) }) }) };
  const out = await handleChoiceReply(supabase, { role: "user", reply_to: "p1", metadata: { question_dismiss: "1" } }, "Dismissed");
  assert.equal(out.handled, true);
  assert.equal(out.reply, null);
  assert.equal(out.kind, "dismiss");
});
