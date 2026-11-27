// daily-summary-calendar-attended.test.mjs — a busy calendar event the user
// was at is its own line in the timeline, even at the same place.
//
// 2026-11-27: the user asked that busy events on the calendar that actually
// happened be on the day's timeline as separate events, even when they were
// not in a different location. A home stop carried one calendar event at most
// ("on your calendar"); a second and third meeting held at home were listed
// under "Events not matched to a location".
//
// Run: node --test tests/daily-summary-calendar-attended.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const render = require(path.join(ROOT, "lib/daily-summary-render.js"));
const resolve = require(path.join(ROOT, "lib/resolve-day.js"));
const { attendedEvents, eventsNotMatched, heldCalendarEvent, splitOnMeetings } = render._internal;
const { busyCalendarEvents } = resolve._internal;

const TZ = "America/New_York";
const iso = (hm) => `2026-11-25T${hm}:00-05:00`;
const ms = (hm) => Date.parse(iso(hm));
const ev = (summary, s, e, extra = {}) => ({ summary, start: iso(s), end: iso(e), location: null, ...extra });

function stop(id, s, e, title, extra = {}) {
  return { id, start: s, end: e, start_ts_ms: ms(s), end_ts_ms: ms(e), duration_min: Math.round((ms(e) - ms(s)) / 60000),
    place: { name: title, source: "confirmed_stop", address: extra.address || null }, companions: [],
    provenance: { title, certainty: "known", title_kind: "venue", tier: "CONFIRMED" }, ...extra };
}

const STANDUP = ev("Team standup", "09:30", "10:00", { location: "https://zoom.us/j/123" });
const DAN = ev("Dan / Moshe catch-up", "11:00", "12:00");
const PLUMBER = ev("Plumber", "14:00", "15:00", { location: "12 Palm Way, Miami" });
const DINNER = ev("Dinner at Bistro Example", "19:00", "21:00", { location: "Bistro Example, Brickell" });

function day(extra = {}) {
  const home = stop("s-1", "07:00", "18:30", "Home", { address: "12 Palm Way, Miami",
    calendar_event: { ...DAN, location_match: false, duration_min: 60, event_share: 1 } });
  const bistro = stop("s-2", "19:05", "21:10", "Bistro Example", {
    calendar_event: { ...DINNER, location_match: true, physical: true, duration_min: 120, event_share: 1 } });
  return { date: "2026-11-25", tz: TZ, tzs: [TZ], stops: [home, bistro], travel_legs: [],
    unmatched_calendar_events: [{ ...STANDUP, physical: false }, { ...PLUMBER, physical: true }],
    calendar_busy: [STANDUP, DAN, PLUMBER, DINNER], ...extra };
}

test("a meeting at the home stop splits it into blocks: Home, Meeting, Home", () => {
  const d = day();
  const a = attendedEvents(d);
  assert.deepEqual((a.byStop["s-1"] || []).map(e => e.summary), ["Team standup", "Dan / Moshe catch-up", "Plumber"]);
  // the dinner IS the bistro stop: its header, not a block of its own
  assert.equal(a.byStop["s-2"], undefined);
  const html = render.assemble(render.buildSkeleton(d, {}), { prose: { "s-1": "A day at home." } });
  const heads = [...html.matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)].map(m => m[1].replace(/<[^>]*>/g, "").trim());
  assert.deepEqual(heads, [
    "7:00am · Home",
    "9:30am · Team standup · 30 min · at Home",
    "10:00am · Home",
    "11:00am · Dan / Moshe catch-up · 1h · at Home",
    "12:00pm · Home",
    "2:00pm · Plumber · 1h · at Home",
    "3:00pm · Home",
    "7:05pm · Bistro Example",
  ]);
  // the stop's prose prints once, in its first block; no journey between blocks of one stop
  assert.equal(html.split("A day at home.").length - 1, 1);
  assert.ok(!html.includes("on your calendar"), "a busy event the user was at is not 'on your calendar'");
  assert.ok(!html.includes("Events not matched to a location"));
  assert.equal(heldCalendarEvent(d, d.stops[0]), null);
  assert.deepEqual(eventsNotMatched(d), []);
});

test("JORI_CAL_SPLIT=0 lists each one as a line under its stop instead", () => {
  process.env.JORI_CAL_SPLIT = "0";
  try {
    const html = render.assemble(render.buildSkeleton(day(), {}), {});
    for (const t of ["9:30am-10:00am</b> Team standup · 30 min", "11:00am-12:00pm</b> Dan / Moshe catch-up · 1h", "2:00pm-3:00pm</b> Plumber · 1h"]) {
      assert.ok(html.includes(t), `${t}\n${html}`);
    }
    assert.ok(!html.includes('class="meeting"'));
  } finally { delete process.env.JORI_CAL_SPLIT; }
});

