// The other side's invitation wins over ours (lib/their-invite.mjs, the user's
// rule of 2026-11-27). Shapes from the incident: Jori invited a contractor's
// coordinator and her colleague for an 11:00 site visit; the coordinator then
// sent her own invitation for the same hour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sameParty, findTheirInvites, isTheirInvite } from "../lib/their-invite.mjs";

const OWNER = "owner@example.com";
const owners = [OWNER];

const ours = (over = {}) => ({
  id: "OURS", summary: "Walkthrough", status: "confirmed",
  organizer: { email: OWNER, self: true },
  attendees: [{ email: "lee@builder.test" }, { email: "pat@builder.test" }],
  extendedProperties: { private: { jori_created: "1" } },
  start: { dateTime: "2026-12-10T11:00:00-05:00" }, end: { dateTime: "2026-12-10T12:00:00-05:00" },
  ...over,
});
const theirs = (over = {}) => ({
  id: "THEIRS", summary: "onsite with the owner", status: "confirmed",
  organizer: { email: "pat@builder.test" },
  attendees: [{ email: "pat@builder.test", organizer: true }, { email: OWNER, self: true, responseStatus: "accepted" }, { email: "lee@builder.test" }],
  start: { dateTime: "2026-12-10T11:00:00-05:00" }, end: { dateTime: "2026-12-10T12:00:00-05:00" },
  ...over,
});

test("same person, or a colleague at a company domain, is the same party", () => {
  assert.ok(sameParty("pat@builder.test", ["pat@builder.test"]));
  assert.ok(sameParty("office@builder.test", ["lee@builder.test"]));
  assert.ok(!sameParty("someone@gmail.com", ["friend@gmail.com"]), "a shared mail provider is not a company");
  assert.ok(sameParty("friend@gmail.com", ["Friend@gmail.com"]));
  assert.ok(!sameParty("room@resource.calendar.google.com", ["room@resource.calendar.google.com"]));
});

test("their invitation is found for the slot we are about to invite them to", () => {
  const found = findTheirInvites([theirs()], {
    invitees: ["lee@builder.test", "pat@builder.test"],
    from: "2026-12-10T11:00:00-05:00", to: "2026-12-10T12:00:00-05:00", owners,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].event.id, "THEIRS");
  assert.ok(found[0].who.includes("pat@builder.test"));
});

test("a nearby time still counts; a different day does not", () => {
  const near = theirs({ start: { dateTime: "2026-12-10T13:30:00-05:00" }, end: { dateTime: "2026-12-10T14:30:00-05:00" } });
  const far = theirs({ start: { dateTime: "2026-12-11T11:00:00-05:00" }, end: { dateTime: "2026-12-11T12:00:00-05:00" } });
  const q = { invitees: ["lee@builder.test"], from: "2026-12-10T11:00:00-05:00", to: "2026-12-10T12:00:00-05:00", owners };
  assert.equal(findTheirInvites([near], q).length, 1);
  assert.equal(findTheirInvites([far], q).length, 0);
});

test("someone else's invite, our own events, declined or cancelled ones are not theirs", () => {
  const q = { invitees: ["lee@builder.test"], from: "2026-12-10T11:00:00-05:00", to: "2026-12-10T12:00:00-05:00", owners };
  assert.equal(findTheirInvites([theirs({ organizer: { email: "x@other.test" }, attendees: [{ email: OWNER, self: true }] })], q).length, 0);
  assert.equal(findTheirInvites([ours()], q).length, 0);
  assert.equal(findTheirInvites([theirs({ status: "cancelled" })], q).length, 0);
  const declined = theirs({ attendees: [{ email: OWNER, self: true, responseStatus: "declined" }, { email: "lee@builder.test" }] });
  assert.ok(!isTheirInvite(declined, new Set(owners)));
});
