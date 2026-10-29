// Guards the link between a P1 email and its Google Task (lib/p1-task.js).
//
// The rule these tests pin: a resolution closes the task the P1 spawned —
// by marker when the task was created through `p1-task add`, by ONE clear
// subject match otherwise — and closes nothing when the match is ambiguous.
// A wrong task closed silently is worse than a stale one the user can see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { taskMarker, parseMarker, subjectTokens, matchTasks, openTaskForThread } = require("../lib/p1-task.js");

const T = (id, title, notes = "", status = "needsAction") => ({ id, title, notes, status });

test("marker round-trips through task notes", () => {
  const m = taskMarker("thr123", "msg456");
  assert.equal(m, "[jori-p1 thread:thr123 msg:msg456]");
  assert.deepEqual(parseMarker(`Context from triage.\n\n${m}`), { threadId: "thr123", messageId: "msg456" });
  assert.equal(parseMarker("no marker here"), null);
  assert.equal(parseMarker(""), null);
});

test("subject tokens strip reply prefixes, punctuation, stopwords", () => {
  assert.deepEqual(subjectTokens("Re: Fwd: RE: Handy Sam — paint code for Maple wall"),
    ["handy", "sam", "paint", "code", "maple", "wall"]);
  assert.deepEqual(subjectTokens("Your account has been updated"), ["account", "been"]);
  assert.deepEqual(subjectTokens(""), []);
});

test("marker match wins even when titles look nothing like the subject", () => {
  const tasks = [
    T("a", "Set up a managed house phone for Maple"),
    T("b", "Handy Sam — paint code for Maple Lodge wall patch", `notes\n\n${taskMarker("thrX", "msgX")}`),
  ];
  const r = matchTasks(tasks, { threadId: "thrX", messageId: "other", subject: "Unrelated subject entirely" });
  assert.deepEqual(r.exact.map((t) => t.id), ["b"]);
  assert.equal(r.fuzzy.length, 0);
});

test("marker match by messageId when the thread id differs", () => {
  const tasks = [T("b", "Anything", taskMarker("thrOld", "msg9"))];
  const r = matchTasks(tasks, { threadId: "thrNew", messageId: "msg9", subject: "x" });
  assert.deepEqual(r.exact.map((t) => t.id), ["b"]);
});

test("completed tasks are never candidates", () => {
  const tasks = [T("b", "Anything", taskMarker("thrX", "msgX"), "completed")];
  const r = matchTasks(tasks, { threadId: "thrX", messageId: "msgX", subject: "Anything" });
  assert.equal(r.exact.length, 0);
  assert.equal(r.fuzzy.length, 0);
});

test("subject fallback: one clear winner is returned", () => {
  const tasks = [
    T("a", "Anthropic prospectus"),
    T("b", "Handy Sam — paint code for Maple Lodge wall patch", "Handy Sam asked: do you have paint on hand? Thread: Re: 20044 - wall patch"),
    T("c", "Roth conversion — 2031"),
  ];
  const r = matchTasks(tasks, { threadId: "none", messageId: "none", subject: "Re: 20044 - Maple wall patch paint code" });
  assert.deepEqual(r.fuzzy.map((t) => t.id), ["b"]);
  assert.equal(r.ambiguous.length, 0);
});

test("subject fallback: two near-equal candidates close nothing", () => {
  const tasks = [
    T("a", "Birch gas utility bills missing (101) — Sept 2026"),
    T("b", "Birch gas utility bills missing (102) — Sept 2026"),
  ];
  const r = matchTasks(tasks, { threadId: "none", messageId: "none", subject: "Birch gas utility bills missing" });
  assert.equal(r.fuzzy.length, 0);
  assert.deepEqual(r.ambiguous.map((t) => t.id).sort(), ["a", "b"]);
});

test("subject fallback: weak overlap is not a match", () => {
  const tasks = [T("a", "Set up a managed house phone for Maple")];
  const r = matchTasks(tasks, { threadId: "none", messageId: "none", subject: "Maple Lodge spa report" });
  assert.equal(r.fuzzy.length, 0);
  assert.equal(r.ambiguous.length, 0);
});

test("subject fallback needs at least two identity tokens", () => {
  const tasks = [T("a", "Anthropic prospectus")];
  const r = matchTasks(tasks, { threadId: "none", messageId: "none", subject: "Anthropic" });
  assert.equal(r.fuzzy.length, 0);
});

test("one P1 thread, one task: an open task on the thread is reused", () => {
  const open = [T("A", "Check new mail at the mailbox", taskMarker("thr1", "m1")), T("B", "Other", "x")];
  assert.equal(openTaskForThread(open, "thr1").id, "A");
  assert.equal(openTaskForThread(open, "another-thread"), null);
  assert.equal(openTaskForThread([T("A", "t", taskMarker("thr1", "m1"), "completed")], "thr1"), null, "a closed task is not reused");
  assert.equal(openTaskForThread(open, null), null);
});
