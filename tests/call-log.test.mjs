// call-log.test.mjs — every call the user hosts on Zoom, logged (lib/call-log.mjs).
//
// Summaries and logs of all calls, not just the recurring meetings. The fixtures
// are shaped like what Zoom returns for a call in the user's own room (a
// waiting-room record, a second join record, the host's own record, a stray
// join). Synthetic people; no network, no model.
//
// Run: node --test tests/call-log.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The owner, as lib/instance.cjs reads it (env wins over the installation's file).
process.env.JORI_OWNER_NAME = "Ann";
process.env.JORI_OWNER_ID = "ann";
process.env.JORI_OWNER_EMAIL = "ann@example.org";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CL = await import(path.join(ROOT, "lib/call-log.mjs"));
const zc = await import(path.join(ROOT, "lib/zoom-content.mjs"));
const { meetings } = await import(path.join(ROOT, "lib/meetings.mjs"));
const RECURRING = meetings({ config: { meetings: [{ id: "coach", name: "Sam", zoom: { room_id: "1234567890", participant: { names: ["samlee"] } } }] } });

const MEETING = { uuid: "xJVwJrirSW6kVZYpOrfH9g==", id: 1234567890, host_id: "HOST1", user_name: "Ann Owner",
  user_email: "ann@example.org", topic: "Ann Owner's Personal Meeting Room",
  start_time: "2026-10-23T14:31:30Z", end_time: "2026-10-23T15:16:12Z", duration: 45 };
const PARTS = [
  { id: "HOST1", name: "Ann Owner", user_email: "ann@example.org", join_time: "2026-10-23T14:31:30Z", leave_time: "2026-10-23T15:16:12Z", status: "in_meeting" },
  { id: "", name: "Rob Day", user_email: "", join_time: "2026-10-23T14:32:23Z", leave_time: "2026-10-23T14:32:43Z", status: "in_waiting_room" },
  { id: "", name: "Rob Day", user_email: "", join_time: "2026-10-23T14:32:44Z", leave_time: "2026-10-23T15:16:12Z", status: "in_meeting" },
  { id: "", name: "Stray", user_email: "", join_time: "2026-10-23T14:40:00Z", leave_time: "2026-10-23T14:40:20Z", status: "in_meeting" },
];

test("the meeting UUID comes from the email's own links, entities undone", () => {
  const html = '<a href="https://tasks.zoom.us?meetingId&#61;xJVwJrirSW6kVZYpOrfH9g%3D%3D&amp;stepId&#61;b9c3">x</a>'
    + '<a href="https://tasks.zoom.us?meetingId&#61;xJVwJrirSW6kVZYpOrfH9g%3D%3D&amp;stepId&#61;b9c4">y</a>';
  assert.deepEqual(CL.meetingUuidsFromEmail(html), ["xJVwJrirSW6kVZYpOrfH9g=="]);
  assert.deepEqual(CL.meetingUuidsFromEmail("<p>no links</p>"), []);
});

test("guests: not the host, not the waiting room, not a stray join; one row per person", () => {
  const rec = CL.callRecord(MEETING, PARTS, { recurringMeetings: RECURRING });
  assert.deepEqual(rec.guests, [{ name: "Rob Day", email: null, minutes: 43 }]);
  assert.equal(rec.recurring, null);
  assert.equal(rec.minutes, 45);
  const withSam = CL.callRecord(MEETING, [...PARTS, { name: "samlee", join_time: "2026-10-23T14:33:00Z", leave_time: "2026-10-23T15:00:00Z", status: "in_meeting" }], { recurringMeetings: RECURRING });
  assert.equal(withSam.recurring, "coach");
});

const rec = CL.callRecord(MEETING, PARTS, { recurringMeetings: RECURRING });
const candidates = [{ id: "user_robin_day", title: "Robin Day", description: "Ann's nephew" },
  { id: "user_gil_day", title: "Gil Day", description: "Ann's nephew" }];
const good = { title: "Ann demos an AI assistant", summary: "Ann showed Robin the assistant — and its wiki.",
  points: ["Local assistant versus cloud"], next_steps_ann: ["Send Robin the demo link"],
  next_steps_others: [{ who: "Robin Day", step: "Send the fund's post" }],
  people: [{ participant: "Rob Day", wiki_id: "user_robin_day", name: "Robin Day" }], language: "he" };

test("the model's log: a page it was not offered, or a participant left out, is refused", () => {
  const ctx = { rec, candidates, hasContent: true };
  assert.equal(CL.validateLog(good, ctx), null);
  assert.match(CL.validateLog({ ...good, people: [{ participant: "Rob Day", wiki_id: "user_rob_other", name: "Roy" }] }, ctx), /not offered/);
  assert.match(CL.validateLog({ ...good, people: [] }, ctx), /exactly once/);
  assert.match(CL.validateLog({ ...good, summary: "" }, ctx), /summary/);
  // no Zoom text: only the people are owed
  assert.equal(CL.validateLog({ summary: "", people: good.people }, { rec, candidates, hasContent: false }), null);
  const log = CL.cleanLog(good, rec);
  assert.equal(log.summary, "Ann showed Robin the assistant, and its wiki.");
});

