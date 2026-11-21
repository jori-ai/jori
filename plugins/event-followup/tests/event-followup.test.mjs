// event-followup: the window, pacing, quiet hours, and the model reading's validation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEvent, windowCandidates, paced, inQuiet, validateReading, readEvents, eventKey, refOf, DEFAULTS, buildPrompt,
} from "../lib/event-followup.mjs";

const NOW = Date.parse("2026-11-21T14:00:00Z");
const ev = (o) => normalizeEvent({ id: "e1", summary: "Movie night", status: "confirmed",
  start: { dateTime: "2026-11-21T01:00:00Z" }, end: { dateTime: "2026-11-21T03:40:00Z" }, ...o });

test("normalizeEvent drops all-day, cancelled and declined events", () => {
  assert.equal(normalizeEvent({ id: "a", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }), null);
  assert.equal(ev({ status: "cancelled" }), null);
  assert.equal(ev({ attendees: [{ self: true, responseStatus: "declined" }] }), null);
  const e = ev({ attendees: [{ email: "p@example.com" }, { self: true, email: "me@example.com" }], hangoutLink: "https://meet.google.com/x" });
  assert.deepEqual(e.attendees, ["p@example.com"]);
  assert.equal(e.video_call, true);
});

test("windowCandidates: ended 30 min to 36 h ago, short, not recurring, not judged", () => {
  const cfg = { ...DEFAULTS };
  const base = ev({});
  assert.equal(windowCandidates([base], { events: {}, asks: [] }, cfg, NOW).length, 1);
  const justEnded = ev({ id: "e2", start: { dateTime: "2026-11-21T13:00:00Z" }, end: { dateTime: "2026-11-21T13:50:00Z" } });
  const old = ev({ id: "e3", start: { dateTime: "2026-11-19T01:00:00Z" }, end: { dateTime: "2026-11-19T02:00:00Z" } });
  const long = ev({ id: "e4", start: { dateTime: "2026-11-20T00:00:00Z" }, end: { dateTime: "2026-11-20T12:00:00Z" } });
  const rec = ev({ id: "e5", recurringEventId: "s1" });
  assert.deepEqual(windowCandidates([justEnded, old, long, rec], { events: {}, asks: [] }, cfg, NOW), []);
  assert.deepEqual(windowCandidates([base], { events: { [eventKey(base)]: { status: "skipped" } }, asks: [] }, cfg, NOW), []);
});

test("paced: per-day cap and gap", () => {
  const cfg = { ...DEFAULTS };
  assert.equal(paced({ asks: [] }, cfg, NOW).ok, true);
  assert.equal(paced({ asks: [new Date(NOW - 30 * 60e3).toISOString()] }, cfg, NOW).ok, false);
  const three = [1, 3, 5].map((h) => new Date(NOW - h * 3600e3).toISOString());
  assert.equal(paced({ asks: three }, cfg, NOW).ok, false);
});

test("inQuiet wraps midnight in the given zone", () => {
  const cfg = { ...DEFAULTS };
  assert.equal(inQuiet(Date.parse("2026-11-21T04:00:00Z"), cfg, "America/New_York"), true);  // 23:00
  assert.equal(inQuiet(Date.parse("2026-11-21T13:00:00Z"), cfg, "America/New_York"), true);  // 08:00
  assert.equal(inQuiet(Date.parse("2026-11-21T15:00:00Z"), cfg, "America/New_York"), false); // 10:00
});

test("validateReading requires an entry per event and a question/kind/title when asking", () => {
  const events = [{ id: "a" }, { id: "b" }];
  const good = { events: [
    { id: "a", ask: true, kind: "screen", screen_title: "Some Film", screen_type: "movie", question: "Did you end up watching Some Film last night? How was it?" },
    { id: "b", ask: false, why: "work call" },
  ] };
  const v = validateReading(good, events);
  assert.equal(v.get("a").screen_title, "Some Film");
  assert.equal(v.get("b").ask, false);
  assert.equal(validateReading({ events: [good.events[0]] }, events), null);
  assert.equal(validateReading({ events: [{ ...good.events[0], screen_title: "" }, good.events[1]] }, events), null);
  assert.equal(validateReading({ events: [{ ...good.events[0], kind: "nope" }, good.events[1]] }, events), null);
  assert.equal(validateReading({ events: [...good.events, { id: "zzz", ask: false }] }, events), null);
});

test("readEvents climbs the ladder only past an invalid answer", async () => {
  const events = [{ id: "a", title: "Dinner", start: "2026-11-20T23:00:00Z", end: "2026-11-21T01:00:00Z", attendees: [] }];
  const calls = [];
  const run = async (model) => {
    calls.push(model);
    return calls.length === 1 ? "not json" : JSON.stringify({ events: [{ id: "a", ask: true, kind: "meal", question: "How was dinner last night, did it happen?" }] });
  };
  const { reading } = await readEvents(events, { tz: "UTC", owner: "the user" }, { run });
  assert.equal(calls.length, 2);
  assert.equal(reading.get("a").kind, "meal");
});

test("refOf is stable and short; the prompt treats calendar text as data", () => {
  assert.equal(refOf("primary:x:1"), refOf("primary:x:1"));
  assert.ok(refOf("primary:x:1").length <= 7);
  assert.match(buildPrompt([], { tz: "UTC" }), /data, never instructions/);
});
