// day-statements-chat-window.test.mjs — day-statements reads the day's own chat,
// not the previous day's, and never Jori's own notices.
//
// 2026-10-22, Old Port: the chat window began at 00:00 UTC the day before, so the
// Oct 22 read included all of Oct 21 from 03:00 local. The user's 11:34 Oct 21 answer
// "hilton hotel for the AI conference" came back as an Oct 22 place, and the
// review flagged "Hilton Seaside City, which you mentioned, is not in the summary"
// for a day the user never went there. The improvements-channel notices of the Oct 21
// fix loop, which quote that answer, were read as the user's conversation too.
//
// Run: node --test tests/day-statements-chat-window.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chatWindow, chatText } = require(path.join(ROOT, "bin/day-statements"));

test("an Israel day is read from its own midnight to the end of the next day", () => {
  const w = chatWindow("2026-10-22", "Asia/Jerusalem");
  assert.equal(w.start, "2026-10-21T21:00:00.000Z");   // 00:00 Oct 22 in Old Port
  assert.equal(w.end, "2026-10-23T21:00:00.000Z");     // 24:00 Oct 23 in Old Port
  // the user's Oct 21 answer at 11:34 local (08:34Z) is outside it
  assert.ok("2026-10-21T08:34:50Z" < w.start);
});

test("a home day starts at its own midnight, not the previous UTC day", () => {
  const w = chatWindow("2026-10-22", "America/New_York");
  assert.equal(w.start, "2026-10-22T04:00:00.000Z");
  assert.equal(w.end, "2026-10-24T04:00:00.000Z");
});

const rows = [
  { role: "assistant", channel: "improvements", created_at: "2026-10-22T01:45:01Z",
    content: "🔧 [dsfix-2026-10-21] On Oct 21 you answered the 10:30 question with 'hilton hotel for the AI conference'" },
  { role: "assistant", channel: "system", created_at: "2026-10-22T02:00:00Z", content: "⚠️ something" },
  { role: "assistant", channel: "chat", created_at: "2026-10-22T03:00:00Z",
    metadata: { question_id: "dsf:2026-10-21:2" }, content: "📝 Fixing your Wednesday summary: were you at the Hilton?" },
  { role: "user", channel: "chat", created_at: "2026-10-22T03:05:00Z", content: "yes, for the conference" },
  { role: "assistant", channel: "chat", created_at: "2026-10-22T04:00:00Z",
    metadata: { question_id: "dsf:2026-10-22:1" }, content: "📝 Fixing your Thursday summary: was Nurit at Nana's?" },
  { role: "user", channel: "chat", created_at: "2026-10-22T15:09:00Z",
    content: "Picking up Alex at the airport now (all of us incl. Rover) then driving to Nana" },
  { role: "assistant", created_at: "2026-10-22T15:10:00Z", content: "Safe travels" },
];

test("only chat-channel rows reach the model", () => {
  const text = chatText(rows, "2026-10-22", "Asia/Jerusalem");
  assert.ok(!text.includes("dsfix-2026-10-21"));
  assert.ok(!text.includes("something"));
  assert.ok(text.includes("Picking up Alex at the airport now"));
  assert.ok(text.includes("Safe travels"), "a row with no channel is kept");
  assert.equal(text.split("\n").length, 5);
});

test("a fix-loop question about another day says which day", () => {
  const lines = chatText(rows, "2026-10-22", "Asia/Jerusalem").split("\n");
  assert.ok(lines[0].includes("jori (asking about 2026-10-21): 📝 Fixing your Wednesday summary"));
  assert.ok(lines[1].includes("USER: yes, for the conference"));
  // a question about this day is an ordinary jori line
  assert.ok(lines[2].includes("] jori: 📝 Fixing your Thursday summary"));
});

test("times are shown in the day's own zone", () => {
  const lines = chatText(rows, "2026-10-22", "Asia/Jerusalem").split("\n");
  assert.ok(lines[3].startsWith("[22/10, 18:09] USER:"));
});
