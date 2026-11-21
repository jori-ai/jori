// hum-calendar-harvester.test.mjs — unit tests for the calendar hum harvester's
// overlap + filter helpers — the pieces that once over-flagged conflicts
// (adjacent events tagged as conflicts, free-transparency events and another
// person's prefixed events not filtered, no per-day dedup).
//
// Run: node --test tests/hum-calendar-harvester.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventPeople, eventPeopleLine } from "../lib/meeting-event.mjs";

// A synthetic installation: the summary prefixes that mark someone else's
// events come from agent/local/config/hum-calendar.json.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "hum-calendar-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "hum-calendar.json"), JSON.stringify({ ignore_summary_prefixes: ["[Shared]"] }));
process.env.JORI_LOCAL_DIR = LOCAL;
test.after(() => fs.rmSync(LOCAL, { recursive: true, force: true }));
const HARVESTER = new URL("../agent/scripts/hum-harvesters/calendar.mjs", import.meta.url);
const {
  overlaps,
  filterScannableEvents,
  pairKey,
  transitTimeUnverified,
  upcomingSoon,
  soonSignal,
} = await import(HARVESTER.href);

// Helper: build an event with dateTime start/end (UTC; any fixed offset works
// for predicate tests).
function ev(summary, startIso, endIso, extra = {}) {
  return {
    summary,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    ...extra,
  };
}

function ms(iso) {
  return new Date(iso).getTime();
}

