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

// A place-less calendar block a stop held from start to end is printed under the
// stop as "on your calendar" (manifest `calendar_held`). The fact sheet left it
// out, so the reviewer saw the line with no event behind it and called it invented.
test("a calendar block held inside a stop is on the stop's fact line", () => {
  const text = pack({ stops: [
    { id: "s-1", start: "19:07", end: "20:57", title: "The Flat", companions: ["Sam"],
      calendar_event: null, calendar_held: { summary: "Pack", start: "2026-10-20T19:30:00+03:00", end: "2026-10-20T20:30:00+03:00" } },
    { id: "s-2", start: "21:00", end: "22:00", title: "Elsewhere", companions: [], calendar_event: null, calendar_held: null },
  ] });
  const line1 = text.split("\n").find((l) => l.startsWith("- s-1:"));
  const line2 = text.split("\n").find((l) => l.startsWith("- s-2:"));
  assert.ok(line1.includes('calendar block held inside this stop') && line1.includes('"Pack" 2026-10-20T19:30:00+03:00 to 2026-10-20T20:30:00+03:00'), line1);
  assert.ok(!line2.includes("calendar block held"), line2);
});

// 2026-11-07: the movement totals said "walked 4.2 mi" against "all travel 6.6 km" and
// nothing about the walk lines printed under stops, whose distance is the step counter's
// estimate and which the travel totals do not hold. The reviewer called it impossible.
test("the reviewer's movement totals say the walk lines under stops are step estimates", () => {
  const at = (min) => Date.parse("2026-11-07T13:00:00Z") + min * 60000;
  const stops = [
    { id: "s-a", start: "09:00", end: "10:00", start_ts_ms: at(0), end_ts_ms: at(60), duration_min: 60,
      place: { name: "A", source: "user_confirmed" }, tz: "UTC" },
    { id: "s-b", start: "10:20", end: "11:50", start_ts_ms: at(80), end_ts_ms: at(170), duration_min: 90,
      place: { name: "B", source: "user_confirmed" }, tz: "UTC" },
  ];
  const legs = [{ type: "leg", id: "l0", mode: "walking", start_ms: at(60), end_ms: at(80), walked_m: 1000, routed_m: 1000, steps: 1500 }];
  const day = {
    date: "2026-11-07", tz: "UTC", stops,
    path: { tz: "UTC", spine: legs, stats: { observed_km: 1.0, inferred_km: 0, matched_km: 1.0 } },
    steps: { walks: [{ kind: "in_stop", stop_id: "s-b", start_ms: at(100), end_ms: at(120), mins: 20, steps: 2000 }] },
  };
  const text = R.factPack({ date: "2026-11-07", manifest: { stops: [] }, day, statements: {}, corrections: [] });
  assert.match(text, /also includes about 1\.3 km estimated from step counts/, text);
  const none = R.factPack({ date: "2026-11-07", manifest: { stops: [] },
    day: { ...day, steps: { walks: [] } }, statements: {}, corrections: [] });
  assert.doesNotMatch(none, /estimated from step counts/, none);
});

// 2026-11-11: the report's prose and Messages lines are written from the day's phone
// chats and the digest that summarises every conversation, but the fact sheet held only
// the user's own chat with the assistant. A line restating what a relative sent (photos
// in the family chat, a comment on one) had nothing to be checked against, and the
// reviewer called it invented on one pass and passed it on the next.
const phoneDay = (extra = {}) => ({ harvest: {
  window: { start: "2026-10-19T21:00:00.000Z", end: "2026-10-20T21:00:00.000Z" },
  facts_by_stop: { "s-1": [
    { kind: "message", channel: "imessage", at: "2026-10-20T10:00:00Z", chat: "Family chat", is_group: true, from_me: false, who: "Sam", text: "[image] [image] [image]" },
    { kind: "message", channel: "imessage", at: "2026-10-20T10:04:00Z", chat: "Family chat", is_group: true, from_me: false, who: "Alex", text: "That's a funny slide :)" },
    { kind: "message", channel: "slack", at: "2026-10-20T10:05:00Z", chat: "#ops-alerts", is_group: true, from_me: false, who: "Bot", text: "disk usage warning" },
  ] },
  facts_by_leg: [{ facts: [
    { kind: "message", channel: "imessage", at: "2026-10-20T10:09:00Z", chat: "Family chat", is_group: true, from_me: true, who: "me", text: "I see the joke worked" },
  ] }],
  orphan_facts: [
    // the same message twice (a stop and the orphan list): shown once
    { kind: "message", channel: "imessage", at: "2026-10-20T10:04:00Z", chat: "Family chat", is_group: true, from_me: false, who: "Alex", text: "That's a funny slide :)" },
    { kind: "message", channel: "whatsapp", at: "2026-10-20T11:00:00Z", chat: "Book club", is_group: true, from_me: false, who: "Dana", text: "Meeting moved to Thursday" },
    // another day
    { kind: "message", channel: "imessage", at: "2026-10-21T10:00:00Z", chat: "Family chat", is_group: true, from_me: false, who: "Sam", text: "tomorrow's message" },
  ],
  ...extra } });