test("a meeting at the start of a stop opens it; the stop's prose goes to the next block", () => {
  const early = ev("Breakfast call", "07:00", "07:30");
  const d = day({ calendar_busy: [early] });
  const html = render.assemble(render.buildSkeleton(d, {}), { prose: { "s-1": "A day at home." } });
  const heads = [...html.matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)].map(m => m[1].replace(/<[^>]*>/g, "").trim());
  assert.deepEqual(heads.slice(0, 2), ["7:00am · Breakfast call · 30 min · at Home", "7:30am · Home"]);
  assert.ok(html.indexOf("A day at home.") > html.indexOf("7:30am · Home".slice(0, 6)));
  const { stops } = splitOnMeetings(d, d.stops);
  assert.equal(stops[1].id, "s-1");
  assert.equal(stops[0].id, "s-1~0");
});

test("the wiki page splits the same way, and the manifest carries them on the stop", () => {
  const d = day();
  const md = render.buildMarkdown(d, {});
  assert.ok(md.includes("### 09:30-10:00 · **Team standup** · 30 min · at Home"), md);
  assert.ok(md.includes("### 14:00-15:00 · **Plumber** · 1h · at Home"), md);
  assert.ok(md.includes("### 15:00-18:30 · **Home**"), md);
  const m = render.buildManifest(d, {});
  assert.equal(m.stops.length, 2);
  assert.deepEqual(m.stops[0].calendar_attended.map(e => e.summary), ["Team standup", "Dan / Moshe catch-up", "Plumber"]);
  assert.deepEqual(m.unmatched_calendar_events, []);
});

test("an event placed somewhere else while GPS has the user home did not happen there", () => {
  const away = ev("Dentist", "15:30", "16:30", { location: "Coral Dental, 400 Ocean Dr" });
  const d = day({ calendar_busy: [STANDUP, DAN, PLUMBER, DINNER, away],
    unmatched_calendar_events: [{ ...STANDUP, physical: false }, { ...PLUMBER, physical: true }, { ...away, physical: true }] });
  assert.ok(!(attendedEvents(d).byStop["s-1"] || []).some(e => e.summary === "Dentist"));
  assert.deepEqual(eventsNotMatched(d).map(e => e.summary), ["Dentist"]);
});

test("free events, and a day resolved before calendar_busy, list nothing new", () => {
  const d = day({ calendar_busy: undefined });
  assert.deepEqual(attendedEvents(d).byStop, {});
  // the old behaviour stands: the standup and plumber are unmatched, Dan is on your calendar
  assert.deepEqual(eventsNotMatched(d).map(e => e.summary), ["Team standup", "Plumber"]);
  assert.equal(heldCalendarEvent(d, d.stops[0]).summary, "Dan / Moshe catch-up");
});

test("an event no stop holds half of is not listed as attended", () => {
  const late = ev("Late sync", "18:15", "19:15");
  const d = day({ calendar_busy: [late] });
  assert.deepEqual(attendedEvents(d).byStop, {});
});

test("a call the call reader left out is not listed as attended", () => {
  const d = day({ calls_left_out: [{ start: STANDUP.start, end: STANDUP.end, why: "Zoom has no record of the other side" }] });
  assert.ok(!(attendedEvents(d).byStop["s-1"] || []).some(e => e.summary === "Team standup"));
  assert.deepEqual(eventsNotMatched(d).map(e => e.summary), ["Team standup"]);
});

test("busyCalendarEvents keeps timed busy meetings only", () => {
  const g = (summary, extra = {}) => ({ summary, start: { dateTime: iso("10:00") }, end: { dateTime: iso("11:00") }, ...extra });
  const out = busyCalendarEvents([
    g("Busy meeting"),
    g("Free hold", { transparency: "transparent" }),
    g("Declined", { self_response: "declined" }),
    g("Cancelled", { status: "cancelled" }),
    g("Office", { event_type: "workingLocation" }),
    { summary: "All day", start: { date: "2026-11-25" }, end: { date: "2026-11-26" } },
    g("Tiny", { end: { dateTime: iso("10:03") } }),
  ]);
  assert.deepEqual(out.map(e => e.summary), ["Busy meeting"]);
});

test("a call falls into the block its time is in", () => {
  const d = day({ calls: [{ who: "Sam", source: "zoom", status: "held", minutes: 20, start: iso("16:00"), end: iso("16:20") }] });
  const html = render.assemble(render.buildSkeleton(d, {}), {});
  const after = html.slice(html.indexOf("3:00pm · <b>Home"));
  assert.ok(after.indexOf("Call with Sam") > 0 && after.indexOf("Call with Sam") < after.indexOf("Bistro Example"), html);
  assert.ok(html.indexOf("Call with Sam") > html.indexOf("Plumber"));
});
