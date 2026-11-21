// lib/reply-to.cjs — a dispatched job answers in the conversation that asked,
// and jori-send-curl --conversation files the row there.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validConversation, replyToLine, withReplyTo } = require("../lib/reply-to.cjs");

test("conversation ids: a role's thread or a group", () => {
  for (const ok of ["role:chief-of-staff", "role:travel-manager", "group:0f8fad5b-d9cb-469f-a165-70867728950e"]) assert.equal(validConversation(ok), true, ok);
  for (const bad of ["", "chat", "role:", "role:Bad Id", "group:123", "role:x;rm -rf", "role:x\"y"]) assert.equal(validConversation(bad), false, bad);
});

test("withReplyTo appends one fixed line naming the --conversation flag; no id leaves the task alone", () => {
  const t = withReplyTo("the airport; Mar 4; Mar 5", "role:chief-of-staff");
  assert.ok(t.startsWith("the airport; Mar 4; Mar 5\n\nReply to: conversation role:chief-of-staff."));
  assert.ok(t.includes("--conversation role:chief-of-staff"));
  assert.equal(withReplyTo("x", null), "x");
  assert.ok(withReplyTo(null, "role:a").startsWith("Reply to: conversation role:a."));
  assert.throws(() => replyToLine("chat"), /not a conversation id/);
});

test("jori-send-curl writes conversation_id only for a valid id, on every insert", () => {
  const src = fs.readFileSync(new URL("../bin/jori-send-curl", import.meta.url), "utf8");
  assert.ok(src.includes("--conversation)   CONVERSATION_FLAG="));
  assert.ok(src.includes("validConversation"));
  const inserts = src.split("\n").filter((l) => l.includes('-d "{\\"role\\":\\"assistant\\"'));
  assert.ok(inserts.length >= 2);
  for (const l of inserts) assert.ok(l.includes("${JSON_CONVERSATION}"), l);
});
