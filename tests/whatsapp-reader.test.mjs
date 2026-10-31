// bin/whatsapp read/chats/search over a synthetic inbox log: the user's
// own messages and Jori's sends are labelled "You", group posts by their
// sender, groups are found by subject, and a name with a quote is safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = new URL("../bin/whatsapp", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-read-"));
const INBOX = path.join(tmp, "inbox.jsonl");
const G = "15550100000-1600000000@g.us";
const rows = [
  { ts: "2026-01-01T10:00:00Z", kind: "message", chat_id: G, is_group: true, group_name: "Book Club", sender: "15550100002", sender_name: "Dana", type: "conversation", text: "who is in for Friday" },
  { ts: "2026-01-01T10:01:00Z", kind: "message", chat_id: G, is_group: true, group_name: "Book Club", from_me: true, sender: "15550100001", sender_name: "Owner", type: "conversation", text: "me" },
  { ts: "2026-01-01T10:02:00Z", kind: "message", chat_id: "15550100003@s.whatsapp.net", is_group: false, sender: "15550100003", sender_name: "Sam O'Neil", type: "conversation", text: "lunch?" }, // kernel-guard-ok: synthetic WhatsApp chat id (555-style test number)
  { ts: "2026-01-01T10:03:00Z", kind: "message", chat_id: "15550100003@s.whatsapp.net", is_group: false, from_me: true, sender: "15550100001", sender_name: "Owner", type: "conversation", text: "sure, noon" }, // kernel-guard-ok: synthetic WhatsApp chat id (555-style test number)
  { ts: "2026-01-01T10:04:00Z", kind: "sent", message_id: "X", chat_id: "15550100003@s.whatsapp.net", text: "reminder from the assistant" }, // kernel-guard-ok: synthetic WhatsApp chat id (555-style test number)
];
fs.writeFileSync(INBOX, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const wa = (...args) => spawnSync("bash", [BIN, ...args], { env: { PATH: process.env.PATH, HOME: tmp, WHATSAPP_INBOX: INBOX }, encoding: "utf8" });

test("read a group by subject: both sides, each post labelled by who wrote it", () => {
  const r = wa("read", "book club");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[Book Club\] Dana: who is in for Friday/);
  assert.match(r.stdout, /\[Book Club\] You: me/);
});

test("read a 1:1 chat by a name with a quote: their messages, the user's, and Jori's sends", () => {
  const r = wa("read", "Sam O'Neil");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sam O'Neil: lunch\?/);
  assert.match(r.stdout, /You: sure, noon/);
  assert.match(r.stdout, /You: reminder from the assistant/);
  assert.doesNotMatch(r.stdout, /Book Club/);
  // the user's own name does not pull in everything they wrote
  assert.match(wa("read", "Owner").stdout, /No messages found/);  // lang-regex-ok: asserts the CLI's own fixed not-found line, not user language
});

test("chats shows group subjects and the user's own activity; search labels too", () => {
  const c = wa("chats");
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /Sam O'Neil {2}You: reminder from the assistant/);
  assert.match(c.stdout, /Book Club {2}You: me/);
  const s = wa("search", "noon");
  assert.match(s.stdout, /You: sure, noon/);
});
