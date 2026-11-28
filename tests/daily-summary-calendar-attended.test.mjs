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
const DAN = ev("Dan / Sam catch-up", "11:00", "12:00");
const PLUMBER = ev("Plumber", "14:00", "15:00", { location: "12 Palm Way, Springfield" });
const DINNER = ev("Dinner at Bistro Example", "19:00", "21:00", { location: "Bistro Example, Brickell" });

function day(extra = {}) {
  const home = stop("s-1", "07:00", "18:30", "Home", { address: "12 Palm Way, Springfield",
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
  assert.deepEqual((a.byStop["s-1"] || []).map(e => e.summary), ["Team standup", "Dan / Sam catch-up", "Plumber"]);
  // the dinner IS the bistro stop: its header, not a block of its own
  assert.equal(a.byStop["s-2"], undefined);
  const html = render.assemble(render.buildSkeleton(d, {}), { prose: { "s-1": "A day at home." } });
  const heads = [...html.matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)].map(m => m[1].replace(/<[^>]*>/g, "").trim());
  assert.deepEqual(heads, [
    "7:00am · Home",
    "9:30am · Team standup · 30 min · at Home",
    "10:00am · Home",
    "11:00am · Dan / Sam catch-up · 1h · at Home",
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
    for (const t of ["9:30am-10:00am</b> Team standup · 30 min", "11:00am-12:00pm</b> Dan / Sam catch-up · 1h", "2:00pm-3:00pm</b> Plumber · 1h"]) {
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

test("a meeting that began before the user reached the stop is headed with the arrival and the time from then", () => {
  // the stop opens at 19:13, the event began at 19:00 and ends at 21:00 (an hour and 47 minutes of it was at the stop)
  const game = ev("Family game night", "19:00", "21:00");
  const home = stop("s-1", "19:13", "22:12", "Home", { address: "12 Example Street",
    calendar_event: { ...game, location_match: false, duration_min: 120, event_share: 0.89, attached_late: true } });
  const d = { date: "2026-11-25", tz: TZ, tzs: [TZ], stops: [home], travel_legs: [], unmatched_calendar_events: [], calendar_busy: [game] };
  const html = render.assemble(render.buildSkeleton(d, {}), { prose: { "s-1": "An evening in." } });
  const heads = [...html.matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)].map(m => m[1].replace(/<[^>]*>/g, "").trim());
  assert.deepEqual(heads, ["7:13pm · Family game night · 1h 47m · at Home", "9:00pm · Home"],
    "the event's own 7:00pm start and 2h length are not the part the user was at");
  const md = render.buildMarkdown(d, { prose: { "s-1": "An evening in." } });
  assert.ok(md.includes("### 19:13-21:00 · **Family game night** · 1h 47m"), md);
  // an event inside the stop keeps its own times
  const inside = ev("Family game night", "19:30", "20:30");
  const d2 = { ...d, calendar_busy: [inside] };
  const heads2 = [...render.assemble(render.buildSkeleton(d2, {}), {}).matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)].map(m => m[1].replace(/<[^>]*>/g, "").trim());
  assert.ok(heads2.includes("7:30pm · Family game night · 1h · at Home"), heads2.join(" | "));
});

test("a time the user stated for an event replaces the calendar's on every copy, and the block follows it", () => {
  const { applyCorrectionEventTimes } = require(path.join(ROOT, "lib/daily-summary-harvest.js"));
  const cook = ev("Cooking", "14:00", "16:30");
  const home = stop("s-1", "07:45", "19:01", "Home", { address: "12 Example Street", calendar_event: { ...cook, location_match: false, duration_min: 150, event_share: 1 } });
  const d = { date: "2026-11-25", tz: TZ, tzs: [TZ], stops: [home], travel_legs: [], unmatched_calendar_events: [], calendar_busy: [cook] };
  const heads = (x) => [...render.assemble(render.buildSkeleton(x, {}), {}).matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)].map(m => m[1].replace(/<[^>]*>/g, "").trim());
  assert.ok(heads(d).includes("2:00pm · Cooking · 2h 30m · at Home"), heads(d).join(" | "));
  const applied = applyCorrectionEventTimes(d, [{ said_at: iso("19:25"), text: "I was cooking from 1pm to 4:30pm", events: { Cooking: { from: iso("13:00"), to: iso("16:30") } } }]);
  assert.equal(applied.length, 2, "the busy list's copy and the stop's copy");
  assert.deepEqual(heads(d), ["7:45am · Home", "1:00pm · Cooking · 3h 30m · at Home", "4:30pm · Home"]);
  assert.equal(home.calendar_event.duration_min, 210);
  assert.equal((attendedEvents(d).byStop["s-1"] || []).length, 1, "still one event, not the corrected one beside the original");
});

test("the wiki page splits the same way, and the manifest carries them on the stop", () => {
  const d = day();
  const md = render.buildMarkdown(d, {});
  assert.ok(md.includes("### 09:30-10:00 · **Team standup** · 30 min · at Home"), md);
  assert.ok(md.includes("### 14:00-15:00 · **Plumber** · 1h · at Home"), md);
  assert.ok(md.includes("### 15:00-18:30 · **Home**"), md);
  const m = render.buildManifest(d, {});
  assert.equal(m.stops.length, 2);
  assert.deepEqual(m.stops[0].calendar_attended.map(e => e.summary), ["Team standup", "Dan / Sam catch-up", "Plumber"]);
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
  assert.equal(heldCalendarEvent(d, d.stops[0]).summary, "Dan / Sam catch-up");
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

// A meeting whose record has no end of its own is laid out to the calendar's end time. That
// plan end is not a boundary the user crossed: a short stretch after it is the meeting running
// over, so it does not open a separate block at the planned end (2026-11-27: a game planned
// 7:30 to 10pm, the stay ending 10:12pm, drew a second "10:00pm" block).
test("a meeting record with no end of its own keeps a short stretch after the plan's end", () => {
  const record = (over = {}) => ({ summary: "Family game", calendar: { start: iso("19:30"), end: iso("22:00"), location: null },
    happened: { value: "yes" }, where: { mode: "in_person", place: "Home", stop_id: "s-1" }, start: null, end: null,
    participants: { names: ["Pat"] }, what: { text: "You played." }, ...over });
  const build = (until, rec) => {
    const home = stop("s-1", "19:13", until, "Home", { address: "12 Palm Way, Springfield" });
    return { date: "2026-11-25", tz: TZ, tzs: [TZ], stops: [home], travel_legs: [], unmatched_calendar_events: [],
      calendar_busy: [], meeting_records: { status: "ok", records: [rec] } };
  };
  const windows = (d) => splitOnMeetings(d, d.stops).stops.map(s => `${s.start}-${s.end}${s._meeting ? " meeting" : ""}`);
  // 12 minutes after the plan's end: the meeting holds them, no 22:00 block
  assert.deepEqual(windows(build("22:12", record())), ["19:13-19:30", "19:30-22:12 meeting"]);
  // an hour after it: the user was plainly somewhere else in the stop, so it is its own block
  assert.deepEqual(windows(build("23:00", record())), ["19:13-19:30", "19:30-22:00 meeting", "22:00-23:00"]);
  // a record that has an end of its own keeps the plain rule: 12 minutes is a block
  assert.deepEqual(windows(build("22:12", record({ start: iso("19:30"), end: iso("22:00") }))), ["19:13-19:30", "19:30-22:00 meeting", "22:00-22:12"]);
  // JORI_CAL_OPEN_END_TAIL_MIN=0 restores the plain rule for a plan-only end
  process.env.JORI_CAL_OPEN_END_TAIL_MIN = "0";
  try {
    // module constant is read at load: the flag is checked with a fresh load
    const fresh = (() => { const p = require.resolve(path.join(ROOT, "lib/daily-summary-render.js")); delete require.cache[p]; return require(p); })();
    const d = build("22:12", record());
    assert.deepEqual(fresh._internal.splitOnMeetings(d, d.stops).stops.map(s => `${s.start}-${s.end}${s._meeting ? " meeting" : ""}`), ["19:13-19:30", "19:30-22:00 meeting", "22:00-22:12"]);
  } finally { delete process.env.JORI_CAL_OPEN_END_TAIL_MIN; delete require.cache[require.resolve(path.join(ROOT, "lib/daily-summary-render.js"))]; }
});

// A block that opens at a plan-only meeting end starts when the calendar said the meeting would
// end, which is not a moment the user crossed anything. Its header says "about"; a record with an
// end of its own is a real boundary and keeps the plain time (2026-11-27: a game planned 7:30 to
// 10pm, the stay running to midnight, drew a "10:00pm" home block as if the game ended on the dot).
test("a block that opens at a plan-only meeting end says about; one after a recorded end does not", () => {
  const record = (over = {}) => ({ summary: "Family game", calendar: { start: iso("19:30"), end: iso("22:00"), location: null },
    happened: { value: "yes" }, where: { mode: "in_person", place: "Home", stop_id: "s-1" }, start: null, end: null,
    participants: { names: ["Pat"] }, what: { text: "You played." }, ...over });
  const build = (rec) => {
    const home = stop("s-1", "19:13", "23:50", "Home", { address: "12 Palm Way, Springfield" });
    return { date: "2026-11-25", tz: TZ, tzs: [TZ], stops: [home], travel_legs: [], unmatched_calendar_events: [],
      calendar_busy: [], meeting_records: { status: "ok", records: [rec] } };
  };
  const heads = (d) => [...render.assemble(render.buildSkeleton(d, {}), { prose: {} }).matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)]
    .map(m => m[1].replace(/<[^>]*>/g, "").trim());
  const plan = heads(build(record()));
  assert.equal(plan.length, 3, plan.join(" | "));
  assert.ok(plan[2].startsWith("about 10:00pm · Home"), plan.join(" | "));
  assert.ok(!plan[0].startsWith("about"), plan.join(" | "));
  const real = heads(build(record({ start: iso("19:30"), end: iso("22:00") })));
  assert.ok(real[real.length - 1].startsWith("10:00pm · Home"), real.join(" | "));
  // the markdown the wiki reads says it too
  const md = render.buildMarkdown(build(record()), { prose: {} });
  assert.match(md, /### about 22:00-23:50/);
});

// "3 stops" over six headers read as a miscount: the timeline draws each meeting the user was at
// as its own block inside a stop, so the count names them.
test("the header count names the meetings drawn as blocks of their own", () => {
  const caption = (d) => (render.buildSkeleton({ ...d, map_url: "https://example.test/map.png" }, {})
    .match(/<p style="color:#999;font-size:12px;margin:0 0 16px;">([^<]*)<\/p>/) || [])[1] || "";
  assert.match(caption(day()), /2 stops · 3 meetings/);
  // a day with no meeting to draw says nothing about meetings
  const quiet = caption(day({ calendar_busy: [], unmatched_calendar_events: [] }));
  assert.match(quiet, /2 stops/);
  assert.ok(!/meeting/.test(quiet), quiet);
});

// A record with no start of its own is laid out at the calendar's hour, and that hour used to pick
// the stop that held it. An in-person errand planned for midday at a shop was drawn at the shop
// while the phone had the user at home through that hour; the record itself said the stop was not
// at the planned time. A place that is not the stop's, with no start and no stop of its own, is
// listed with the plan's time called the plan's, not drawn.
test("an in-person record with no start, at a place the stop is not, is listed and not drawn at the plan's hour", () => {
  const record = (over = {}) => ({ summary: "Pick up the parcel", calendar: { start: iso("12:15"), end: iso("12:30"), location: "Corner Pharmacy, 5 Main St, Springfield" },
    happened: { value: "yes" }, where: { mode: "in_person", place: "Corner Pharmacy", stop_id: null, elsewhere: false }, start: null, end: null,
    participants: { names: [] }, what: { text: "You picked up the parcel." }, reason: "GPS has you at home then.", ...over });
  const build = (rec) => {
    const home = stop("s-1", "09:00", "15:00", "Home", { address: "12 Palm Way, Springfield" });
    return { date: "2026-11-25", tz: TZ, tzs: [TZ], stops: [home], travel_legs: [], unmatched_calendar_events: [],
      calendar_busy: [], meeting_records: { status: "ok", records: [rec] } };
  };
  const heads = (d) => [...render.assemble(render.buildSkeleton(d, {}), { prose: {} }).matchAll(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/g)]
    .map(m => m[1].replace(/<[^>]*>/g, "").trim());
  const d = build(record());
  assert.equal(attendedEvents(d).byStop["s-1"], undefined);
  assert.deepEqual(heads(d), ["9:00am · Home"]);
  const listed = eventsNotMatched(d);
  assert.equal(listed.length, 1);
  assert.match(listed[0]._note, /took place at Corner Pharmacy; the day does not show when/);
  // no clock beside it: the calendar's hour is the plan's, not a moment it happened (HTML and the wiki markdown)
  assert.equal(listed[0]._untimed, true);
  const page = render.assemble(render.buildSkeleton(d, {}), { prose: {} });
  assert.match(page, /<li>Pick up the parcel · /);
  assert.ok(!/12:15pm/.test(page), "the plan's hour is not printed for a visit the day cannot time");
  const wiki = render.buildMarkdown(d, { prose: {} });
  assert.match(wiki, /- Pick up the parcel · /);
  assert.ok(!/12:15/.test(wiki));
  // a stop the record names is where it was held, whatever the plan's place says
  assert.equal(attendedEvents(build(record({ where: { mode: "in_person", place: "Corner Pharmacy", stop_id: "s-1", elsewhere: false } }))).byStop["s-1"].length, 1);
  // a start of its own is the evidence the plan's hour lacks: drawn, as before
  const timed = build(record({ start: iso("12:20"), end: iso("12:25") }));
  assert.equal(attendedEvents(timed).byStop["s-1"].length, 1);
  assert.deepEqual(eventsNotMatched(timed), []);
  // a place that is the stop's own keeps its block
  const here = build(record({ calendar: { start: iso("12:15"), end: iso("12:30"), location: "12 Palm Way, Springfield" }, where: { mode: "in_person", place: "Home", stop_id: null, elsewhere: false } }));
  assert.equal(attendedEvents(here).byStop["s-1"].length, 1);
  // JORI_RECORD_PLAN_CLOCK_PLACE=0 places it by the plan's clock again
  process.env.JORI_RECORD_PLAN_CLOCK_PLACE = "0";
  try { assert.equal(attendedEvents(d).byStop["s-1"].length, 1); } finally { delete process.env.JORI_RECORD_PLAN_CLOCK_PLACE; }
});

// 2026-11-28: the stay after a meeting has a prose slot of its own. A stop a meeting
// split into blocks (Home, Meeting, Home) kept its prose on the first block only, so the
// stay after the meeting printed as a bare header (the reviewer read it as the same stay
// twice) and what happened after the meeting had no block to be written under.
const { continuationBlocks } = render._internal;
const PLANNING = ev("Planning call", "10:00", "11:00");
const VENDOR = ev("Vendor visit", "14:00", "15:00");
const contDay = (busy) => ({ date: "2026-11-25", tz: TZ, tzs: [TZ], travel_legs: [], unmatched_calendar_events: [],
  stops: [stop("s-1", "07:45", "19:01", "Home", { address: "12 Palm Way, Springfield" })], calendar_busy: busy });

test("the stay after a meeting is a continuation block with its own id; the first block keeps the stop's id", () => {
  const d = contDay([PLANNING]);
  assert.deepEqual(continuationBlocks(d).map(b => [b.id, b._piece_of, b.start, b.end]), [["s-1~2", "s-1", "11:00", "19:01"]]);
  assert.equal(render.skeletonBlocks(d)[0].id, "s-1");
  assert.deepEqual(continuationBlocks(contDay([PLANNING, VENDOR])).map(b => [b.id, b.start]), [["s-1~2", "11:00"], ["s-1~4", "15:00"]]);
  assert.deepEqual(continuationBlocks(contDay([])), [], "a stop no meeting splits has none");
});

test("the manifest lists each continuation as a prose slot with the window it covers", () => {
  const m = render.buildManifest(contDay([PLANNING]), {});
  assert.deepEqual(m.prose_slots, ["s-1", "s-1~2"]);
  assert.deepEqual(m.prose_blocks, [{ id: "s-1~2", continues: "s-1", start: "11:00", end: "19:01" }]);
  assert.deepEqual(render.buildManifest(contDay([]), {}).prose_blocks, []);
});

test("the email and the wiki page print a continuation's prose under its own header, and no aside slot for it", () => {
  const d = contDay([PLANNING]);
  const skeleton = render.buildSkeleton(d, {});
  assert.ok(skeleton.includes("{{PROSE:s-1}}") && skeleton.includes("{{PROSE:s-1~2}}"), skeleton);
  assert.ok(skeleton.includes("{{ASIDE:s-1}}") && !skeleton.includes("{{ASIDE:s-1~2}}"), "only the stop's own block has an aside");
  const prose = { prose: { "s-1": "MORNING", "s-1~2": "AFTERNOON" } };
  for (const out of [render.assemble(skeleton, prose), render.buildMarkdown(d, prose)]) {
    const at = (m) => out.indexOf(m);
    assert.ok(at("MORNING") > 0 && at("MORNING") < at("Planning call") && at("Planning call") < at("AFTERNOON"), out);
  }
  // a continuation with no prose is an empty paragraph, as the first block is; a meeting block never takes prose
  assert.ok(!render.assemble(skeleton, { prose: { "s-1": "MORNING" } }).includes("{{PROSE"));
  assert.ok(!render.assemble(skeleton, { prose: { "s-1~1": "NOT PRINTED" } }).includes("NOT PRINTED"));
});