test("overlaps: true when intervals truly intersect", () => {
  // Event A 17:00–18:30, Event B 18:00–19:00 → overlap 18:00–18:30
  const a1 = ms("2030-03-11T17:00:00Z");
  const a2 = ms("2030-03-11T18:30:00Z");
  const b1 = ms("2030-03-11T18:00:00Z");
  const b2 = ms("2030-03-11T19:00:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), true);
  // Symmetric
  assert.equal(overlaps(b1, b2, a1, a2), true);
});

test("overlaps: false when events are adjacent (touching edges)", () => {
  // Event A ends 18:15, Event B starts 18:30 — gap, no overlap.
  const a1 = ms("2030-03-11T17:00:00Z");
  const a2 = ms("2030-03-11T18:15:00Z");
  const b1 = ms("2030-03-11T18:30:00Z");
  const b2 = ms("2030-03-11T19:30:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), false);
});

test("overlaps: false when events exactly abut (end == start)", () => {
  // Back-to-back: A ends exactly when B starts. Must NOT count as conflict.
  const a1 = ms("2030-03-11T17:00:00Z");
  const a2 = ms("2030-03-11T18:00:00Z");
  const b1 = ms("2030-03-11T18:00:00Z");
  const b2 = ms("2030-03-11T19:00:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), false);
});

test("overlaps: true for containment (one event inside another)", () => {
  // A 14:00–18:00 contains B 15:00–16:00.
  const a1 = ms("2030-03-11T14:00:00Z");
  const a2 = ms("2030-03-11T18:00:00Z");
  const b1 = ms("2030-03-11T15:00:00Z");
  const b2 = ms("2030-03-11T16:00:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), true);
});

test("overlaps: false for missing / zero timestamps", () => {
  assert.equal(overlaps(0, 0, 1000, 2000), false);
  assert.equal(overlaps(1000, 2000, 0, 0), false);
});

test("filterScannableEvents: drops transparency=transparent events", () => {
  const input = [
    ev(
      "Quarterly planning",
      "2030-03-11T16:00:00Z",
      "2030-03-11T18:00:00Z",
    ),
    ev(
      "Focus block",
      "2030-03-11T17:00:00Z",
      "2030-03-11T19:00:00Z",
      { transparency: "transparent" },
    ),
  ];
  const out = filterScannableEvents(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, "Quarterly planning");
});

// The prefix below is the synthetic installation's configured one.
test("filterScannableEvents: drops summaries starting with a configured prefix", () => {
  const input = [
    ev(
      "Weekly sync",
      "2030-03-11T10:00:00Z",
      "2030-03-11T11:00:00Z",
    ),
    ev(
      "[Shared] Book the team offsite",
      "2030-03-11T10:30:00Z",
      "2030-03-11T11:30:00Z",
    ),
  ];
  const out = filterScannableEvents(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, "Weekly sync");
});

test("filterScannableEvents: drops events missing start/end timestamps", () => {
  const bad = { summary: "broken", start: {}, end: {} };
  const good = ev(
    "ok",
    "2030-03-11T10:00:00Z",
    "2030-03-11T11:00:00Z",
  );
  const out = filterScannableEvents([bad, good]);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, "ok");
});

test("filterScannableEvents: preserves opaque (undefined transparency)", () => {
  // Most real events don't have a transparency field — they default to busy.
  const e = ev(
    "Weekly sync",
    "2030-03-11T10:00:00Z",
    "2030-03-11T11:00:00Z",
  );
  const out = filterScannableEvents([e]);
  assert.equal(out.length, 1);
  assert.equal(out[0].transparency, undefined);
  assert.ok(out[0]._start > 0);
  assert.ok(out[0]._end > out[0]._start);
});

test("pairKey: stable regardless of ordering + case / whitespace", () => {
  assert.equal(
    pairKey("Water plants", "Take out Trash"),
    pairKey("Take out Trash", "Water plants"),
  );
  assert.equal(
    pairKey("  Foo  ", "bar"),
    pairKey("FOO", "Bar"),
  );
});

// ── Departures whose time nobody checked (jori-calendar --transit) ─────────
// A countdown to a departure time with no timetable behind it is how a boat
// gets missed. Stamped by jori-calendar as private extended properties.
const NOW = ms("2030-03-11T13:35:00Z");
const DEPART = "2030-03-11T14:00:00+00:00"; // 25 min after NOW
const ARRIVE = "2030-03-11T15:00:00+00:00";
const stamped = (priv) => ({ extendedProperties: { private: priv } });
const UNVERIFIED = ev("Ferry to Island", DEPART, ARRIVE, { location: "Pier 3", ...stamped({ jori_created: "1", jori_transit: "1", jori_transit_verified: "0" }) });
UNVERIFIED.start.timeZone = "UTC";
const VERIFIED = ev("Train 123", DEPART, ARRIVE, stamped({ jori_created: "1", jori_transit: "1", jori_transit_verified: "1", jori_transit_source: "https://rail.example/timetable" }));
const PLAIN = ev("Weekly sync", DEPART, ARRIVE, { location: "Room 4" });

test("transitTimeUnverified: only a departure without a verified stamp", () => {
  assert.equal(transitTimeUnverified(UNVERIFIED), true);
  assert.equal(transitTimeUnverified(ev("Bus 7", DEPART, ARRIVE, stamped({ jori_transit: "1" }))), true, "no verified stamp at all counts as unverified");
  assert.equal(transitTimeUnverified(VERIFIED), false);
  assert.equal(transitTimeUnverified(PLAIN), false);
  assert.equal(transitTimeUnverified(ev("Dinner", DEPART, ARRIVE, stamped({ jori_created: "1" }))), false);
});

test("an unverified departure gets no countdown: it says to check the timetable", () => {
  const [s] = upcomingSoon(filterScannableEvents([UNVERIFIED]), NOW);
  assert.equal(s.minsToStart, undefined);
  assert.equal(s.time_verified, false);
  assert.equal(s.listed_time, "14:00");
  const signal = soonSignal(s);
  assert.doesNotMatch(signal, /starts in|\d+\s*min/);
  assert.match(signal, /check the timetable/);
  assert.match(signal, /Ferry to Island/);
});

test("an unverified departure's listed time is in the event's own zone, never the calendar's offset", () => {
  // Google renders dateTime in the calendar's zone (here -05:00); the departure is 14:00 where it leaves.
  const abroad = ev("Ferry to Island", "2030-03-11T08:00:00-05:00", "2030-03-11T09:00:00-05:00",
    stamped({ jori_transit: "1", jori_transit_verified: "0" }));
  abroad.start.timeZone = "Etc/GMT-1";
  const [s] = upcomingSoon(filterScannableEvents([abroad]), Date.parse("2030-03-11T12:35:00Z"));
  assert.equal(s.listed_time, "14:00");
  // No zone on the event: no time at all, rather than one that may be hours off.
  const bare = ev("Bus 7", DEPART, ARRIVE, stamped({ jori_transit: "1" }));
  delete bare.start.timeZone;
  const [b] = upcomingSoon(filterScannableEvents([bare]), NOW);
  assert.equal(b.listed_time, null);
  assert.ok(soonSignal(b).includes('"Bus 7" is on the calendar, but that departure time was never checked'));
});

test("a verified departure and an ordinary event count down exactly as before", () => {
  const soon = upcomingSoon(filterScannableEvents([VERIFIED, PLAIN]), NOW);
  assert.deepEqual(soon, [
    { summary: "Train 123", minsToStart: 25, location: null },
    { summary: "Weekly sync", minsToStart: 25, location: "Room 4" },
  ]);
  assert.equal(soonSignal(soon[0]), '"Train 123" starts in 25min');
  assert.equal(soonSignal(soon[1]), '"Weekly sync" starts in 25min at Room 4');
});

test("the 10-60 minute window is unchanged for every kind of event", () => {
  for (const e of [UNVERIFIED, VERIFIED, PLAIN]) {
    assert.equal(upcomingSoon(filterScannableEvents([e]), ms("2030-03-11T13:55:00Z")).length, 0, "5 min out: too late");
    assert.equal(upcomingSoon(filterScannableEvents([e]), ms("2030-03-11T12:30:00Z")).length, 0, "90 min out: too early");
  }
});

test("end to end: the lane reads the stamp from gog's event JSON", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hum-calendar-home-"));
  try {
    const at = (min) => new Date(Date.now() + min * 60000).toISOString();
    const events = path.join(home, "events.json");
    fs.writeFileSync(events, JSON.stringify({ events: [
      { ...UNVERIFIED, start: { dateTime: at(25) }, end: { dateTime: at(85) } },
    ] }));
    // A stand-in for gog: never the network, it prints the fixture.
    const gog = path.join(home, "gog.mjs");
    fs.writeFileSync(gog, `#!/usr/bin/env node\nimport fs from "node:fs";\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(events)}, "utf8"));\n`);
    fs.chmodSync(gog, 0o755);
    const r = spawnSync(process.execPath, [HARVESTER.pathname], {
      input: JSON.stringify({ situation: {} }),
      encoding: "utf8",
      // JORI_HOME: the lane's state files land in the temp dir; preview: no writes at all.
      env: { ...process.env, GOG_BIN: gog, JORI_HOME: home, JORI_LOCAL_DIR: LOCAL, HUM_HARVEST_PREVIEW: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    const cand = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(cand.topic, "calendar");
    assert.match(cand.signal, /check the timetable/);
    assert.doesNotMatch(cand.signal, /starts in/);
    assert.equal(cand.supporting_data.soon[0].time_verified, false);
    assert.equal(cand.supporting_data.soon[0].minsToStart, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("situationStaleReason drops departures while moving and closed task refs", async () => {
  const { situationStaleReason } = await import("../agent/scripts/hum-harvesters/_common.mjs");
  assert.match(situationStaleReason({ kind: "DEPARTURE" }, { where: { activity: "driving" } }, {}), /moving/);
  assert.equal(situationStaleReason({ kind: "DEPARTURE" }, { where: { activity: "stationary" } }, {}), null);
  const ctx = { knowledge: { tasks: [{ id: "t1", status: "needsAction" }, { id: "t2", status: "completed" }] } };
  assert.equal(situationStaleReason({ task_ref: "t1" }, {}, ctx), null);
  assert.match(situationStaleReason({ task_ref: "t2" }, {}, ctx), /no longer open/);
  assert.match(situationStaleReason({ task_ref: "gone" }, {}, ctx), /no longer open/);
  assert.equal(situationStaleReason({ task_ref: "gone" }, {}, {}), null);
});

// ── Who an event is with: its own organizer and guests, never its title ────
// A first name in a title identifies nobody. The candidate carries what the
// event itself lists, so a composer can check a name against it.
const OWNER_EMAIL = "owner@example.org";
const WITH_GUEST = ev("Sam / Owner - project", "2030-03-11T14:00:00Z", "2030-03-11T14:30:00Z", {
  organizer: { email: "pat.lane@otherfirm.example", displayName: "Pat Lane" },
  attendees: [
    { email: OWNER_EMAIL, self: true, responseStatus: "accepted" },
    { email: "sam.guest@mail.example", responseStatus: "needsAction" },
    { email: "room-4@resource.calendar.google.com", resource: true }, // kernel-guard-ok: the calendar service's own room-address domain
    { email: "pat.lane@otherfirm.example", organizer: true },
  ],
});

test("eventPeople: the organizer and guests, not the owner, rooms or groups, and nobody twice", () => {
  const p = eventPeople(WITH_GUEST, { ownerEmails: [OWNER_EMAIL] });
  assert.deepEqual(p.organizer, { name: "Pat Lane", email: "pat.lane@otherfirm.example" });
  assert.deepEqual(p.guests, [{ name: null, email: "sam.guest@mail.example" }]);
  assert.equal(eventPeopleLine(WITH_GUEST, { ownerEmails: [OWNER_EMAIL] }),
    "invite from Pat Lane <pat.lane@otherfirm.example>; guests: sam.guest@mail.example");
});

test("eventPeople: an event only the owner is on names nobody", () => {
  const solo = { summary: "Sam / Owner", organizer: { email: OWNER_EMAIL, self: true }, attendees: [{ email: OWNER_EMAIL, self: true }] };
  assert.equal(eventPeopleLine(solo, { ownerEmails: [OWNER_EMAIL] }), "");
  assert.equal(eventPeopleLine({ summary: "x" }), "");
  assert.equal(eventPeopleLine(null), "");
  assert.equal(eventPeopleLine({ organizer: { email: "abc@group.calendar.google.com" } }), "", "a calendar-service address is not a person"); // kernel-guard-ok: the calendar service's own group-address domain
});

test("the candidate carries who the event lists; an event with no one listed reads exactly as before", () => {
  const [s] = upcomingSoon(filterScannableEvents([WITH_GUEST]), Date.parse("2030-03-11T13:35:00Z"));
  assert.match(s.people, /invite from Pat Lane <pat\.lane@otherfirm\.example>/);
  assert.match(s.people, /guests: sam\.guest@mail\.example/);
  assert.match(soonSignal(s), /the event itself lists: invite from Pat Lane/);
  const [b] = upcomingSoon(filterScannableEvents([ev("Weekly sync", "2030-03-11T14:00:00Z", "2030-03-11T15:00:00Z")]), Date.parse("2030-03-11T13:35:00Z"));
  assert.equal(b.people, undefined);
  assert.equal(soonSignal(b), '"Weekly sync" starts in 25min');
});
