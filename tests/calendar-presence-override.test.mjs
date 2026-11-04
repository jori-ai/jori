// calendar-presence-override.test.mjs — "the calendar beats the travel
// database": lib/calendar-presence.js (pure half),
// lib/calendar-presence-refresh.mjs (producer, model injected) and the
// shared in-city verdict in lib/presence.js.
//
// Run: node --test tests/calendar-presence-override.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cal-presence-test-"));
process.env.CALENDAR_PRESENCE_FILE = path.join(tmp, "overrides.json");
delete process.env.CALENDAR_PRESENCE;
// A synthetic installation: no local config, home zone fixed (days are home-zone days).
process.env.JORI_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cal-presence-local-"));
process.env.JORI_TZ = "Europe/London";

const require = createRequire(import.meta.url);
const CAL = require("../lib/calendar-presence.js");
const P = require("../lib/presence.js");
const R = await import("../lib/calendar-presence-refresh.mjs");

// The motivating kind of day: timeline in the home city all day; a day trip by
// train in the afternoon and evening. Every location null — only titles say where.
const NOW = Date.parse("2026-09-23T13:00:00Z");
const SEGMENTS = [{ id: "a", metro: "london", arrive_at: "2026-08-26T18:11:00Z", depart_at: "2026-09-30T18:55:00Z", source: "flights" }];
const ev = (summary, start, end, extra = {}) => ({ summary, start: { dateTime: start }, end: { dateTime: end }, location: null, ...extra });
const DAY_TRIP = [
  ev("Train to Oxford", "2026-09-23T15:00:00+01:00", "2026-09-23T17:10:00+01:00"),
  ev("Walk to Pub", "2026-09-23T18:15:00+01:00", "2026-09-23T18:45:00+01:00"),
  ev("Dinner with Sam & Alex", "2026-09-23T18:45:00+01:00", "2026-09-23T20:15:00+01:00"),
  ev("Train back", "2026-09-23T20:45:00+01:00", "2026-09-23T23:00:00+01:00"),
  ev("Team call", "2026-09-24T10:00:00+01:00", "2026-09-24T11:00:00+01:00"),
];
const at = (iso) => Date.parse(iso);
const KERNEL_DEF = fs.readFileSync(new URL("../agent/config/jev-questions/calendar-presence.json", import.meta.url), "utf8");

test("groupDays: one question per (home-zone day, timeline city), events in order", () => {
  const groups = CAL.groupDays(DAY_TRIP, (ms) => P.resolvePresenceAt(ms, SEGMENTS, [], NOW));
  assert.deepEqual(groups.map((g) => g.key), ["2026-09-23|london", "2026-09-24|london"]);
  assert.deepEqual(groups[0].events.map((e) => e.title), ["Train to Oxford", "Walk to Pub", "Dinner with Sam & Alex", "Train back"]);
});

test("groupDays: no group where the timeline knows nothing (weaken-only: unknown stays unknown)", () => {
  const groups = CAL.groupDays(DAY_TRIP, () => ({ metro: null, source: "unknown" }));
  assert.equal(groups.length, 0);
});

test("groupDays: cancelled and declined events are not read", () => {
  const evs = [
    ev("Train to Bath", "2026-09-25T09:00:00+01:00", "2026-09-25T13:00:00+01:00", { status: "cancelled" }),
    ev("Flight to Dublin", "2026-09-25T09:00:00+01:00", "2026-09-25T13:00:00+01:00", { attendees: [{ self: true, responseStatus: "declined" }] }),
  ];
  assert.equal(CAL.groupDays(evs, (ms) => P.resolvePresenceAt(ms, SEGMENTS, [], NOW)).length, 0);
});

test("deriveWindow: earliest evidence start → latest evidence end, clipped to the day", () => {
  const [g] = CAL.groupDays(DAY_TRIP, (ms) => P.resolvePresenceAt(ms, SEGMENTS, [], NOW));
  const w = CAL.deriveWindow(g, [0, 1, 2, 3]);
  assert.equal(w.from, "2026-09-23T14:00:00.000Z");
  assert.equal(w.to, "2026-09-23T22:00:00.000Z");
  assert.equal(w.base, "london");
  assert.equal(CAL.deriveWindow(g, []), null);
});

