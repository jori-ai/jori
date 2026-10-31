// Regression guard for the 2026-09-15 calendar-attendee-audit fan-out.
//
// What this defends against: the audit paged the system channel with
// "⚠️ 58 calendar event(s) with attendees Jori cannot account for" — 58
// expanded instances of ONE weekly "Family block" series the user made by hand.
// `gog calendar list` returns instances, every instance inherits the series'
// attendee list, and the audit's window runs 400 days forward, so one recurring
// invite became a ~12KB page, 58 seen-ledger rows, and a printed remedy
// (`--forget <event-id>`) that would have taken 58 invocations.
//
// These assert the COLLAPSE, and equally that collapsing did not soften the
// check: a guest present on only one instance must still be named.
//
// Pure functions over literal objects — no network, no calendar, no ledger, no
// side effects of any kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { seriesKey, collapseFindings, formatFindingLine, inAuditScope } from "../lib/calendar-audit-group.js";

const SERIES = "_8ksk8e9n64pk4ba58h1j0b9k8co46ba2610jab9j8cpjac266gr3gdpj6g";
const PARTNER = "partner@example.invalid";

const instance = (n, over = {}) => ({
  kind: "unexplained",
  id: `${SERIES}_2026${String(9 + Math.floor(n / 30)).padStart(2, "0")}${String((n % 28) + 1).padStart(2, "0")}T180000Z`,
  key: SERIES,
  summary: "Family block",
  attendees: [PARTNER],
  uncovered: [PARTNER],
  created: "2026-09-14T20:13:00.000Z",
  creator: "owner@example.invalid",
  has_description: false,
  ...over,
});

test("the 58-instance Family block series collapses to one finding", () => {
  const raw = Array.from({ length: 58 }, (_, i) => instance(i));
  const out = collapseFindings(raw);
  assert.equal(out.length, 1, "one hand-made recurring invite is one finding");
  assert.equal(out[0].id, SERIES, "the finding is keyed by the series, so --forget takes one id");
  assert.equal(out[0].instances, 58, "the count the user needs is kept, not the 58 bullets");
  assert.deepEqual(out[0].uncovered, [PARTNER]);
});

test("a guest added to a single instance is still named — collapse must not soften detection", () => {
  const raw = Array.from({ length: 10 }, (_, i) => instance(i));
  raw[4] = instance(4, { attendees: [PARTNER, "stranger@example.invalid"], uncovered: ["stranger@example.invalid"] });
  const out = collapseFindings(raw);
  assert.equal(out.length, 1);
  assert.deepEqual(
    [...out[0].uncovered].sort(),
    [PARTNER, "stranger@example.invalid"].sort(),
    "guests are unioned across instances, so a per-instance override still fires",
  );
});

