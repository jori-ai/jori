// stay-calendar — the rules that decide which check-in/check-out events exist
// on a rental portfolio's calendar, and what a sync changes.
//
// Pure functions over literal objects: no channel manager, no Firestore, no
// Google. The portfolio is synthetic (sc.configure), so the rules are tested
// the same on any installation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sc = require("../lib/stay-calendar.js");

const LAKE = "0a1b2c3d-0000-4000-8000-00000000aa01";
const CONFIG = {
  calendar_id: "test-calendar@group.calendar.example.com",
  calendar_account: "owner@example.com",
  canonical_names: { "lakeside": "Lakeside House", "oak-12": "Oak 12" },
  channel_label: "StayHub",
  channel_api_base: "https://api.stayhub.example.com/v2",
  channel_token_env: "STAYHUB_TOKEN",
  channel_property_ids: { "lakeside": LAKE, "harbor-loft": "0a1b2c3d-0000-4000-8000-00000000aa02" },
  lease_reservation_fields: ["channelReservation"],
  books_label: "Acme Rentals",
  admin_url: "https://rentals.example.com/admin",
  rent_provider_labels: { rentpay: "RentPay" },
  // An Eastern zone, so the DST assertions below hold.
  tz: "EST5EDT",
};
sc.configure(CONFIG);

const NOW = Date.parse("2026-09-22T12:00:00Z");

const PROPERTIES = [
  { id: "lakeside", kind: "property", publicSlug: "lake-house", name: "Lakeside" },
  { id: "harbor-loft", kind: "property", publicSlug: "harbor", name: "Harbor Loft" },
  { id: "oak-12", kind: "property", publicSlug: "12OakSt", name: "Oak E12" },
  { id: "birch", kind: "property", publicSlug: "BirchAve", name: "Birch" },
  { id: "elm-cottage", kind: "property", publicSlug: null, name: "Elm Cottage", disposedOn: "2025-10-09" },
];

const VB = LAKE;

const res = (over = {}) => ({
  id: "r1",
  code: "HMABC",
  platform: "airbnb",
  status: "accepted",
  reservation_status: { current: { category: "accepted" } },
  check_in: "2026-10-22T15:00:00-04:00",
  check_out: "2026-10-27T11:00:00-04:00",
  nights: 5,
  guests: { total: 3, adult_count: 2, child_count: 1, infant_count: 0, pet_count: 1 },
  guest: { first_name: "Jane", last_name: "Doe" },
  properties: [{ id: VB }],
  ...over,
});

const lease = (over = {}) => ({
  id: "L1",
  status: "completed",
  paymentProvider: "rentpay",
  lessees: [{ name: "Ann Lee" }],
  terms: { propertySlug: "12OakSt", unitId: "B", startDate: "2026-11-01T12:00:00Z", endDate: "2027-09-30T12:00:00Z" },
  ...over,
});

const build = (input) => sc.desiredEvents({ reservations: [], leases: [], tenants: [], properties: PROPERTIES, nowMs: NOW, ...input });

test("a confirmed reservation becomes a 1h check-in and a 30m check-out at the real times", () => {
  const evs = build({ reservations: [res()] });
  assert.equal(evs.length, 2);
  const [inn, out] = evs;
  assert.equal(inn.key, "res:r1:in");
  assert.equal(inn.summary, "Jane Doe is checking in");
  assert.equal(inn.start, "2026-10-22T19:00:00Z");
  assert.equal(inn.end, "2026-10-22T20:00:00Z");
  assert.equal(out.summary, "Jane Doe is checking out");
  assert.equal(out.start, "2026-10-27T15:00:00Z");
  assert.equal(out.end, "2026-10-27T15:30:00Z");
  for (const line of ["Guest: Jane Doe", "Platform: Airbnb · HMABC", "Property: Lakeside House",
    "Number of guests: 3 (2 adults, 1 child)", "Pets: 1", "Stay: 5 nights"]) {
    assert.ok(inn.description.includes(line), `missing "${line}"`);
  }
  assert.equal(inn.description, out.description, "both events carry the full information");
});

test("requests, declines, cancellations and owner stays get no events", () => {
  const evs = build({
    reservations: [
      res({ id: "a", status: "request", reservation_status: { current: { category: "request" } } }),
      res({ id: "b", status: "denied", reservation_status: { current: { category: "not accepted" } } }),
      res({ id: "c", status: "cancelled", reservation_status: { current: { category: "cancelled" } } }),
      res({ id: "d", owner_stay: true }),
    ],
  });
  assert.deepEqual(evs, []);
});

test("only active properties count — a disposed or unknown property is ignored", () => {
  const evs = build({ reservations: [res({ properties: [{ id: "6ccbc579-de53-48ec-ad82-68332096ae86" }] })] });
  assert.deepEqual(evs, []);
});

