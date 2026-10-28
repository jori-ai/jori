// message-followup: the 24h unanswered-urgent ask (lib/message-followup.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dueRows, answered, composeAsk, runFollowup } from "../lib/message-followup.mjs";

const H = 3600_000, NOW = Date.parse("2026-10-30T12:00:00Z");
const row = (o) => ({ channel: "whatsapp", message_id: "m1", chat_id: "c1", level: "urgent", sent_at: new Date(NOW - 25 * H).toISOString(), from: "Alex", text: "call me", ...o });

test("only urgent rows 24-72h old, with a chat id, not asked before", () => {
  const rows = [row(), row({ message_id: "m2", level: "important" }), row({ message_id: "m3", sent_at: new Date(NOW - 2 * H).toISOString() }),
    row({ message_id: "m4", sent_at: new Date(NOW - 80 * H).toISOString() }), row({ message_id: "m5", chat_id: undefined }), row({ message_id: "m6" })];
  assert.deepEqual(dueRows(rows, { asked: { "whatsapp:m6": "x" } }, NOW).map((r) => r.message_id), ["m1"]);
});

test("answered = the user's own row later in the same chat", () => {
  const r = row();
  assert.equal(answered(r, [{ chat_id: "c1", from_me: true, ts: new Date(NOW - 20 * H).toISOString() }], "chat_id"), true);
  assert.equal(answered(r, [{ chat_id: "c1", from_me: true, ts: new Date(NOW - 30 * H).toISOString() }], "chat_id"), false);
  assert.equal(answered(r, [{ chat_id: "c2", from_me: true, ts: new Date(NOW - 20 * H).toISOString() }], "chat_id"), false);
  assert.equal(answered(r, [{ chat_id: "c1", kind: "sent", ts: new Date(NOW - 20 * H).toISOString() }], "chat_id"), true);
});

test("one ask for all open rows; state settles answered ones too; rerun is silent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data/message-alert-log.jsonl"), [row(), row({ message_id: "m2", chat_id: "c2", is_group: true, chat: "Family" })].map((r) => JSON.stringify(r)).join("\n"));
  fs.writeFileSync(path.join(root, "data/whatsapp-inbox.jsonl"), JSON.stringify({ chat_id: "c2", from_me: true, ts: new Date(NOW - H).toISOString() }) + "\n");
  const sent = [];
  const r1 = runFollowup({ root, now: NOW, send: (t) => sent.push(t) });
  assert.equal(r1.due, 2);
  assert.equal(r1.unanswered, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith("Urgent message still unanswered after 24h:\n- Alex (WhatsApp"));
  const r2 = runFollowup({ root, now: NOW + H, send: (t) => sent.push(t) });
  assert.equal(r2.due, 0);
  assert.equal(sent.length, 1);
});

test("group rows name the sender and the group", () => {
  assert.ok(composeAsk([row({ is_group: true, chat: "Family" })]).includes("- Alex in Family (WhatsApp,"));
});