test("the day's iMessage and WhatsApp messages are in the fact sheet, from both sides, once each, and Slack is not listed", () => {
  const text = pack(phoneDay());
  assert.ok(text.includes("MESSAGES IN THE USER'S PHONE CHATS THAT DAY"), text);
  assert.ok(text.includes('- 1:00pm Family chat (group), Sam: "[image] [image] [image]"'), text);
  assert.ok(text.includes('- 1:04pm Family chat (group), Alex: "That\'s a funny slide :)"'), text);
  assert.ok(text.includes('- 1:09pm Family chat (group), sent from the user\'s account: "I see the joke worked"'), text);
  assert.ok(text.includes('- 2:00pm Book club (group), Dana: "Meeting moved to Thursday"'), text);
  assert.equal(text.split("That's a funny slide").length - 1, 1, "the repeated message is shown once");
  assert.ok(!text.includes("disk usage warning"), "a work channel is not listed message by message");
  assert.ok(!text.includes("tomorrow's message"), "another day's message is left out");
});

test("a long day of phone messages is capped and says how many are not shown", () => {
  const many = Array.from({ length: 95 }, (_, i) => ({ kind: "message", channel: "imessage",
    at: new Date(Date.parse("2026-10-20T06:00:00Z") + i * 60000).toISOString(), chat: "Pal", is_group: false, from_me: false, who: "Pal", text: `note ${i}` }));
  const text = pack({ harvest: { window: { start: "2026-10-19T21:00:00.000Z", end: "2026-10-20T21:00:00.000Z" }, orphan_facts: many } });
  assert.ok(text.includes('"note 79"') && !text.includes('"note 80"'), text);
  assert.ok(text.includes("(15 more not shown)"), text);
});

test("the conversation summaries list phone chats first, then work channels that wanted the user, and skip empty ones", () => {
  const text = pack({ harvest: { message_digest: { conversations: [
    { channel: "slack", chat: "#general", is_group: true, messages: 90, summary: "Company news.", needs_you: false },
    { channel: "slack", chat: "#deals", is_group: true, messages: 5, summary: "A deal closed; kickoff tomorrow.", needs_you: true },
    { channel: "imessage", chat: "Family chat", is_group: true, messages: 12, summary: "Sam shared photos of the talk; Alex liked one slide.", needs_you: false },
    { channel: "whatsapp", chat: "Quiet group", is_group: true, messages: 3, summary: "   ", needs_you: false },
  ] } } });
  const at = (s) => text.indexOf(s);
  assert.ok(at("THE DAY'S CONVERSATIONS, SUMMARISED") > 0, text);
  assert.ok(at("- imessage Family chat (group): Sam shared photos") < at("- slack #deals (group) [open for the user]: A deal closed"), text);
  assert.ok(at("- slack #deals") < at("- slack #general (group): Company news."), text);
  assert.ok(!text.includes("Quiet group"), "a conversation with no summary is skipped");
});

test("the conversation summaries stop at a fixed length", () => {
  const conversations = Array.from({ length: 60 }, (_, i) => ({ channel: "imessage", chat: `Chat ${i}`, is_group: false, messages: 60 - i,
    summary: "x".repeat(300) }));
  const text = pack({ harvest: { message_digest: { conversations } } });
  const shown = text.split("\n").filter((l) => /^- imessage Chat \d+:/.test(l));
  assert.ok(shown.length > 10 && shown.length < 60, `shown ${shown.length}`);
  assert.ok(shown.reduce((n, l) => n + l.length, 0) < 8200);
  assert.ok(text.includes("- imessage Chat 0:") && !text.includes("- imessage Chat 59:"));
});

test("JORI_REVIEW_PHONE_MESSAGES=0 leaves the phone chats and the summaries out", () => {
  const old = process.env.JORI_REVIEW_PHONE_MESSAGES;
  process.env.JORI_REVIEW_PHONE_MESSAGES = "0";
  try {
    const text = pack(phoneDay({ message_digest: { conversations: [{ channel: "imessage", chat: "Family chat", summary: "Photos shared." }] } }));
    assert.ok(!text.includes("PHONE CHATS") && !text.includes("SUMMARISED") && !text.includes("funny slide"), text);
  } finally {
    if (old == null) delete process.env.JORI_REVIEW_PHONE_MESSAGES; else process.env.JORI_REVIEW_PHONE_MESSAGES = old;
  }
});