test("a signed lease gives events at 3pm / 11am local, DST-correct; unsigned leases none", () => {
  const evs = build({
    leases: [
      lease(),
      lease({ id: "L2", status: "sent" }),
      lease({ id: "L3", status: "partially_signed" }),
      lease({ id: "L4", status: "voided" }),
    ],
  });
  assert.deepEqual(evs.map((e) => e.key), ["lease:L1:in", "lease:L1:out"]);
  // Nov 1 2026 is after the DST change (EST, -05:00); Sep 30 2027 is before the next one (EDT, -04:00).
  assert.equal(evs[0].start, "2026-11-01T20:00:00Z");
  assert.equal(evs[1].start, "2027-09-30T15:00:00Z");
  assert.equal(evs[0].summary, "Ann Lee is checking in");
  assert.ok(evs[0].description.includes("Property: Oak 12 · unit B"));
  assert.ok(evs[0].description.includes("Platform: Long-term lease (RentPay)"));
  assert.ok(evs[0].description.includes("Stay: 11 months"));
});

test("unconfigured: no admin link, no rent-provider label, the user's zone", () => {
  sc.configure({ tz: "EST5EDT" });
  try {
    const [ev] = build({ leases: [lease()] });
    assert.ok(ev.description.includes("Platform: Long-term lease\n"));
    assert.ok(!ev.description.includes("Open in admin"));
    assert.ok(ev.description.includes("Source: Portfolio lease L1 (Oak E12, unit B)"));
    assert.deepEqual(build({ reservations: [res()] }), [], "no channel ids: no reservation events");
  } finally {
    sc.configure(CONFIG);
  }
});

test("the title leads with the hub's point of contact, not the lease's first name", () => {
  const lessees = [{ name: "Alice Brown" }, { name: "Carol Diaz" }, { name: "Erin Fox" }];
  const evs = build({
    leases: [lease({ lessees })],
    tenants: [
      { leaseId: "L1", firstName: "Alice", lastName: "Brown", status: "current" },
      { leaseId: "L1", firstName: "Erin", lastName: "Fox", status: "current", pointOfContact: { source: "application" } },
    ],
  });
  assert.equal(evs[0].summary, "Erin Fox & 2 others are checking in");
  assert.ok(evs[0].description.includes("Guests: Erin Fox, Alice Brown & Carol Diaz"));
});

test("with no point of contact marked, the lease's own order stands", () => {
  const lessees = [{ name: "Gary Hill" }, { name: "Ivan Jones" }];
  const [ev] = build({ leases: [lease({ lessees })], tenants: [{ leaseId: "L1", firstName: "Ivan", lastName: "Jones" }] });
  assert.equal(ev.summary, "Gary Hill & Ivan Jones are checking in");
});

test("lease pets and multiple leaseholders come through; titles stay short", () => {
  const evs = build({
    leases: [lease({ lessees: [{ name: "A One" }, { name: "B Two" }, { name: "C Three" }] })],
    tenants: [
      { leaseId: "L1", hasPet: true, petType: "cat" },
      { leaseId: "L1", hasPet: false },
    ],
  });
  assert.equal(evs[0].summary, "A One & 2 others are checking in");
  assert.ok(evs[0].description.includes("Guests: A One, B Two & C Three"));
  assert.ok(evs[0].description.includes("Number of guests: 3"));
  assert.ok(evs[0].description.includes("Pets: cat"));
});

test("everyone moved out early: the check-out follows the actual move-out", () => {
  const evs = build({
    leases: [lease()],
    tenants: [{ leaseId: "L1", movedOutAt: "2027-03-15T16:00:00Z" }],
  });
  assert.equal(evs[1].start, "2027-03-15T15:00:00Z");
});

test("a lease tied to a channel-manager reservation is not shown twice", () => {
  const evs = build({ leases: [lease({ channelReservation: { id: "x" }, terms: { ...lease().terms, propertySlug: "harbor" } })] });
  assert.deepEqual(evs, []);
});

test("a renewal written as a new lease is not a check-out plus a check-in", () => {
  const evs = build({
    leases: [
      lease({ terms: { propertySlug: "BirchAve", unitId: "2", startDate: "2025-07-01T12:00:00Z", endDate: "2027-06-30T12:00:00Z" } }),
      lease({ id: "L9", terms: { propertySlug: "BirchAve", unitId: "2", startDate: "2027-07-01T12:00:00Z", endDate: "2027-09-30T12:00:00Z" } }),
    ],
  });
  assert.deepEqual(evs.map((e) => e.key), ["lease:L9:out"]);
});

test("events already in the past are outside the window and never produced", () => {
  const evs = build({ reservations: [res({ check_in: "2026-09-01T15:00:00-04:00" })] });
  assert.deepEqual(evs.map((e) => e.kind), ["out"]);
});

// ── planSync ───────────────────────────────────────────────────────────────

const existingFrom = (d, over = {}) => ({
  id: `g-${d.key}`,
  summary: d.summary,
  transparency: "transparent",
  start: { dateTime: d.start },
  end: { dateTime: d.end },
  extendedProperties: { private: { phStay: d.key, phHash: d.hash } },
  ...over,
});