test("applyCalendarOverride: AWAY inside the window, untouched outside it (an instant, not a date)", () => {
  const [g] = CAL.groupDays(DAY_TRIP, (ms) => P.resolvePresenceAt(ms, SEGMENTS, [], NOW));
  const doc = { windows: [CAL.deriveWindow(g, [0, 3])] };
  const res = (iso) => CAL.applyCalendarOverride(P.resolvePresenceAt(at(iso), SEGMENTS, [], NOW), at(iso), doc);
  assert.equal(res("2026-09-23T18:00:00Z").metro, "elsewhere", "19:00 local, on the day trip");
  assert.equal(res("2026-09-23T18:00:00Z").source, "calendar");
  assert.equal(res("2026-09-23T09:00:00Z").metro, "london", "10:00 local that morning the user is still home");
  assert.equal(res("2026-09-24T09:00:00Z").metro, "london", "next day untouched");
});

test("applyCalendarOverride is weaken-only: never applies to unknown, transit, or another base", () => {
  const doc = { windows: [{ date: "2026-09-23", base: "london", from: "2026-09-23T14:00:00Z", to: "2026-09-23T22:00:00Z", evidence: [] }] };
  const t = at("2026-09-23T18:00:00Z");
  for (const res of [{ metro: null, source: "unknown" }, { metro: "transit", source: "db" }, { metro: "rome", source: "db" }]) {
    assert.deepEqual(CAL.applyCalendarOverride(res, t, doc), res);
  }
  // An ambiguous stay is decided against its canonical candidate list.
  const amb = { metro: null, ambiguous: true, candidates: ["rome", "london"], source: "db" };
  assert.deepEqual(CAL.applyCalendarOverride(amb, t, doc), amb, "london|rome ≠ london");
  const ambDoc = { windows: [{ ...doc.windows[0], base: "london|rome" }] };
  assert.equal(CAL.applyCalendarOverride(amb, t, ambDoc).metro, "elsewhere");
});

test("inCityVerdict: the calendar 'elsewhere' reads AWAY; unknown fails open unless strict", () => {
  assert.equal(P.inCityVerdict("london", { metro: "elsewhere", source: "calendar" }).verdict, "AWAY");
  assert.equal(P.inCityVerdict("london", { metro: "elsewhere", source: "calendar" }).in, false);
  assert.equal(P.inCityVerdict("london", { metro: "london" }).verdict, "IN");
  assert.equal(P.inCityVerdict("london", { metro: null }).in, true);
  assert.equal(P.inCityVerdict("london", { metro: null }, { strict: true }).in, false);
  assert.equal(P.inCityVerdict("rome", { metro: null, ambiguous: true, candidates: ["london", "rome"] }).verdict, "IN(ambiguous)");
  assert.equal(P.inCityVerdict("dublin", { metro: null, ambiguous: true, candidates: ["london", "rome"] }).verdict, "AWAY");
});

test("loadOverrides: no file, a stale file or the off switch → no interpretation", () => {
  const f = path.join(tmp, "load.json");
  assert.equal(CAL.loadOverrides({ file: f }), null, "missing");
  fs.writeFileSync(f, JSON.stringify({ generated_at: new Date(NOW).toISOString(), windows: [] }));
  assert.ok(CAL.loadOverrides({ file: f, nowMs: NOW + 60_000 }), "fresh");
  assert.equal(CAL.loadOverrides({ file: f, nowMs: NOW + CAL.MAX_AGE_MS + 1 }), null, "older than MAX_AGE");
  fs.writeFileSync(f, "{not json");
  assert.equal(CAL.loadOverrides({ file: f }), null, "malformed");
  process.env.CALENDAR_PRESENCE = "off";
  try {
    fs.writeFileSync(f, JSON.stringify({ generated_at: new Date().toISOString(), windows: [] }));
    assert.equal(CAL.loadOverrides({ file: f }), null, "switched off");
  } finally { delete process.env.CALENDAR_PRESENCE; }
});

test("interpretAnswers: away + flagged events; away with nothing flagged is no decision", () => {
  const b = (p) => ({ type: "noul", noul: p });
  const J = { boolOf: (a) => (a ? a.noul >= 0.5 : null), answerConfidence: (a) => (a ? Math.max(a.noul, 1 - a.noul) : 0) };
  assert.deepEqual(R.interpretAnswers({ away: b(0.95), e0: b(0.9), e1: b(0.2), e2: b(0.8) }, 3, J), { value: [0, 2], confidence: 0.95 });
  assert.deepEqual(R.interpretAnswers({ away: b(0.1), e0: b(0.9) }, 1, J), { value: [], confidence: 0.9 });
  assert.equal(R.interpretAnswers({ away: b(0.95), e0: b(0.1) }, 1, J).confidence, 0);
});

