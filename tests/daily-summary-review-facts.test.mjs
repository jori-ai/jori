// daily-summary-review-facts.test.mjs — the reviewer is shown each fact the way
// the report prints it. 2026-10-20: the report's "· due 2026-10-22" on a closed
// task and "still pending" on a card charge were both in the records, but the
// fact sheet carried neither, so the reviewer called them invented.
//
// Run: node --test tests/daily-summary-review-facts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = require(path.join(ROOT, "lib/daily-summary-review.js"));

const pack = (manifest) => R.factPack({ date: "2026-10-20", manifest: { stops: [], ...manifest },
  day: { path: { tz: "Asia/Jerusalem" } }, statements: {}, corrections: [] });

test("a closed task carries its due date and list when the report prints them", () => {
  const text = pack({ tasks_completed: [
    { completed_at: "18:15", title: "review RLI umbrella requirements", list: "My Tasks", due: "2026-10-20" },
    { completed_at: "19:45", title: "review policy jacket, decide on umbrella", list: "My Tasks", due: "2026-10-22" },
    { completed_at: "20:00", title: "Call the pool guy", list: "Villa Example" },
  ] });
  assert.ok(text.includes("18:15 review RLI umbrella requirements;"), text);   // due on the day: not printed
  assert.ok(text.includes("19:45 review policy jacket, decide on umbrella · due 2026-10-22"), text);
  assert.ok(text.includes("20:00 Call the pool guy · Villa Example"), text);
});

test("a charge the bank still lists as pending says so", () => {
  const text = pack({ standout_transactions: [
    { merchant: "Pinch A Penny Pool Patio Spa", amount_usd: "$278.19", pending: true, stop_id: null },
    { merchant: "Example Air", amount_usd: "$630", pending: false, stop_id: "s-1" },
  ] });
  assert.ok(text.includes("Pinch A Penny Pool Patio Spa $278.19 (pending at the bank) (no stop)"), text);
  assert.ok(text.includes("Example Air $630") && !text.includes("Example Air $630 (pending"), text);
});

// 2026-10-23: the user's 7:35am "At the Asufa shop ..." answered Jori's 4:32am
// question about Thursday's summary. Shown alone it read as a Friday stop, and
// the review demanded a 7:35am shop visit while the user's phone sat at the flat.
test("a message that opens an exchange shows what Jori had last said to the user", () => {
  const text = pack({ harvest: {
    window: { start: "2026-10-22T21:00:00.000Z", end: "2026-10-23T21:00:00.000Z" },
    orphan_facts: [
      { kind: "chat", role: "assistant", at: "2026-10-23T01:32:17Z", text: "Fixing your Thursday, October 22 summary: were you and Sam browsing in Asufa?" },
      { kind: "chat", role: "user", at: "2026-10-23T04:35:09Z", text: "At the Asufa shop to get cards" },
      { kind: "chat", role: "assistant", at: "2026-10-23T04:35:10Z", text: "Got it, Asufa it was." },
      { kind: "chat", role: "user", at: "2026-10-23T04:40:00Z", text: "Thanks" },
    ],
  } });
  assert.ok(text.includes('- 7:35am: "At the Asufa shop to get cards"\n    (Jori had said at 4:32am: "Fixing your Thursday, October 22 summary'), text);
  // Mid-exchange, the user's own previous line is the context: no Jori line under "Thanks".
  assert.ok(text.includes('- 7:40am: "Thanks"') && !text.includes('(Jori had said at 7:35am'), text);
});

// A reply made with the app's Reply action carries `reply_to`. Three other pings
// came between the question (sent between two stops) and the user's answer, so the last
// two Jori lines did not include it, and the user's answer about another day read as
// being about the stop the user sent it during.
test("a reply made with Reply shows the Jori message it answers, however much earlier", () => {
  const text = pack({ harvest: {
    window: { start: "2026-10-19T21:00:00.000Z", end: "2026-10-20T21:00:00.000Z" },
    facts_by_leg: [{ facts: [
      { kind: "chat", role: "assistant", id: "q1", at: "2026-10-20T16:05:00Z", text: "What drew you to the museum last week: the building or an exhibition?" },
    ] }],
    facts_by_stop: { "s-2": [
      { kind: "chat", role: "assistant", id: "g2", at: "2026-10-20T16:20:00Z", text: "Dinner is in about 25 minutes." },
      { kind: "chat", role: "assistant", id: "g3", at: "2026-10-20T16:31:00Z", text: "A history note about the street you are on." },
      { kind: "chat", role: "assistant", id: "g4", at: "2026-10-20T16:45:00Z", text: "Your call moved half an hour earlier." },
      { kind: "chat", role: "user", id: "u1", reply_to: "q1", at: "2026-10-20T16:53:00Z", text: "The building. We took a tour." },
    ] },
  } });
  assert.ok(text.includes('- 7:53pm [during s-2]: "The building. We took a tour."\n'
    + '    (the user sent this with Reply on Jori\'s message of 7:05pm: "What drew you to the museum last week'), text);
  // The time-gap context is still shown, after the message the user replied to.
  assert.ok(text.includes('    (Jori had said at 7:45pm: "Your call moved half an hour earlier.")'), text);
});

