// morning-digest.test.mjs — the code half of the morning brief.
//
// The calendar test is a real bug as a fixture: a car-rental pickup at 23:45
// Eastern on Aug 12 came back from the API as 05:45+02:00 (the calendar's
// stale European default) and was read as a same-day 5:45 AM event.
// Converting the INSTANT into the user's timezone in code makes that impossible.
//
// Run: node --test tests/morning-digest.test.mjs

// A made-up installation (its agent address is the "own mail" left out).
import { SYNTHETIC } from "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarToday, bucketTasks, render, ymdIn, overnightRows, mailText, senderName } from "../lib/morning-digest.mjs";

test("calendar: instants are converted into the user's tz; a stale-offset event lands on the right day", () => {
  const items = [
    { summary: "Car pickup", start: { dateTime: "2026-08-13T05:45:00+02:00" } }, // = 23:45 ET Aug 12
    { summary: "Lunch", start: { dateTime: "2026-08-13T12:30:00-04:00" } },
    { summary: "Holiday", start: { date: "2026-08-13" }, end: { date: "2026-08-14" } },
    { summary: "Gone", status: "cancelled", start: { dateTime: "2026-08-13T09:00:00-04:00" } },
  ];
  const got = calendarToday(items, "America/New_York", "2026-08-13");
  assert.deepEqual(got.map((e) => e.title), ["Holiday", "Lunch"]);
  assert.equal(got[1].time, "12:30 PM");
  const prev = calendarToday(items, "America/New_York", "2026-08-12");
  assert.deepEqual(prev.map((e) => [e.title, e.time]), [["Car pickup", "11:45 PM"]]);
});

test("calendar: same instant, different tz → different local day", () => {
  const items = [{ summary: "Call", start: { dateTime: "2026-10-05T01:00:00Z" } }];
  assert.equal(calendarToday(items, "America/New_York", "2026-10-04").length, 1);
  assert.equal(calendarToday(items, "Europe/Athens", "2026-10-05").length, 1);
  assert.equal(ymdIn("Europe/Athens", new Date("2026-10-04T22:00:00Z")), "2026-10-05");
});

test("tasks bucket by due date; completed and undated ignored", () => {
  const b = bucketTasks([
    { title: "old", due: "2026-10-01T00:00:00.000Z" },
    { title: "now", due: "2026-10-04T00:00:00.000Z" },
    { title: "next", due: "2026-10-05T00:00:00.000Z" },
    { title: "later", due: "2026-10-09T00:00:00.000Z" },
    { title: "done", due: "2026-10-04T00:00:00.000Z", status: "completed" },
    { title: "nodue" },
  ], "2026-10-04");
  assert.deepEqual(b, { overdue: ["old"], today: ["now"], tomorrow: ["next"] });
});

test("render: fixed sections, unreadable inbox says so, picks resolve by index", () => {
  const packet = {
    today: "2026-10-04", city: "Springfield", metro: "springfield",
    calendar: [], tasks: { overdue: [], today: [], tomorrow: [] }, overnight_mail: null,
    news: { world: [{ i: 0, title: "W0", summary: "s", url: "https://x/0" }, { i: 1, title: "W1", summary: "", url: null }], business: [], local: [] },
    weather: "High 70", events: [],
  };
  const html = render(packet, { overnight: null, news: { world: [1] }, events: [] });
  for (const h of ["CALENDAR", "TASKS", "OVERNIGHT EMAIL", "NEWS", "WEATHER (Springfield)", "EVENTS &amp; FESTIVALS"]) assert.ok(html.includes(h), h);
  assert.ok(html.includes("No events today"));
  assert.ok(html.includes("couldn't reach your inbox"));
  assert.ok(html.includes("W1") && !html.includes("W0"));
  assert.ok(html.includes("No headlines available")); // business/local empty
  // A user requirement: the brief carries no HUM section at all.
  assert.ok(!html.toLowerCase().includes("hum"), "the brief must not carry any hum content");
});

// A user requirement: the overnight email section simply recounts and summarizes the
// important emails that arrived overnight. An earlier version printed rows like
// "P1: <address> — (subject not in log) message <id> (p1 → p1-resolved (p3), …)" and
// "+ 14 P3 emails processed", which is filing detail, not news.
const FILING_WORDS = ["P1", "P2", "P3", "p1-resolved", "triage", "processed", "subject not in log", "messageId", "msg-1388", "label"];
const basePacket = (overnight_mail) => ({
  today: "2026-10-14", city: "Athens", metro: "athens",
  calendar: [], tasks: { overdue: [], today: [], tomorrow: [] }, news: {}, weather: null, events: [], overnight_mail,
});
const overnightOf = (html) => html.slice(html.indexOf("OVERNIGHT EMAIL"), html.indexOf(">NEWS<"));
const MAIL = [
  { from: "Dana Levi <dana@advisory.example>", subject: "Invitation: Support for client AI Program Advisory", received: "6:50 AM", hint: { flagged: "urgent", starred: true, category: "personal" }, text: "Wednesday Oct 14, 2026 10pm – 10:30pm local time" },
  { from: "StartupList <team@startups.example>", subject: "Rhinobird, FizzPoker and more", received: "6:10 AM", hint: { flagged: "routine", starred: false, category: "promotions" }, text: "Your digest of new startups" },
];