test("distinct series are never merged", () => {
  const out = collapseFindings([
    instance(0),
    instance(1, { key: "OTHERSERIES", id: "OTHERSERIES_20260920T180000Z", summary: "Book club" }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.id).sort(), [SERIES, "OTHERSERIES"].sort());
});

test("a one-off event is passed through unchanged", () => {
  const one = {
    kind: "unexplained", id: "4jeg1r397ivn8k0cc3u6nc3gg4", key: "4jeg1r397ivn8k0cc3u6nc3gg4",
    summary: "Guest/Owner sync", attendees: ["guest@example.invalid"], uncovered: ["guest@example.invalid"],
    created: "2026-09-07T17:59:00.000Z", creator: "owner@example.invalid", has_description: false,
  };
  const out = collapseFindings([one]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "4jeg1r397ivn8k0cc3u6nc3gg4");
  assert.equal(out[0].instances, 1, "no 'recurring series' suffix is rendered for instances === 1");
});

test("a series is only called unexplained when NO instance had a log row", () => {
  const mixed = [instance(0), instance(1, { kind: "partial" })];
  assert.equal(collapseFindings(mixed)[0].kind, "partial", "the weaker, honest claim wins");
  assert.equal(collapseFindings([instance(0), instance(1)])[0].kind, "unexplained");
});

test("seriesKey prefers recurringEventId and falls back to the event id", () => {
  assert.equal(seriesKey({ id: `${SERIES}_20260915T180000Z`, recurringEventId: SERIES }), SERIES);
  assert.equal(seriesKey({ id: "one-off" }), "one-off");
  assert.equal(seriesKey({}), "");
});

// The "⚠️ calendar event(s)
// with attendees Jori cannot account for" page said Jori's own "Comedy night"
// event had "no description, which is how a hand-made meeting usually looks".
// Jori made it (no description); the user later renamed it and added guests.
// The description is not a tell; Google's `updated` time is a fact.
const SHOW = {
  kind: "unexplained", id: "showevent0001", key: "showevent0001",
  summary: "Comedy night", attendees: [PARTNER, "child@example.invalid"], uncovered: [PARTNER, "child@example.invalid"],
  created: "2026-10-05T14:17:11.000Z", updated: "2026-10-06T07:02:40.000Z",
  creator: "owner@example.invalid", has_description: false, instances: 1,
};

test("owner-edit-tell: a finding without a description never claims it looks hand-made", () => {
  const line = formatFindingLine(SHOW);
  assert.doesNotMatch(line, /hand-made/);
  assert.doesNotMatch(line, /description/);
});

test("owner-edit-tell: an edit long after creation is shown as a last-changed time", () => {
  assert.match(formatFindingLine(SHOW), / · last changed 2026-10-06 07:02Z/);
});

test("owner-edit-tell: no last-changed clause within 10 minutes of creation, or with no updated", () => {
  assert.doesNotMatch(formatFindingLine({ ...SHOW, updated: "2026-10-05T14:25:00.000Z" }), /last changed/);
  assert.doesNotMatch(formatFindingLine({ ...SHOW, updated: null }), /last changed/);
  assert.doesNotMatch(formatFindingLine({ ...SHOW, updated: undefined }), /last changed/);
});

test("owner-edit-tell: collapsing a series keeps the latest updated across instances", () => {
  const out = collapseFindings([
    instance(0, { updated: "2026-09-14T20:13:05.000Z" }),
    instance(1, { updated: "2026-09-20T09:00:00.000Z" }),
    instance(2, { updated: "2026-09-16T09:00:00.000Z" }),
  ]);
  assert.equal(out[0].updated, "2026-09-20T09:00:00.000Z");
});

test("owner-edit-tell: kind wording, created clause and series clause still render", () => {
  const line = formatFindingLine(SHOW);
  assert.ok(line.startsWith("• Comedy night — partner@example.invalid, child@example.invalid ("));
  assert.match(line, /\(no row in the write log covers this event\)/);
  assert.match(line, / · created 2026-10-05 14:17Z by owner@example.invalid/);
  assert.doesNotMatch(line, /recurring series/);
  const series = formatFindingLine({ ...collapseFindings(Array.from({ length: 3 }, (_, i) => instance(i)))[0], kind: "partial" });
  assert.match(series, /\(the write log has rows for this event, but none names these guests\)/);
  assert.match(series, / · recurring series, 3 occurrences in the window$/);
});

// Scope rule: a received invitation's PRIVATE COPY is not the user's event.
//
// What this defends against: the system-channel page "⚠️ N calendar event(s)
// with attendees Jori cannot account for" naming the guests of a meeting an
// outside organizer sent (an Outlook or Teams invite). Google writes such an
// invitation into the user's calendar as a private copy (`privateCopy: true`,
// `creator.self: true`, outside `organizer` with no `self`), and the old scope
// test accepted any event with `creator.self`. A private copy has propagation
// disabled, so no write to it can reach a guest: it is out of scope. Every other
// shape must be judged exactly as before.
const USER_ADDRS = new Set(["user@example.invalid", "user@alias.example.invalid"]);
const OUTSIDE = "organizer@outside.example.invalid";

test("private-copy scope: a received outside invitation is out of scope", () => {
  const ev = {
    privateCopy: true,
    creator: { email: "user@example.invalid", self: true },
    organizer: { email: OUTSIDE },
    attendees: [{ email: OUTSIDE }, { email: "guest@outside.example.invalid" }, { email: "user@example.invalid", self: true }],
  };
  assert.equal(inAuditScope(ev, USER_ADDRS), false, "the outside organizer's guest list is not Jori's to account for");
});

test("private-copy scope: an event the user organizes is in scope", () => {
  const ev = {
    creator: { email: "user@example.invalid", self: true },
    organizer: { email: "user@example.invalid", self: true },
  };
  assert.equal(inAuditScope(ev, USER_ADDRS), true);
});

test("private-copy scope: a private copy the user organizes (self flag) stays in scope", () => {
  const ev = {
    privateCopy: true,
    creator: { email: "user@example.invalid", self: true },
    organizer: { email: "user@example.invalid", self: true },
  };
  assert.equal(inAuditScope(ev, USER_ADDRS), true);
});

test("private-copy scope: a private copy organized by one of the user's addresses (no self flag) stays in scope", () => {
  const ev = {
    privateCopy: true,
    creator: { email: "user@example.invalid", self: true },
    organizer: { email: "User@Alias.Example.Invalid" },
  };
  assert.equal(inAuditScope(ev, USER_ADDRS), true, "organizer address is compared lower-cased against the user's set");
});

test("private-copy scope: without privateCopy, creator.self keeps an outside-organized event in scope (unchanged)", () => {
  const ev = {
    creator: { email: "user@example.invalid", self: true },
    organizer: { email: OUTSIDE },
  };
  assert.equal(inAuditScope(ev, USER_ADDRS), true);
  assert.equal(inAuditScope({ ...ev, privateCopy: false }, USER_ADDRS), true, "only privateCopy === true excludes");
});

test("private-copy scope: organizer and creator both outside is out of scope (unchanged)", () => {
  const ev = {
    creator: { email: OUTSIDE },
    organizer: { email: OUTSIDE },
  };
  assert.equal(inAuditScope(ev, USER_ADDRS), false);
});

test("private-copy scope: a private copy with no organizer fails toward reporting", () => {
  const ev = {
    privateCopy: true,
    creator: { email: "user@example.invalid", self: true },
  };
  assert.equal(inAuditScope(ev, USER_ADDRS), true, "no organizer named, so nothing proves the guest list is someone else's");
  assert.equal(inAuditScope({ ...ev, organizer: { email: "" } }, USER_ADDRS), true);
});

test("private-copy scope: address-only matches are unchanged when no self flag is present", () => {
  assert.equal(inAuditScope({ creator: { email: "USER@example.invalid" }, organizer: { email: OUTSIDE } }, USER_ADDRS), true);
  assert.equal(inAuditScope({ organizer: { email: "user@example.invalid" } }, USER_ADDRS), true);
  assert.equal(inAuditScope({}, USER_ADDRS), false);
  assert.equal(inAuditScope(null, USER_ADDRS), false);
});
