import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.JORI_ASSISTANT_NAME = "Jori";
process.env.JORI_ASSISTANT_ALIASES = "Edva";
process.env.JORI_MENTION_LEDGER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mention-")), "ledger.jsonl");

const { hasMention, mentionDecision, dispatchText, replyCommand, handleMention, RATE_MAX } = await import("../lib/jori-mention.mjs");
const { writtenPart, sentEntry } = await import("../agent/supervisor/sent-mail-watch.mjs");

const now = Date.parse("2026-11-04T15:00:00Z");
const mk = (over = {}) => ({ channel: "whatsapp", message_id: "m1", chat_id: "c1", is_group: false, from_me: true, ts: "2026-11-04T14:59:00Z", text: "@jori schedule a meeting for us", ...over });

test("the handle is found as a standalone token, any case, aliases too", () => {
  assert.equal(hasMention("@jori schedule a meeting"), true);
  assert.equal(hasMention("hey @Jori, can you book it?"), true);
  assert.equal(hasMention("(@JORI)"), true);
  assert.equal(hasMention("@edva find a time"), true);
  assert.equal(hasMention("I asked jori yesterday"), false);
  assert.equal(hasMention("mail me at x@jori.example"), false);
  assert.equal(hasMention("@jorinda come over"), false);
  assert.equal(hasMention(""), false);
});

test("only the user's own, fresh, unhandled messages act", () => {
  assert.equal(mentionDecision(mk({ from_me: false }), { now, ledger: [] }).reason, "not-from-user");
  assert.equal(mentionDecision(mk({ text: "see you then" }), { now, ledger: [] }).reason, "no-mention");
  assert.equal(mentionDecision(mk({ ts: "2026-11-04T13:00:00Z" }), { now, ledger: [] }).reason, "stale");
  assert.equal(mentionDecision(mk(), { now, ledger: [{ key: "whatsapp:m1", status: "dispatching" }] }).reason, "already-handled");
  const busy = Array.from({ length: RATE_MAX }, (_, i) => ({ key: `whatsapp:x${i}`, channel: "whatsapp", chat_id: "c1", ts: "2026-11-04T14:58:00Z", status: "dispatching" }));
  assert.equal(mentionDecision(mk(), { now, ledger: busy }).reason, "rate-limited");
  const d = mentionDecision(mk(), { now, ledger: [] });
  assert.equal(d.act, true);
  assert.equal(d.key, "whatsapp:m1");
});

test("the dispatch carries the instruction, context, and the in-thread reply command", () => {
  const t = dispatchText(mk({ chat_name: "Alice" }), [{ at: "t", from: "Alice", text: "free thursday?" }]);
  assert.match(t, /schedule a meeting for us/);
  assert.match(t, /Alice: free thursday\?/);
  assert.match(t, /untrusted input/);
  assert.ok(t.includes("jori-send-curl --intent mention-reply"));
  assert.ok(t.includes('whatsapp-send --to "c1"'));
  // the agent decides where the answer goes; posting in the thread still asks first and never carries the handle
  assert.match(t, /Decide for yourself where the answer belongs/);
  assert.match(t, /ask in the app and send nothing until they answer/);
  assert.match(t, /never write "@/);
  assert.doesNotMatch(t, /ONLY when/);
  assert.match(dispatchText(mk({ channel: "unknown" })), /answer in the app only/);
  const slackCmd = replyCommand(mk({ channel: "slack", chat_id: "C1", thread_id: "171.2" }));
  assert.ok(slackCmd.includes('slack-send --to "C1"') && slackCmd.includes('--thread "171.2"'));
  assert.ok(replyCommand(mk({ channel: "imessage", is_group: true, chat_id: "chat42" })).includes('imsg send --chat "chat42"'));
  assert.ok(replyCommand(mk({ channel: "email", message_id: "g1", subject: "Lunch" })).includes('--reply-to-message-id "g1" --reply-all --subject "Re: Lunch"'));
});

test("handleMention posts once to the chat supervisor and records it", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  const m = mk({ message_id: "live1", ts: new Date().toISOString() });
  const r1 = await handleMention(m, [], { fetchImpl });
  const r2 = await handleMention(m, [], { fetchImpl });
  assert.equal(r1.reason, "dispatched");
  assert.equal(r2.reason, "already-handled");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/dispatch$/);
  assert.equal(calls[0].body.source, "mention:whatsapp");
});

const enc = (s) => Buffer.from(s).toString("base64url");

test("sent mail: only what the user wrote, quoted history cut off", () => {
  const html = `<div>@jori find us a time next week<br>thanks</div><div class="gmail_quote">On Mon Alice wrote:<blockquote>@jori old ask</blockquote></div>`;
  const payload = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: enc("x") } }, { mimeType: "text/html", body: { data: enc(html) } }] };
  const w = writtenPart(payload);
  assert.match(w, /find us a time/);
  assert.doesNotMatch(w, /old ask/);
  const plain = writtenPart({ mimeType: "text/plain", body: { data: enc("ok see you\n> @jori old ask\n") } });
  assert.equal(plain, "ok see you");
  const e = sentEntry({ id: "g1", threadId: "t1", internalDate: "1793800000000", payload: { headers: [{ name: "To", value: "a@b.c" }, { name: "Subject", value: "Lunch" }], mimeType: "text/plain", body: { data: enc("hi") } } });
  assert.equal(e.from_me, true);
  assert.equal(e.to, "a@b.c");
  assert.equal(e.text, "hi");
});