const entry = { ...rec, tz: "Asia/Jerusalem", local_date: "2026-10-23", status: "logged", log: CL.cleanLog(good, rec) };

test("person and day lines: dated, linked, next steps by person, marked as Zoom's AI", () => {
  const p = CL.personLine(entry, "user_robin_day");
  assert.ok(p.startsWith("- [[day_2026-10-23|2026-10-23]] · Zoom call with Ann, 45 min · Ann demos an AI assistant."));
  assert.ok(p.includes("Next steps for Ann: Send Robin the demo link. For Robin Day: Send the fund's post."));
  assert.ok(p.endsWith(`_(${CL.AI_NOTE}.)_`));
  const d = CL.dayLine(entry);
  assert.ok(d.startsWith("- 5:31pm-6:16pm · Zoom call with [[user_robin_day|Robin Day]], 45 min"));
  const bare = CL.personLine({ ...entry, log: null }, "user_robin_day");
  assert.ok(bare.endsWith("Zoom has no summary of it."));
});

test("the marked block is replaced in place, or appended under ## Calls", () => {
  const once = CL.withBlock("# Robin\n\nNephew.\n", ["- one"]);
  assert.equal(once, "# Robin\n\nNephew.\n\n## Calls\n<!-- call-log:start -->\n- one\n<!-- call-log:end -->\n");
  const twice = CL.withBlock(once + "\n## Open\n- age\n", ["- two", "- one"]);
  assert.ok(twice.includes("<!-- call-log:start -->\n- two\n- one\n<!-- call-log:end -->\n\n## Open"));
  assert.equal(twice.split("## Calls").length, 2);
});

test("daily summary: the day's logged calls, never a recurring meeting's, never one already listed", () => {
  const coach = { ...entry, uuid: "REC", recurring: "coach", status: "recurring", start: "2026-10-23T20:00:00Z", end: "2026-10-23T20:30:00Z" };
  const store = { calls: { [entry.uuid]: entry, REC: coach } };
  const got = CL.callsForSummary(store, { date: "2026-10-23", tz: "Asia/Jerusalem" });
  assert.equal(got.length, 1);
  assert.equal(got[0].who, "Robin Day");
  assert.equal(got[0].who_md, "[[user_robin_day|Robin Day]]");
  assert.deepEqual(got[0].talk_points, ["Local assistant versus cloud"]);
  assert.equal(got[0].ai_note, "from Zoom's AI summary");
  // same UUID already on the list (a meeting's ladder), or an overlapping call: left out
  const listed = [{ start: entry.start, end: entry.end, evidence: { zoom: { instances: [{ uuid: entry.uuid }] } } }];
  assert.equal(CL.callsForSummary(store, { date: "2026-10-23", tz: "Asia/Jerusalem", existing: listed }).length, 0);
  const overlapping = [{ start: "2026-10-23T15:00:00Z", end: "2026-10-23T15:30:00Z" }];
  assert.equal(CL.callsForSummary(store, { date: "2026-10-23", tz: "Asia/Jerusalem", existing: overlapping }).length, 0);
  // the local day decides: 14:31Z is still Oct 23 four hours behind UTC
  assert.equal(CL.callsForSummary(store, { date: "2026-10-22", tz: "America/New_York" }).length, 0);
});

test("callContent: the call log reads the summary first; the default order is unchanged", async () => {
  const client = { token: async () => ({ token: "t", base: "https://api.zoom.us" }) };
  const seen = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => "" });
  const fetchImpl = async (url) => {
    seen.push(url.endsWith("/recordings") ? "recordings" : "summary");
    return url.endsWith("/recordings") ? res(404, { code: 3301 }) : res(200, { summary_overview: "They talked." });
  };
  const got = await zc.callContent(client, ["u1"], { fetchImpl, order: ["summary", "transcript"] });
  assert.equal(got.kind, "summary");
  assert.deepEqual(seen, ["summary"]);
  seen.length = 0;
  await zc.callContent(client, ["u1"], { fetchImpl });
  assert.deepEqual(seen, ["recordings", "summary"]);
});

test("model text is one line and can never carry our block markers", () => {
  const log = CL.cleanLog({ ...good, summary: "Line one.\nLine two <!-- call-log:end --> done." }, rec);
  assert.equal(log.summary, "Line one. Line two call-log:end done.");
});

test("a log written from the transcript says so", () => {
  const t = { ...entry, source: "transcript" };
  assert.ok(CL.personLine(t, "user_robin_day").includes("Zoom's automatic transcript"));
  const [call] = CL.callsForSummary({ calls: { [t.uuid]: t } }, { date: "2026-10-23", tz: "Asia/Jerusalem" });
  assert.equal(call.ai_note, "from Zoom's transcript");
  assert.equal(call.talk_source, "zoom-transcript");
});