test("a matching calendar needs no changes", () => {
  const desired = build({ reservations: [res()] });
  const plan = sc.planSync(desired, desired.map((d) => existingFrom(d)), NOW);
  assert.deepEqual(plan, { create: [], update: [], remove: [] });
});

test("new stays are created, changed stays updated, cancelled stays deleted", () => {
  const before = build({ reservations: [res(), res({ id: "r2" })] });
  const existing = before.map((d) => existingFrom(d));
  const after = build({ reservations: [res({ check_out: "2026-10-28T11:00:00-04:00", nights: 6 }), res({ id: "r3" })] });
  const plan = sc.planSync(after, existing, NOW);
  assert.deepEqual(plan.create.map((d) => d.key).sort(), ["res:r3:in", "res:r3:out"]);
  assert.deepEqual(plan.update.map((u) => u.event.key).sort(), ["res:r1:in", "res:r1:out"]);
  assert.deepEqual(plan.remove.map((r) => r.key).sort(), ["res:r2:in", "res:r2:out"]);
});

test("a hand edit or a lost show-as-free is put back; unmanaged events are never touched", () => {
  const desired = build({ reservations: [res()] });
  const existing = [
    existingFrom(desired[0], { start: { dateTime: "2026-10-22T21:00:00Z" } }),
    existingFrom(desired[1], { transparency: "opaque" }),
    { id: "mine", summary: "Dentist", start: { dateTime: "2026-10-01T14:00:00Z" }, end: { dateTime: "2026-10-01T15:00:00Z" } },
  ];
  const plan = sc.planSync(desired, existing, NOW);
  assert.equal(plan.update.length, 2);
  assert.equal(plan.remove.length, 0);
});

test("a duplicated key keeps one copy", () => {
  const desired = build({ reservations: [res()] });
  const existing = [...desired.map((d) => existingFrom(d)), existingFrom(desired[0], { id: "dupe" })];
  const plan = sc.planSync(desired, existing, NOW);
  assert.deepEqual(plan.remove, [{ id: "dupe", key: "res:r1:in", reason: "duplicate" }]);
});

test("past managed events are history and are left alone", () => {
  const old = { id: "old", summary: "X is checking out", start: { dateTime: "2026-08-01T15:00:00Z" }, end: { dateTime: "2026-08-01T15:30:00Z" },
    extendedProperties: { private: { phStay: "res:gone:out", phHash: "x" } } };
  const plan = sc.planSync([], [old], NOW);
  assert.deepEqual(plan.remove, []);
});

test("a backfill (--since) owns past events too; a normal run still never does", () => {
  const since = Date.parse("2026-01-01T05:00:00Z");
  const past = res({ id: "old", check_in: "2026-03-01T15:00:00-05:00", check_out: "2026-03-05T11:00:00-05:00" });
  assert.deepEqual(build({ reservations: [past] }), []);
  const back = sc.desiredEvents({ reservations: [past], leases: [], tenants: [], properties: PROPERTIES, nowMs: NOW, sinceMs: since });
  assert.deepEqual(back.map((e) => e.key), ["res:old:in", "res:old:out"]);
  const plan = sc.planSync(back, [], NOW, since);
  assert.equal(plan.create.length, 2);
  // Before the backfill date is still out of reach.
  const older = res({ id: "older", check_in: "2025-12-01T15:00:00-05:00", check_out: "2025-12-05T11:00:00-05:00" });
  assert.deepEqual(sc.desiredEvents({ reservations: [older], leases: [], tenants: [], properties: PROPERTIES, nowMs: NOW, sinceMs: since }), []);
});

test("every event names the exact record it came from", () => {
  const [r] = build({ reservations: [res()] });
  assert.ok(r.description.includes("Source: StayHub reservation HMABC (Airbnb), confirmed"));
  assert.ok(!r.description.includes("Synced from StayHub / Acme Rentals leases"));

  const [l] = build({ leases: [lease()] });
  assert.ok(l.description.includes("Source: Acme Rentals lease L1 (Oak 12, unit B), signed by all parties"));
  assert.ok(l.description.includes("Check-out date: the lease end date"));
  assert.ok(l.description.includes("Open in admin: https://rentals.example.com/admin?property=12OakSt&unit=B"));
});

test("the source says when a signed early termination or a move-out set the check-out", () => {
  const early = build({ leases: [lease({
    terms: { ...lease().terms, endDate: "2027-03-01T12:00:00Z" },
    earlyTermination: { terminationDate: "2027-03-01T12:00:00Z", previousEndDate: "2027-09-30T12:00:00Z" },
  })] });
  assert.ok(early[1].description.includes("Check-out date: the signed early termination (the lease originally ended Sep 30, 2027)"));

  const moved = build({
    leases: [lease()],
    tenants: [{ leaseId: "L1", firstName: "Ann", lastName: "Lee", movedOutAt: "2027-02-10T12:00:00Z" }],
  });
  assert.ok(moved[1].description.includes("Check-out date: the move-out recorded on the tenant records"));
});