test("overnight: the write-up is who wrote and what it means, with nothing about how the agent filed it", () => {
  const picks = { overnight: { items: [{ who: "Dana Levi (Advisory Co)", summary: "Sent the invite for tonight's advisory call, 10 to 10:30pm local time. It's already on your calendar.}" }], rest: "The rest was a startup newsletter." }, news: {}, events: [] };
  const sec = overnightOf(render(basePacket(MAIL), picks));
  assert.ok(sec.includes("<b>Dana Levi (Advisory Co)</b>"));
  assert.ok(sec.includes("already on your calendar.</p>"), "a stray trailing brace from the model is tidied away");
  assert.ok(sec.includes("The rest was a startup newsletter."));
  for (const w of FILING_WORDS) assert.ok(!sec.includes(w), `overnight section must not mention "${w}"`);
});

test("overnight: a failed write-up names who wrote the flagged emails, still in plain words", () => {
  const sec = overnightOf(render(basePacket(MAIL), { overnight: null, news: {}, events: [] }));
  assert.ok(sec.includes("couldn't write up last night's email"));
  assert.ok(sec.includes("<b>Dana Levi</b>: Invitation: Support for client AI Program Advisory"));
  assert.ok(!sec.includes("StartupList"), "routine mail is not listed in the fallback");
  for (const w of FILING_WORDS) assert.ok(!sec.includes(w), `fallback must not mention "${w}"`);
  const quiet = overnightOf(render(basePacket([MAIL[1]]), { overnight: null, news: {}, events: [] }));
  assert.ok(quiet.includes("waiting in your inbox") && !quiet.includes("StartupList"));
});

test("overnight: an empty night and an empty write-up both read as plain sentences", () => {
  assert.ok(overnightOf(render(basePacket([]), { overnight: null, news: {}, events: [] })).includes("Nothing new came in overnight."));
  assert.ok(overnightOf(render(basePacket(MAIL), { overnight: { items: [], rest: "" }, news: {}, events: [] })).includes("Nothing in last night's email needs you."));
});

test("overnightRows: the agent's own mail left out, duplicates dropped, local time, hints, oldest first", () => {
  const rows = overnightRows([
    { id: "b", from: "Dana Levi <dana@advisory.example>", subject: "Invite", date: "2026-10-14 03:50", labels: ["p3", "p1-resolved", "CATEGORY_PERSONAL", "INBOX"], body: "Call tonight at 10pm" },
    { id: "a", from: "Fund Vault <funds@fund.example>", subject: "New deal", date: "2026-10-13 21:08", labels: ["Personal", "STARRED", "CATEGORY_UPDATES"], body: "<html><body><p>Wires due Friday</p></body></html>" }, // a P2: starred, no priority label
    { id: "a", from: "Fund Vault <funds@fund.example>", subject: "New deal", date: "2026-10-13 21:08", labels: [], body: "dup" },
    { id: "g", from: `Agent <${SYNTHETIC.agent_email}>`, subject: "Day of Tuesday", date: "2026-10-14 01:07", labels: ["jori-out"], body: "x" },
    { id: "h", from: "Someone <x@y.example>", subject: "Fwd", date: "2026-10-14 02:00", labels: ["jori-out"], body: "x" },
    { id: "u", from: "Pension Co <noreply@pension.example>", subject: "Documents missing", date: "2026-10-14 05:10", labels: ["p1", "STARRED"], body: "Upload them" },
    { id: "r", from: "StartupList <team@startups.example>", subject: "Digest", date: "2026-10-14 03:10", labels: ["p3", "CATEGORY_PROMOTIONS"], body: "startups" },
  ], "Europe/Athens");
  assert.deepEqual(rows.map((r) => r.subject), ["New deal", "Digest", "Invite", "Documents missing"]);
  assert.equal(rows[0].received, "12:08 AM"); // 21:08Z = 00:08 in Athens (UTC+3 in October)
  assert.equal(rows[2].received, "6:50 AM");
  assert.deepEqual(rows[0].hint, { flagged: "worth a look", starred: true, category: "updates" });
  assert.deepEqual(rows.map((r) => r.hint.flagged), ["worth a look", "routine", "was urgent, since handled", "urgent"]);
  assert.equal(rows[0].text, "Wires due Friday");
  assert.ok(!("id" in rows[0]), "no message ids reach the model");
});

test("mailText: HTML flattened, entities decoded, links and invisible padding dropped, capped", () => {
  assert.equal(mailText("<html><head><style>p{}</style></head><body><p>Hi Dana,</p><a href='https://t.co/x'>Track</a></body></html>"), "Hi Dana, Track");
  assert.equal(mailText("Savings &#847; &#847;&shy; up to 40% [ https://click.example.com/abc ] off &rsquo;n more"), "Savings up to 40% off ’n more");
  assert.equal(mailText("a".repeat(5000), 100).length, 100);
});

test("senderName: display name without the address or quotes", () => {
  assert.equal(senderName("Dana Levi <dana@advisory.example>"), "Dana Levi");
  assert.equal(senderName('"Card Co | Travel" <cardco@notification.cardco.example>'), "Card Co | Travel");
  assert.equal(senderName("no-reply@mailbox.example"), "no-reply@mailbox.example");
});
