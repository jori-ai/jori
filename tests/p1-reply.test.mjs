// Guards Signal D of the P1 resolution system (lib/p1-reply.js): a
// starred p1 is resolved when the NEWEST message in its thread is one the user
// SENT. Drafts never count; a later inbound re-opens the thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decideThread } = require("../lib/p1-reply.js");

const P1 = "Label_28";
const M = (id, at, labels) => ({ id, internalDate: String(at), labelIds: labels });

test("his reply after a starred p1 resolves it", () => {
  const d = decideThread([
    M("in1", 1000, ["INBOX", P1, "STARRED", "UNREAD"]),
    M("out1", 2000, ["SENT"]),
  ], P1);
  assert.deepEqual(d.resolved, ["in1"]);
  assert.equal(d.replyId, "out1");
  assert.equal(d.replyAt, new Date(2000).toISOString());
});

test("a draft reply is not a reply", () => {
  const d = decideThread([
    M("in1", 1000, ["INBOX", P1, "STARRED"]),
    M("dr1", 2000, ["DRAFT"]),
  ], P1);
  assert.deepEqual(d.resolved, []);
});

test("an inbound after his reply keeps the thread live", () => {
  const d = decideThread([
    M("in1", 1000, ["INBOX", P1, "STARRED"]),
    M("out1", 2000, ["SENT"]),
    M("in2", 3000, ["INBOX", P1, "STARRED"]),
  ], P1);
  assert.deepEqual(d.resolved, []);
});

test("only starred p1 messages older than the reply are resolved", () => {
  const d = decideThread([
    M("old", 500, ["INBOX", P1]),            // p1 but already unstarred → not ours
    M("in1", 1000, ["INBOX", P1, "STARRED"]),
    M("in1b", 1500, ["INBOX", P1, "STARRED"]),
    M("out1", 2000, ["SENT"]),
  ], P1);
  assert.deepEqual(d.resolved, ["in1", "in1b"]);
});

test("his own outbound that started the thread resolves nothing", () => {
  const d = decideThread([M("out0", 1000, ["SENT"])], P1);
  assert.deepEqual(d.resolved, []);
  assert.equal(d.replyId, null);
});

test("jori's SMTP reply (not SENT) does not count as his reply", () => {
  const d = decideThread([
    M("out0", 1000, ["SENT"]),
    M("g1", 2000, ["INBOX", P1, "STARRED"]),
  ], P1);
  assert.deepEqual(d.resolved, []);
});

test("empty or malformed input is safe", () => {
  assert.deepEqual(decideThread([], P1).resolved, []);
  assert.deepEqual(decideThread(null, P1).resolved, []);
  assert.deepEqual(decideThread([{}], P1).resolved, []);
});