test("a reply whose question is also the last Jori line is shown once, as the reply", () => {
  const text = pack({ harvest: {
    window: { start: "2026-10-19T21:00:00.000Z", end: "2026-10-20T21:00:00.000Z" },
    orphan_facts: [
      { kind: "chat", role: "assistant", id: "q1", at: "2026-10-20T16:05:00Z", text: "Was that the bakery?" },
      { kind: "chat", role: "user", id: "u1", reply_to: "q1", at: "2026-10-20T16:53:00Z", text: "Yes" },
      { kind: "chat", role: "user", id: "u2", reply_to: "gone", at: "2026-10-20T17:53:00Z", text: "No, the day before" },
    ],
  } });
  assert.ok(text.includes("(the user sent this with Reply on Jori's message of 7:05pm: \"Was that the bakery?\")"), text);
  assert.ok(!text.includes('(Jori had said at 7:05pm: "Was that the bakery?")'), text);
  assert.ok(text.includes('- 8:53pm: "No, the day before"\n    (the user sent this with Reply on a Jori message from outside this day)'), text);
});

test("a message sent between two stops is in the user's words, and Jori's lines are never the user's", () => {
  const text = pack({ harvest: {
    window: { start: "2026-10-22T21:00:00.000Z", end: "2026-10-23T21:00:00.000Z" },
    facts_by_leg: [{ from: "s-1", to: "s-2", facts: [
      { kind: "chat", role: "user", at: "2026-10-23T05:47:57Z", text: "Now going to Falafel Example to get bourekas" },
    ] }],
    facts_by_stop: { "s-2": [{ kind: "chat", role: "assistant", at: "2026-10-23T05:49:00Z", text: "Lovely start to the day" }] },
  } });
  assert.ok(text.includes('- 8:47am: "Now going to Falafel Example to get bourekas"'), text);
  assert.ok(!text.includes('- 8:49am: "Lovely start'), text);
});

// 2026-10-24: the fix loop recorded the user's threaded "Just Alex" (to "Were you
// dropping Alex and Noa off at Nana's?") as a correction with a window and a
// reading. The review was shown the bare words only, so its repair cut the
// drop-off at Nana's from the prose as unsupported.
test("a correction shows the stretch it is about and the reading recorded with it", () => {
  const text = R.factPack({ date: "2026-10-23", manifest: { stops: [] }, day: { path: { tz: "Asia/Jerusalem" } },
    statements: {}, corrections: [
      { said_at: "2026-10-24T04:27:00.624Z", channel: "chat", text: "Just Alex",
        applies_from: "2026-10-23T22:11:00+03:00", applies_to: "2026-10-23T23:08:00+03:00",
        reading: "The user's threaded reply to 'Were you dropping Alex and Noa off at Nana's?': they dropped only Alex at Nana's." },
      { said_at: "2026-10-11T08:00:00Z", text: "The 7am also had a coffee stop" },
    ] });
  assert.ok(text.includes(`- chat, about 10:11pm-11:08pm: "Just Alex" Jori's reading: The user's threaded reply to 'Were you dropping Alex and Noa off at Nana's?'`), text);
  // An emailed correction with no window or reading still reads as before, in the user's words.
  assert.ok(text.includes(`- email: "The 7am also had a coffee stop"`) && !text.includes(`coffee stop" Jori's reading`), text);
});

test("a call's printed points are in the fact sheet, and an in-stop call drops its place", () => {
  // 2026-10-24: the Ezra call printed six points from Zoom's summary; the sheet
  // carried only the paragraph, so the reviewer called four of them invented.
  const text = pack({ calls: [{
    who: "Ezra Dagan", local_time: "5:31pm-6:16pm", minutes: 45, status: "held", source: "zoom",
    line: "5:31pm-6:16pm · Call with Ezra Dagan · ran 45 min · at The Old Port Airbnb · from Zoom's AI summary",
    talk: "The user showed Ezra the assistant.", talk_source: "zoom-ai-summary",
    talk_points: ["Local versus cloud agent costs", "", "Semantic search"],
  }, { who: "Quinn", local_time: "11:00pm-11:30pm", status: "held", source: "zoom", line: "11:00pm-11:30pm · Call with Quinn", talk: "You talked." }] });
  assert.ok(text.includes("POINTS (same record): Local versus cloud agent costs | Semantic search"), text);
  assert.ok(text.includes("listed under that stop without its 'at <place>'"), text);
  assert.ok(text.includes("prints those as sub-bullets instead of the paragraph"), text);
  assert.equal((text.match(/POINTS \(same record\)/g) || []).length, 1, text);   // lang-regex-ok: counts our own fact label
});
