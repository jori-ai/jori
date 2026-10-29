// daily-summary-calls.test.mjs — a recurring meeting's calls in the daily summary.
//
// Requirement: calls with a configured recurring counterpart (when they happen)
// are in the daily summary, ideally from Zoom, else from the calendar. Before,
// a call only appeared under "Events not matched to a location". Now a call is
// its own line in the timeline at its time, with its length and where the user
// took it, and it leaves that list. It is never a stop.
//
// The kernel's recurring-meeting module (lib/meeting-call.mjs) with a synthetic
// meeting ("Sam", series set in Chicago) and a synthetic day abroad.
//
// Run: node --test tests/daily-summary-calls.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const render = require(path.join(ROOT, "lib/daily-summary-render.js"));
const MC = await import(path.join(ROOT, "lib/meeting-call.mjs"));
const { meetings } = await import(path.join(ROOT, "lib/meetings.mjs"));
const { eventsNotMatched, callWhereText, placeCalls } = render._internal;

// A synthetic recurring meeting: a call with "Sam" in the user's own room, the
// series set in Chicago (the notes are filed by Chicago date).
const M = meetings({ config: { meetings: [{ id: "coach", name: "Sam", calendar_match: ["sam"], default_tz: "America/Chicago",
  zoom: { room_id: "1234567890", participant: { emails: ["sam@example.org"], names: ["sam"] } } }] } })[0];
const oc = { ...MC,
  calendarCandidates: (e, o = {}) => MC.calendarCandidates(e, { m: M, ...o }),
  zoomCalls: (a = {}) => MC.zoomCalls({ m: M, ...a }),
  callsForDay: (o = {}) => MC.callsForDay({ m: M, knownId: null, ...o }),
  settleCalls: (k, r, o = {}) => MC.settleCalls(k, r, { who: M.name, ...o }),
  callWhen: (c, tz) => MC.callWhen(c, tz, M.tz),
  noteDates: (c, tz) => MC.noteDates(c, tz, M.tz),
  readingState: (c, o) => MC.readingState(c, { home: M.tz, ...o }),
  readReading: (date, kept, file) => MC.readReading(M, date, kept, file) };

const TZ = "Europe/Athens";
const ZOOM = "https://us02web.zoom.us/j/1234567890";
const ms = (iso) => Date.parse(iso);

// The two instances on Oct 20 as gog returns them (the Monday one was moved
// from 23:00 to 00:00 local, i.e. 4pm Chicago).
function gogEvent(id, start, end, extra = {}) {
  return { id, recurringEventId: "t34_R20261002T200000", status: "confirmed", summary: "Sam <> Jordan",
    location: ZOOM, start: { dateTime: start, timeZone: "America/Chicago" }, end: { dateTime: end, timeZone: "America/Chicago" },
    organizer: { email: "sam@example.org" },
    attendees: [{ email: "sam@example.org", organizer: true, responseStatus: "accepted" },
                { email: "user@example.com", self: true, responseStatus: "accepted" }], ...extra };
}
const MON = gogEvent("t34_20261019T200000Z", "2026-10-20T00:00:00+03:00", "2026-10-20T00:30:00+03:00",
  { originalStartTime: { dateTime: "2026-10-19T23:00:00+03:00" } });
const TUE = gogEvent("t34_20261020T200000Z", "2026-10-20T23:00:00+03:00", "2026-10-20T23:30:00+03:00");
const POOL = { summary: "Pool service at the house", start: { dateTime: "2026-10-20T17:00:00+03:00" }, end: { dateTime: "2026-10-20T20:00:00+03:00" } };