test("groupQuestions: one boolean per event plus the day, from the site's templates", () => {
  // The kernel's definition, with the owner placeholder filled as jevSiteDef does.
  const def = JSON.parse(KERNEL_DEF.split("{{owner_name}}").join("the user"));
  const [g] = CAL.groupDays(DAY_TRIP, (ms) => P.resolvePresenceAt(ms, SEGMENTS, [], NOW));
  const q = R.groupQuestions(g, def);
  assert.deepEqual(Object.keys(q), ["away", "e0", "e1", "e2", "e3"]);
  assert.ok(q.e2.instructions.includes("event number 2"));
  assert.ok(q.away.instructions.includes("london"));
  assert.ok(!JSON.stringify(q).includes("{{"), "every placeholder filled");
});

test("buildOverrides: the model decides, code derives the window; decisions are cached by what the model saw", async () => {
  let calls = 0;
  const decideDay = async (g) => {
    calls++;
    // Stand-in model: the day-trip day is away with all four events; anything else is not.
    return g.date === "2026-09-23" ? { flagged: [0, 1, 2, 3], cacheable: true, decided_by: "jev" } : { flagged: [], cacheable: true, decided_by: "jev" };
  };
  const inject = { nowMs: NOW, segments: SEGMENTS, flights: [], fetchEvents: async () => DAY_TRIP, decideDay };
  const doc = await R.buildOverrides(inject);
  assert.equal(calls, 2);
  assert.equal(doc.windows.length, 1);
  assert.equal(doc.windows[0].from, "2026-09-23T14:00:00.000Z");
  assert.equal(doc.incomplete, false);
  // Second build with the same calendar: nothing re-asked.
  const again = await R.buildOverrides({ ...inject, prev: doc });
  assert.equal(calls, 2);
  assert.equal(again.stats.reused, 2);
  // A changed day is re-asked; the unchanged one is not.
  const moved = DAY_TRIP.map((e, i) => (i === 3 ? ev("Train back", "2026-09-23T21:45:00+01:00", "2026-09-24T00:00:00+01:00") : e));
  const third = await R.buildOverrides({ ...inject, prev: again, fetchEvents: async () => moved });
  assert.equal(calls, 3);
  assert.equal(third.windows[0].to, "2026-09-23T23:00:00.000Z", "clipped to the home-zone day");
});

test("buildOverrides: a transport error is not cached and marks the build incomplete; Jev off is not a retry", async () => {
  const inject = { nowMs: NOW, segments: SEGMENTS, flights: [], fetchEvents: async () => DAY_TRIP };
  const err = await R.buildOverrides({ ...inject, decideDay: async () => ({ flagged: [], cacheable: false, decided_by: "none (jev-error)" }) });
  assert.equal(err.incomplete, true);
  assert.deepEqual(err.days, {});
  const off = await R.buildOverrides({ ...inject, decideDay: async () => ({ flagged: [], offline: true }) });
  assert.equal(off.incomplete, false);
  assert.equal(off.windows.length, 0);
  const threw = await R.buildOverrides({ ...inject, decideDay: async () => { throw new Error("boom"); } });
  assert.equal(threw.windows.length, 0);
});

test("maybeRefresh: writes the file, then reads as fresh; a broken calendar backs off and never throws", async () => {
  const file = path.join(tmp, "refresh.json");
  const inject = { nowMs: Date.now(), segments: SEGMENTS, flights: [], fetchEvents: async () => [], decideDay: async () => null };
  const r1 = await R.maybeRefresh({ file, ...inject });
  assert.equal(r1.refreshed, true);
  assert.equal((await R.maybeRefresh({ file, ...inject })).reason, "fresh");
  const file2 = path.join(tmp, "broken.json");
  const r2 = await R.maybeRefresh({ file: file2, ...inject, fetchEvents: async () => { throw new Error("gog down"); } });
  assert.equal(r2.refreshed, false);
  assert.match(r2.reason, /gog down/);
  assert.equal(R.needsRefresh({ file: file2 }), false, "backs off after a failure");
  assert.equal(fs.existsSync(`${file2}.lock`), false, "lock released");
});

test("groupState: the model sees each event's note, so a guest reservation at a property the user lets out reads as one", () => {
  const evs = [{
    summary: "Stay at Example Seaside Villa with Pool",
    start: { date: "2026-09-23" }, end: { date: "2026-09-24" },
    description: "RentalSite. Confirmation: HMAAAA1111. Check-in 2026-09-23, check-out 2026-09-24. Guests: 2.",
    transparency: "transparent",
  }];
  const [g] = CAL.groupDays(evs, (ms) => P.resolvePresenceAt(ms, SEGMENTS, [], NOW));
  const st = R.groupState(g);
  assert.match(st.events[0].note, /Guests: 2/);
  assert.equal(st.events[0].marked_free, true);
  const q = JSON.parse(KERNEL_DEF);
  for (const k of ["away_question", "event_question"]) assert.ok(/Guest (reservations|stays) at a property/.test(q[k].instructions), k);
});
