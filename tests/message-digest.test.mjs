// message-digest: conversation grouping, batching, stubbed model, meeting topics file match.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { conversations, batches, buildDayDigest, meetingTopicsFor, meetingTopicsPrompt, digestPrompt, renderMarkdown } from "../lib/message-digest.mjs";
import { composeReminder, chatTopicsBlock } from "../lib/meeting-reminder.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "message-digest");
const TZ = "Europe/Lisbon";
const at = (m) => new Date(Date.parse("2026-10-28T14:00:00Z") + m * 60000).toISOString();
const fact = (o) => ({ channel: "slack", chat: "#ops", chat_id: "C1", is_group: true, from_me: false, who: "Leslie", text: "x", at: at(0), ...o });

test("facts group by channel+chat, busiest first, the owner's lines labelled with the owner's name", () => {
  const c = conversations([fact({}), fact({ at: at(1), from_me: true }), fact({ channel: "imessage", chat: "Robin", chat_id: "p", is_group: false })], "Sam");
  assert.equal(c[0].key, "slack:C1");
  assert.equal(c[0].lines[1].who, "Sam");
  assert.equal(c[1].is_group, false);
});

test("batches split by size and keep each key", () => {
  const big = conversations(Array.from({ length: 40 }, (_, i) => fact({ chat_id: `C${i}`, chat: `#c${i}`, text: "y".repeat(280) })));
  const b = batches(big, TZ, 2000);
  assert.ok(b.length > 1);
  assert.equal(b.flat().length, 40);
});

test("buildDayDigest maps model summaries back by key; unanswered keys are flagged", async () => {
  const sources = { imessage: () => [{ channel: "imessage", ms: Date.parse(at(5)), chat_id: "p", chat: "Robin", is_group: false, from_me: false, who: "Robin", text: "dinner at 8?" }],
    whatsapp: () => [], slack: () => [{ channel: "slack", ms: Date.parse(at(6)), chat_id: "C1", chat: "#ops", is_group: true, from_me: false, who: "Leslie", text: "deploy done" }] };
  const ask = async () => ({ conversations: [{ key: "imessage:p", summary: "Robin asked about dinner at 8.", needs_you: true }] });
  const dayWindow = () => ({ startMs: Date.parse("2026-10-28T00:00:00Z"), endMs: Date.parse("2026-10-29T00:00:00Z"), start: "s", end: "e" });
  const d = await buildDayDigest({ date: "2026-10-28", tz: TZ, dayWindow, ask, sources });
  const robin = d.conversations.find((c) => c.chat === "Robin");
  assert.equal(robin.summary, "Robin asked about dinner at 8.");
  assert.equal(robin.needs_you, true);
  assert.equal(d.conversations.find((c) => c.chat === "#ops").unsummarized, true);
  assert.ok(renderMarkdown(d).includes("**Robin** (iMessage) · needs you"));
});

test("prompts name the owner and the meeting's counterpart, never a fixed person", () => {
  const convs = conversations([fact({})], "Sam");
  const p = meetingTopicsPrompt({ convs, tz: TZ, owner: "Sam", with: "Dana", context: "they run a bakery together", agenda: ["oven repair"] });
  assert.ok(p.startsWith("Sam has a regular call with Dana (they run a bakery together) shortly."));
  assert.ok(p.includes('"oven repair"'));
  assert.ok(digestPrompt([{ key: "k", text: "t" }], "Sam").includes('lines from "Sam"'));
});

test("meeting topics only for the matching call, appended after the agenda", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ot-")), "t.json");
  fs.writeFileSync(f, JSON.stringify({ call_epoch: 100, topics: [{ topic: "Pricing change for Acme", from: "#sales" }] }));
  assert.equal(meetingTopicsFor(100, f).length, 1);
  assert.deepEqual(meetingTopicsFor(200, f), []);
  assert.equal(chatTopicsBlock([]), "");
  const r = composeReminder({ name: "Dana", kind: "meeting_agenda:dana", hhmm: "16:00", state: null, notesText: "## To Discuss\n- item one\n", tz: TZ, dates: null, chatTopics: [{ topic: "Pricing change for Acme", from: "#sales" }] });
  assert.ok(r.text.endsWith("From the group chats:\n- Pricing change for Acme (#sales)"));
  assert.ok(r.checklist);
});

test("topics with no meeting configured is off: says so, exits 0, writes nothing", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "md-local-"));
  const r = spawnSync(process.execPath, [BIN, "topics", "--dry-run"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: local } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no recurring meeting configured/);
});