function stop(id, start, end, title, extra = {}) {
  const s = ms(`2026-10-20T${start}:00+03:00`), e = ms(`2026-10-20T${end}:00+03:00`);
  return { id, start, end, start_ts_ms: s, end_ts_ms: e, duration_min: Math.round((e - s) / 60000),
    place: { name: title, source: "confirmed_stop" }, companions: [],
    provenance: { title, certainty: "known", title_kind: "venue", tier: "CONFIRMED" }, ...extra };
}
// The Oct 20 shape: the night at the flat from 00:09, a restaurant, back at the flat
// from 22:16 (resolve-day holds the day's last open visit to midnight).
function oct20(calls) {
  return {
    date: "2026-10-20", tz: TZ, tzs: [TZ],
    stops: [
      stop("s-p1", "00:09", "08:50", "The Rental Flat"),
      stop("s-6", "20:06", "22:09", "Taverna Nine", { place: { name: "Taverna Nine", source: "user_confirmed" },
        provenance: { title: "Taverna Nine", certainty: "answered", title_kind: "venue", tier: "CONFIRMED" } }),
      stop("s-p4", "22:16", "23:59", "The Rental Flat"),
    ],
    travel_legs: [],
    unmatched_calendar_events: [
      { summary: "Sam <> Jordan", location: ZOOM, start: "2026-10-20T23:00:00+03:00", end: "2026-10-20T23:30:00+03:00", duration_min: 30, physical: false },
      { summary: "Pool service at the house", location: null, start: "2026-10-20T17:00:00+03:00", end: "2026-10-20T20:00:00+03:00", duration_min: 180, physical: false },
    ],
    calls,
  };
}
function settledOct20(verdicts = { MON: "no_word", TUE: "held" }) {
  const cands = oc.calendarCandidates([MON, TUE, POOL], { date: "2026-10-20", tz: TZ });
  const reading = { read_by: "sonnet", verdicts: {
    [oc.callKey(cands[0])]: { verdict: verdicts.MON }, [oc.callKey(cands[1])]: { verdict: verdicts.TUE } } };
  return oc.settleCalls(cands, reading);
}

test("Oct 20: both instances are the day's calls, the moved one at its new time", () => {
  const c = oc.calendarCandidates([MON, TUE, POOL], { date: "2026-10-20", tz: TZ });
  assert.equal(c.length, 2);
  assert.equal(c[0].start, "2026-10-19T21:00:00.000Z");
  assert.equal(c[0].moved_from, "2026-10-19T20:00:00.000Z");
  assert.equal(c[1].minutes, 30);
});

