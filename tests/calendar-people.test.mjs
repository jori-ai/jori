// calendar-people.test.mjs — event geometry, the held filter, guest and title
// links to pages, qualification of unmatched guests, staleness, contact days
// and the wiki ## Meetings block.
// Run: node --test tests/calendar-people.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-people-"));
process.env.CALENDAR_PEOPLE_DB = path.join(dir, "cal.db");
process.env.EMAIL_PEOPLE_DB = path.join(dir, "ep.db");
process.env.JORI_OWNER_EMAIL = "me@example.com";

const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const cal = req(path.resolve("lib/calendar-people.js"));
const ep = req(path.resolve("lib/email-people.js"));

after(() => {
  cal.closeDb();
  ep.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-14T12:00:00Z");
const self = new Set(["me@example.com"]);
const iso = (d, h = 12) => `${d}T${String(h).padStart(2, "0")}:00:00Z`;
function ev(id, date, extra = {}) {
  return { id, summary: `Event ${id}`, start: { dateTime: iso(date) }, end: { dateTime: iso(date, 13) }, status: "confirmed", ...extra };
}
const guest = (email, name, more = {}) => ({ email, displayName: name, responseStatus: "accepted", ...more });
const me = (resp = "accepted") => ({ email: "me@example.com", self: true, responseStatus: resp });

test("eventKind: street address → in person, link or conference → video, date-only → all day", () => {
  assert.equal(cal.eventKind({ start: { dateTime: "x" }, location: "12 Main St, Springfield" }), "in_person");
  assert.equal(cal.eventKind({ start: { dateTime: "x" }, location: "https://zoom.us/j/1" }), "video");
  assert.equal(cal.eventKind({ start: { dateTime: "x" }, hangoutLink: "https://meet.google.com/x" }), "video");
  assert.equal(cal.eventKind({ start: { date: "2026-01-01" } }), "all_day");
  assert.equal(cal.eventKind({ start: { dateTime: "x" } }), "unknown");
});

test("normalizeEvent drops the user, rooms and status blocks", () => {
  const r = cal.normalizeEvent(ev("a", "2026-10-01", { attendees: [me(), guest("dana@example.com", "Dana"), { email: "room-1@example.com", resource: true }] }), self);
  assert.deepEqual(r.guests.map((g) => g.email), ["dana@example.com"]);
  assert.equal(r.self_response, "accepted");
  assert.equal(cal.normalizeEvent({ id: "w", eventType: "workingLocation", start: { date: "2026-01-01" } }, self), null);
});

test("ingest, guest links through the email ledger, held filter and the facts line", () => {
  ep.link("dana@example.com", "user_dana_levi");
  const events = [
    ev("m1", "2026-09-01", { location: "Cafe, Springfield", attendees: [me(), guest("dana@example.com", "Dana Levi")] }),
    ev("m2", "2026-10-01", { hangoutLink: "https://meet.google.com/a", attendees: [me(), guest("dana@example.com", "Dana Levi")] }),
    ev("m3", "2026-10-15", { attendees: [me("declined"), guest("dana@example.com", "Dana Levi")] }),
    ev("m4", "2026-10-20", { status: "cancelled", attendees: [me(), guest("dana@example.com", "Dana Levi")] }),
    ev("m5", "2026-12-01", { attendees: [me(), guest("dana@example.com", "Dana Levi")] }),
  ];
  cal.ingestWindow(events, { fromMs: Date.parse("2026-08-01"), toMs: Date.parse("2027-01-01"), now: NOW, self });
  const [c] = cal.candidates({ now: NOW });
  assert.equal(c.wiki_id, "user_dana_levi");
  assert.equal(c.meetings, 2);
  assert.equal(c.in_person, 1);
  assert.equal(c.video, 1);
  assert.equal(new Date(c.next_at).toISOString().slice(0, 10), "2026-12-01");
  assert.equal(c.stale, true);
  assert.equal(
    cal.factsLine(c, { today: NOW }),
    "_From Google Calendar · 2 meetings (1 in person, 1 video) · first 2026-09-01 · last 2026-10-01 · next 2026-12-01 · updated 2026-11-14_",
  );
});

test("an event gone from its window is dropped", () => {
  cal.ingestWindow([ev("m1", "2026-09-01", { location: "Cafe, Springfield", attendees: [me(), guest("dana@example.com", "Dana Levi")] })], { fromMs: Date.parse("2026-09-15"), toMs: Date.parse("2026-10-10"), now: NOW, self });
  const [c] = cal.candidates({ now: NOW });
  assert.equal(c.meetings, 1, "m2 (in the window, not returned) is gone; m1 is outside it and stays");
});

test("titles: one reading per distinct title covers every event with it, later ones too", () => {
  const w = { fromMs: Date.parse("2026-10-31"), toMs: Date.parse("2026-11-04"), now: NOW, self };
  cal.ingestWindow([ev("t1", "2026-11-01", { summary: "Lunch with Omer" }), ev("t1b", "2026-11-03", { summary: "Lunch with Omer" }), ev("t2", "2026-11-02", { summary: "Dentist" })], w);
  const pending = cal.titlesPending({ now: NOW }).filter((r) => ["Lunch with Omer", "Dentist"].includes(r.title));
  assert.deepEqual(pending.map((r) => [r.title, r.events]), [["Lunch with Omer", 2], ["Dentist", 1]]);
  const key = (t) => cal.titleKey(t);
  const res = cal.review({ [key("Lunch with Omer")]: ["user_omer", "user_ghost"], [key("Dentist")]: [], nope: [] }, { pageExists: (id) => id !== "user_ghost" });
  assert.deepEqual([res.titles, res.events, res.mentions], [2, 3, 2]);
  assert.deepEqual(res.unknown_pages, ["user_ghost"]);
  assert.deepEqual(res.unknown_keys, ["nope"]);
  assert.equal(cal.titlesPending({ now: NOW }).filter((r) => ["Lunch with Omer", "Dentist"].includes(r.title)).length, 0);
  assert.equal(cal.candidates({ now: NOW }).find((c) => c.wiki_id === "user_omer").meetings, 2);
  // A later event with a title already read inherits its reading.
  cal.ingestWindow([ev("t3", "2026-11-05", { summary: "Lunch with Omer" })], { fromMs: Date.parse("2026-11-05"), toMs: Date.parse("2026-11-06"), now: NOW, self });
  assert.equal(cal.candidates({ now: NOW }).find((c) => c.wiki_id === "user_omer").meetings, 3);
  // A retitled event loses the old reading and its new title waits to be read.
  cal.ingestWindow([ev("t3", "2026-11-05", { summary: "Lunch with Omer and Gil" })], { fromMs: Date.parse("2026-11-05"), toMs: Date.parse("2026-11-06"), now: NOW, self });
  assert.equal(cal.candidates({ now: NOW }).find((c) => c.wiki_id === "user_omer").meetings, 2);
  assert.ok(cal.titlesPending({ now: NOW }).some((r) => r.title === "Lunch with Omer and Gil"));
});

test("unmatched: 2 small meetings qualify, 1 in Contacts, big invites don't, role addresses never", () => {
  const crowd = Array.from({ length: 12 }, (_, i) => guest(`p${i}@example.biz`, `P${i}`));
  ep.upsertContacts([{ email: "kim@example.net", name: "Kim Lee", resource: "people/c1" }]);
  cal.ingestWindow(
    [
      ev("u1", "2026-03-01", { attendees: [me(), guest("gil@example.org", "Gil"), guest("noreply@example.org", "Bot")] }),
      ev("u2", "2026-04-01", { attendees: [me(), guest("gil@example.org", "Gil"), guest("noreply@example.org", "Bot")] }),
      ev("u3", "2026-04-02", { attendees: [me(), guest("kim@example.net", "Kim")] }),
      ev("u4", "2026-04-03", { attendees: [me(), ...crowd] }),
      ev("u5", "2026-04-04", { attendees: [me(), ...crowd] }),
    ],
    { fromMs: Date.parse("2026-02-01"), toMs: Date.parse("2026-05-01"), now: NOW, self },
  );
  const emails = cal.unmatched({ now: NOW }).map((u) => u.email).sort();
  assert.deepEqual(emails, ["gil@example.org", "kim@example.net"]);
  cal.linkGuest("gil@example.org", "user_gil");
  cal.ignoreGuest("kim@example.net", "a shared inbox");
  assert.deepEqual(cal.unmatched({ now: NOW }), []);
  assert.equal(cal.candidates({ now: NOW }).find((c) => c.wiki_id === "user_gil").meetings, 2);
});

test("staleness: summarized is quiet until new meetings and time pass", () => {
  cal.markSummarized("user_gil", { now: NOW });
  assert.equal(cal.candidates({ now: NOW }).find((c) => c.wiki_id === "user_gil").stale, false);
  cal.ingestWindow([ev("u6", "2026-11-10", { attendees: [me(), guest("gil@example.org", "Gil")] })], { fromMs: Date.parse("2026-11-10"), toMs: Date.parse("2026-11-11"), now: NOW, self });
  assert.equal(cal.candidates({ now: NOW + 864e5 }).find((c) => c.wiki_id === "user_gil").stale, false, "one new meeting a day later");
  assert.equal(cal.candidates({ now: NOW + 15 * 864e5 }).find((c) => c.wiki_id === "user_gil").stale, true, "after RESUMMARY_DAYS");
});

test("contactDays counts held meetings only", () => {
  const days = cal.contactDays({ now: NOW }).get("user_dana_levi");
  assert.equal(days.size, 1);
  assert.ok(days.has(Math.floor(Date.parse("2026-09-01T12:00:00Z") / 864e5)));
});

test("renderSection appends ## Meetings once and replaces it after", () => {
  const a = cal.renderSection("# Dana\n\nbody\n", { facts: "_f1_", summary: "s1" });
  assert.match(a, /## Meetings\n<!-- calendar-people:start -->\n_f1_\n\ns1\n<!-- calendar-people:end -->/);
  const b = cal.renderSection(a, { facts: "_f2_", summary: "s2 $& literal" });
  assert.equal((b.match(/## Meetings/g) || []).length, 1);
  assert.ok(b.includes("s2 $& literal"));
});