test("Oct 20: each call is its own line at its time, where the user took it, and leaves 'Events not matched'", () => {
  const { calls } = settledOct20();
  const day = oct20(calls);
  const html = render.assemble(render.buildSkeleton(day, {}), {});
  const lines = html.split("\n").filter((l) => l.includes('class="call"'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /<b>12:00am-12:30am<\/b> Call with Sam · 30 min · at The Rental Flat/);
  // in a stop it is a bullet in that stop's list; its header already names the place
  assert.match(lines[1], /<li class="call"><b>11:00pm-11:30pm<\/b> Call with Sam · 30 min <span/);
  assert.match(lines[0], /calendar times/);
  // the midnight call comes before the night's first header, the 11pm call after the last stop
  const idx = (needle) => html.indexOf(needle);
  assert.ok(idx("12:00am-12:30am") < idx("12:09am"));
  assert.ok(idx("11:00pm-11:30pm") > idx("10:16pm"));
  assert.ok(idx("11:00pm-11:30pm") < idx("Events not matched"));
  // listed once: the unmatched list keeps the pool guys and drops the call
  assert.deepEqual(eventsNotMatched(day).map((e) => e.summary), ["Pool service at the house"]);
  assert.ok(!html.includes("Sam &lt;&gt; Jordan"));
  // dash-free (email-send blocks em and en dashes)
  for (const l of lines) assert.ok(!/[–—]/.test(l), l);
});

test("a call is never a stop: not an <h3>, not in the stop count, not in the manifest's stops", () => {
  const { calls } = settledOct20();
  const day = oct20(calls);
  day.map_url = "https://example.test/map.png";
  const html = render.buildSkeleton(day, {});
  assert.equal((html.match(/<h3/g) || []).length, 3);
  assert.match(html, /3 stops/);
  const man = render.buildManifest(day, {});
  assert.equal(man.stops.length, 3);
  assert.equal(man.calls.length, 2);
  assert.equal(man.calls[1].status, "held");
  assert.equal(man.calls[1].where, "at The Rental Flat");
  assert.ok(!man.unmatched_calendar_events.some((e) => e.summary === "Sam <> Jordan"));
});

test("the wiki page carries the calls as lines, not as stop headings", () => {
  const { calls } = settledOct20();
  const md = render.buildMarkdown(oct20(calls), {});
  assert.match(md, /\*\*00:00-00:30\*\* Call with Sam · 30 min · at The Rental Flat · calendar times/);
  assert.match(md, /\*\*23:00-23:30\*\* Call with Sam/);
  assert.ok(!/### .*Call with Sam/.test(md));
  assert.ok(!md.includes("Sam <> Jordan"));
});

test("a call that straddles local midnight belongs to the day it began, and only that one", () => {
  const late = gogEvent("t34_late", "2026-10-20T23:45:00+03:00", "2026-10-21T00:15:00+03:00");
  assert.equal(oc.calendarCandidates([late], { date: "2026-10-20", tz: TZ }).length, 1);
  assert.equal(oc.calendarCandidates([late], { date: "2026-10-21", tz: TZ }).length, 0);
  const { calls } = oc.settleCalls(oc.calendarCandidates([late], { date: "2026-10-20", tz: TZ }), null);
  const html = render.assemble(render.buildSkeleton(oct20(calls), {}), {});
  assert.match(html, /<b>11:45pm-12:15am<\/b> Call with Sam · 30 min/);
});

test("an in-person event with Sam is not a call: only the series or a video link counts", () => {
  const dinner = { id: "d1", summary: "Dinner with Sam", location: "Taverna Nine, Old Town",
    start: { dateTime: "2026-10-20T20:00:00+03:00" }, end: { dateTime: "2026-10-20T21:00:00+03:00" } };
  const board = { id: "b1", summary: "Board meeting", location: "Example Co office", attendees: [{ email: "sam@example.org" }],
    start: { dateTime: "2026-10-20T15:00:00+03:00" }, end: { dateTime: "2026-10-20T16:00:00+03:00" } };
  const meet = { id: "m1", summary: "Sam sync", hangoutLink: "https://meet.google.com/abc",
    start: { dateTime: "2026-10-20T12:00:00+03:00" }, end: { dateTime: "2026-10-20T12:30:00+03:00" } };
  const series = { id: "t34_20261020T090000Z", recurringEventId: "t34_R20261002T200000", summary: "Sam <> Jordan",
    start: { dateTime: "2026-10-20T09:00:00+03:00" }, end: { dateTime: "2026-10-20T09:30:00+03:00" } };
  const got = oc.calendarCandidates([dinner, board, meet, series], { date: "2026-10-20", tz: TZ, knownId: "t34_R20261002T200000" });
  assert.deepEqual(got.map((c) => c.event_id), ["t34_20261020T090000Z", "m1"]);
});

test("a cancelled, declined or in-flight instance is left out by code", () => {
  const cancelled = gogEvent("a", "2026-10-20T23:00:00+03:00", "2026-10-20T23:30:00+03:00", { status: "cancelled" });
  const declined = gogEvent("b", "2026-10-20T12:00:00+03:00", "2026-10-20T12:30:00+03:00",
    { attendees: [{ email: "user@example.com", self: true, responseStatus: "declined" }] });
  const flying = gogEvent("c", "2026-10-20T16:00:00+03:00", "2026-10-20T16:30:00+03:00");
  const flights = [{ metro: "transit", place_label: "AAA→BBB (Example Air)", arrive_at: "2026-10-20T12:30:00Z", depart_at: "2026-10-20T23:00:00Z" }];
  const cands = oc.calendarCandidates([cancelled, declined, flying], { date: "2026-10-20", tz: TZ });
  const { kept, left_out } = oc.screenCandidates(cands, { flights });
  assert.equal(kept.length, 0);
  assert.deepEqual(left_out.map((c) => c.why).sort(), [
    "cancelled on the calendar", "you declined it on the calendar", "you were on a flight then (AAA→BBB (Example Air))"]);
  const { calls, left_out: out } = oc.settleCalls(kept, null, { leftOut: left_out });
  assert.equal(calls.length, 0);
  assert.equal(out.length, 3);
});

test("notes that say 'No call today' leave the call out (the model's reading), and it stays an unmatched event", () => {
  const notes = "## To Discuss (Upcoming)\n- [ ] x\n\n## Discussed\n\n### 2026-07-17\n- No call today — Sam messaged the user via Slack: a hire quit.\n\n### 2026-07-16\n- Candidate offer discussed.\n";
  assert.equal(oc.notesForDates(notes, ["2026-07-17"]),
    "### 2026-07-17\n- No call today — Sam messaged the user via Slack: a hire quit.");
  const state = { calls: [{ id: "c0", when: "Friday, Jul 17, 3:00pm to 3:30pm Chicago time" }],
    notes: oc.notesForDates(notes, ["2026-07-17"]), user_words: [] };
  // a Claude answer must quote words that are really there
  assert.equal(oc.validateReading({ calls: [{ id: "c0", verdict: "not_held", quote: "No call today" }] }, state), null);
  // lang-regex-ok: asserts on our own validator's error string
  assert.match(oc.validateReading({ calls: [{ id: "c0", verdict: "not_held", quote: "Sam was sick" }] }, state), /not in what it was shown/);
  // lang-regex-ok: asserts on our own validator's error string
  assert.match(oc.validateReading({ calls: [] }, state), /no answer for c0/);
  // a not_held reading drops it from the timeline
  const { calls, left_out } = settledOct20({ MON: "no_word", TUE: "not_held" });
  assert.equal(calls.length, 1);
  assert.equal(left_out[0].why, "your notes or your own words say it did not happen");
  const day = oct20(calls);
  assert.equal(render.buildSkeleton(day, {}).split('class="call"').length - 1, 1);
  assert.deepEqual(eventsNotMatched(day).map((e) => e.summary), ["Pool service at the house", "Sam <> Jordan"]);
});

test("with no reading the call is worded as on the calendar, never as a fact", () => {
  const cands = oc.calendarCandidates([TUE], { date: "2026-10-20", tz: TZ });
  const { calls } = oc.settleCalls(cands, null);
  assert.equal(calls[0].status, "scheduled");
  const html = render.assemble(render.buildSkeleton(oct20(calls), {}), {});
  assert.match(html, /Call with Sam · 30 min <span style="color:#999;">· on your calendar, not confirmed/);
  assert.equal(oc.readReading("2026-10-20", cands, "/nonexistent/meeting-calls.json"), null);
});

test("where: a walk names nothing, a guess is hedged, a far-off last stop is not assumed", () => {
  const call = { start: "2026-10-20T18:50:00+03:00", end: "2026-10-20T19:10:00+03:00" };
  const walk = stop("w", "18:42", "19:12", "Walk around the market", { excursion: { routed_m: 1800 },
    provenance: { title: "Walk around the market", certainty: "known", excursion: true } });
  assert.equal(callWhereText({ stops: [walk] }, call), "");
  const guess = stop("g", "18:40", "19:30", "Cafe Noir", { place: { name: "Cafe Noir", source: "google_places" },
    provenance: { title: "Cafe Noir", certainty: "guess", title_kind: "venue" } });
  assert.equal(callWhereText({ stops: [guess] }, call), "likely at Cafe Noir");
  const early = stop("e", "09:00", "10:00", "The Rental Flat");
  assert.equal(callWhereText({ stops: [early] }, call), "");
  // nothing overlaps: the last stop, hedged, and only when the day's path shows no movement since
  const flat = stop("f", "17:00", "18:30", "The Rental Flat");
  assert.equal(callWhereText({ stops: [flat], path: { spine: [] } }, call), "likely at The Rental Flat");
  assert.equal(callWhereText({ stops: [flat] }, call), "");
  assert.equal(callWhereText({ stops: [flat], path: { spine: [{ type: "leg", start_ms: ms("2026-10-20T18:35:00+03:00") }] } }, call), "");
});

test("placement: a call between two stops sits after the movement to the next, before it", () => {
  const a = stop("a", "10:00", "11:00", "The Rental Flat"), b = stop("b", "13:00", "14:00", "Taverna Nine");
  const p = placeCalls({ calls: [
    { start: "2026-10-20T10:30:00+03:00" }, { start: "2026-10-20T12:00:00+03:00" }, { start: "2026-10-20T08:00:00+03:00" }] }, [a, b]);
  assert.equal(p.before.length, 1);
  assert.equal(p.inStop.a.length, 1);
  assert.equal(p.afterLeg.a.length, 1);
});

test("zoom with no credentials is no answer, and the calendar's wording ships (the Zoom provider: meeting-call-zoom.test.mjs)", async () => {
  const none = { cfg: null, source: null, problem: null };
  assert.deepEqual(await oc.zoomCalls({ kept: [], creds: none }), { byKey: null, status: "not configured" });
  const r = await oc.callsForDay({ date: "2026-10-20", tz: TZ, events: [TUE], flights: [],
    zoom: (a) => oc.zoomCalls({ ...a, creds: none }) });
  assert.equal(r.calls[0].source, "calendar");
  assert.equal(r.calls[0].status, "scheduled");
});

test("the reading model is shown both clocks in words, never asked to convert", () => {
  const c = oc.calendarCandidates([MON], { date: "2026-10-20", tz: TZ });
  assert.equal(oc.callWhen(c[0], TZ),
    "Tuesday, Oct 20, 12:00am to 12:30am local time (Monday, Oct 19, 4:00pm to 4:30pm Chicago time)");
  const dates = oc.noteDates(c, TZ);
  assert.ok(dates.includes("2026-10-19") && dates.includes("2026-10-20") && dates.includes("2026-10-21"));
  // The notes are filed by the series' (Chicago) date, so code names each call's heading:
  // Monday's 4pm Chicago call starts Tuesday 12am local and must not claim Tuesday's notes.
  const both = oc.calendarCandidates([MON, TUE], { date: "2026-10-20", tz: TZ });
  const st = oc.readingState(both, { tz: TZ, notes: "", words: [] });
  assert.deepEqual(st.calls.map((x) => x.notes_heading), ["### 2026-10-19", "### 2026-10-20"]);
  assert.deepEqual(oc.userWords({ corrections: [{ evidence: "we skipped it" }], places: [{ evidence: "Taverna Nine" }] }),
    ["we skipped it", "Taverna Nine"]);
});

// Requirement: the daily summary includes a paragraph on what the call was
// about. prep attaches it as call.talk; the line stays code's own and the
// paragraph goes right under it, in the email and the wiki. And the call's time
// is formatted like the work lines above it (it once read "11:34pm-12:03am ·
// <b>Call with …</b> · ran 29 min" with the time plain, in another colour).
test("the call's time is set like the work lines above it: bold time, plain text, same colour and size", () => {
  const { dayCommits } = require(path.join(ROOT, "lib/daily-summary-commits.js"));
  const flat = { id: "s1", start: "22:39", end: "23:59", start_ts_ms: ms("2026-10-21T19:39:00Z"), end_ts_ms: ms("2026-10-21T20:59:00Z"),
    duration_min: 80, place: { name: "The Rental Flat" }, title: "The Rental Flat", title_certainty: "answered", provenance: { tier: "CONFIRMED" } };
  const call = { who: "Sam", source: "zoom", status: "held", minutes: 29, start: "2026-10-21T20:34:00Z", end: "2026-10-21T21:03:00Z" };
  const commits = dayCommits([{ sha: "5e1fa1a1", at: "2026-10-21T19:46:00Z", subject: "serpapi: connect" }], [flat], TZ);
  const day = { date: "2026-10-21", tz: TZ, tzs: [TZ], stops: [flat], travel_legs: [], commits, calls: [call] };
  const html = render.assemble(render.buildSkeleton(day, {}), { commits: [{ shas: ["5e1fa1a1"], text: "You connected SerpApi." }] });
  // lang-regex-ok: reads our own markup back
  const worked = html.match(/<ul class="worked" style="([^"]*)"><li><b>([^<]*)<\/b> You connected SerpApi\.<\/li>/);
  // lang-regex-ok: reads our own markup back
  const list = html.match(/<ul class="worked" style="[^"]*">(.*?)<\/ul>/);
  assert.ok(worked && list, html);
  assert.equal(worked[2], "10:46pm");
  // one list: the work line, then the call as the next bullet
  assert.equal(list[1], "<li><b>10:46pm</b> You connected SerpApi.</li><li class=\"call\"><b>11:34pm-12:03am</b> Call with Sam · ran 29 min</li>");
  assert.ok(html.indexOf('class="worked"') < html.indexOf('class="call"'), "the call follows the work under its stop");
});

test("a held call's paragraph is printed under its line, and only when there is one", () => {
  const { callLineHtml, callLineMd } = render._internal;
  const call = { who: "Sam", source: "zoom", status: "held", minutes: 68,
    start: "2026-10-20T20:09:19Z", end: "2026-10-20T21:17:58Z",
    talk: "You and Sam went over the fundraise & product." };
  const day = { date: "2026-10-20", tz: TZ, tzs: [TZ], stops: [] };
  const html = callLineHtml(day, call);
  assert.ok(html.includes('class="call"') && html.includes('<p class="call-talk"'), html);
  assert.ok(html.includes("fundraise &amp; product"), html);
  assert.ok(html.includes("11:09pm-12:17am"), html);
  assert.ok(callLineMd(day, call).endsWith("\n\n  You and Sam went over the fundraise & product."));
  // with points, they are the sub-bullets and the paragraph is not printed
  const pts = { ...call, talk_points: ["Fundraise: three investors still deciding", "Product: AI RevOps agent"] };
  const li = callLineHtml(day, pts);
  assert.ok(li.includes('<ul class="call-talk"') && li.includes("<li>Fundraise: three investors still deciding</li>"), li);
  assert.ok(!li.includes("fundraise &amp; product"), li);
  assert.ok(callLineMd(day, pts).endsWith("\n  - Fundraise: three investors still deciding\n  - Product: AI RevOps agent"));
  assert.ok(!callLineHtml(day, { ...call, talk: undefined }).includes("call-talk"));
  const m = render.buildManifest({ ...day, calls: [{ ...call, talk_source: "summary" }], unmatched_calendar_events: [] }, {});
  assert.equal(m.calls[0].talk, call.talk);
  assert.equal(m.calls[0].talk_source, "summary");
});
