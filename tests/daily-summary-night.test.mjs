// daily-summary-night.test.mjs — the night line and the night paragraph the
// daily summary renders from lib/sleep-night.js (lib/daily-summary-render.js).
// The pure night model is tested in tests/sleep-night.test.mjs. The Watch
// stages below are a synthetic night (the shape of a real export: ~22 rows,
// a settled stretch, a short wake near the end and a final doze).
//
// Run: node --test tests/daily-summary-night.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SN = require("../lib/sleep-night.js");

const TZ = "Europe/Athens"; // EEST = UTC+3 in October
// The daily summary opens with the night that led into the day.
const R = require("../lib/daily-summary-render.js")._internal;

test("summary night line: previous night's sleep, then wake, then Watch duration", () => {
  const day = { tz: TZ, stops: [],
    sleep: { at: "23:48", source: "night_watch" },
    wake: { at: "06:52", source: "night_watch", asleep_min: 414 } };
  assert.equal(R.nightLine(day, [], (hm) => hm), "Fell asleep 23:48 (Watch) · Woke 06:52 (Watch) · 6h 54m asleep");
});

test("summary night line: phone-only night", () => {
  const day = { tz: TZ, stops: [],
    sleep: { at: "23:20", source: "night_phone_down" }, wake: { at: "07:05", source: "night_phone_up" } };
  assert.equal(R.nightLine(day, [], (hm) => hm), "Phone down 23:20 · Woke 07:05");
});

const NIGHT = [
  ["23:10:09", "23:23:39", 3], ["23:23:39", "23:49:11", 4], ["23:49:11", "00:01:11", 3],
  ["00:01:11", "00:02:11", 2], ["00:02:11", "00:57:44", 3], ["00:57:44", "01:12:14", 5],
  ["01:12:14", "01:16:44", 3], ["01:16:44", "01:18:44", 5], ["01:18:44", "01:23:44", 3],
  ["01:23:44", "01:32:14", 5], ["01:32:14", "01:37:14", 3], ["01:37:14", "01:46:15", 5],
  ["01:46:15", "01:51:15", 3], ["01:51:15", "02:01:15", 5], ["02:01:15", "03:23:49", 3],
  ["03:23:49", "03:33:19", 5], ["03:33:19", "04:22:51", 3], ["04:22:51", "04:23:51", 2],
  ["04:23:51", "04:32:52", 3], ["04:32:52", "04:47:22", 5], ["04:47:22", "04:57:52", 2],
  ["04:57:52", "05:05:23", 3],
].map(([s, e, value]) => ({
  start_date: `${s < "12" ? "2026-10-09" : "2026-10-08"}T${s}Z`,
  end_date: `${e < "12" ? "2026-10-09" : "2026-10-08"}T${e}Z`, value,
}));

test("summary night sentence: an open last stretch with no wake-up before it starts the range at the row", () => {
  const noEnd = [...NIGHT.slice(0, -2), { start_date: NIGHT[NIGHT.length - 3].end_date, end_date: null, value: 3 }];
  const n2 = SN.describeNight(SN.watchNight(noEnd), TZ);
  assert.match(R.nightSentence(n2), /were up some time after 7:47am/);
});

const sampleNight = () => SN.describeNight(SN.watchNight(NIGHT), TZ);

test("summary night sentence: a whole night, in words", () => {
  assert.equal(R.nightSentence(sampleNight()),
    "You fell asleep around 2:10am, surfaced at 7:47am for about 10 minutes, dozed a little longer and were up"
    + " for good at 8:05am: about 5¾ hours of actual sleep. Before that, a settled night, with just two brief stirrings.");
});

test("summary night sentence: open last stretch → a range, 'at least', no wake time", () => {
  const n = { fell_asleep: "02:10", woke: null, woke_range: { from: "07:47", to: "07:57" }, asleep_min: 336,
    wakeups: [{ at: "03:01", min: 1 }, { at: "07:22", min: 1 }, { at: "07:47", min: 10, notable: true, final_doze: true }] };
  const s = R.nightSentence(n);
  assert.match(s, /woke somewhere between 7:47am and a little after 7:57am/);
  assert.match(s, /no end time/);
  assert.match(s, /at least 5½ hours/);
  assert.doesNotMatch(s, /up for good/);
});

test("summary night sentence: wake-ups worth naming, and an unbroken night", () => {
  const base = { fell_asleep: "23:40", woke: "07:05", woke_range: null, asleep_min: 420 };
  assert.equal(R.nightSentence({ ...base, wakeups: [] }),
    "You fell asleep around 11:40pm and woke at 7:05am: about 7 hours of actual sleep. It was an unbroken night.");
  assert.match(R.nightSentence({ ...base, wakeups: [{ at: "03:10", min: 22, notable: true }, { at: "04:00", min: 2 }] }),
    /You were awake for about 20 minutes around 3:10am, plus one brief stirring\.$/);
  assert.match(R.nightSentence({ ...base, wakeups: [{ at: "02:00", min: 12, notable: true }, { at: "04:30", min: 6, notable: true }] }),
    /You were up two times in the night \(2:00am for about 10 minutes, 4:30am for 6 minutes\)\.$/);
  // A zone-crossing day labels every time.
  assert.match(R.nightSentence({ ...base, wakeups: [], tz_abbr: "EEST" }), /11:40pm EEST and woke at 7:05am EEST/);
});

test("narrator's night paragraph: only the night's own times get through", () => {
  const n = sampleNight();
  assert.ok(R.nightTimesOk("You drifted off around 2:10am and were up for good at 8:05am, after a short wake at 7:47am.", n));
  assert.ok(R.nightTimesOk("Asleep around 2am, up at 8:05am.", n));                  // bare hour within 30 min
  assert.ok(!R.nightTimesOk("You fell asleep at 2:10am and stirred at 6:22am.", n)); // the UTC+2 slip
  assert.ok(!R.nightTimesOk("Up around 6am after falling asleep at 2:10am.", n));
  assert.ok(!R.nightTimesOk("A decent night overall.", n));                         // states no time at all
  assert.equal(R.nightText("", n, "CODE"), "CODE");
  assert.equal(R.nightText("Out by 2:10am, up at 8:05am.", n, "CODE"), "Out by 2:10am, up at 8:05am.");
  assert.equal(R.nightText("Out by 2:10am, up at 7:05am.", n, "CODE"), "CODE");
  assert.ok(!R.nightTimesOk("Asleep by 2:10am, up at 20:05.", n));                 // a 24-hour time is never 8:05am
  // A night with only a wake range always ships code's sentence.
  const open = { ...n, woke: null, woke_range: { from: "07:47", to: "07:57" } };
  assert.equal(R.nightText("You fell asleep at 2:10am and woke at 7:57am.", open, "CODE"), "CODE");
});

test("skeleton → assemble: the night paragraph replaces the stat line, prose only when its times check out", () => {
  const { buildSkeleton, assemble, buildMarkdown, buildManifest } = require("../lib/daily-summary-render.js");
  const day = { date: "2026-10-09", tz: TZ, stops: [], travel_legs: [], night: sampleNight(),
    sleep: { at: "02:10", source: "night_watch" }, wake: { at: "08:05", source: "night_watch", asleep_min: 343 } };
  const skel = buildSkeleton(day, {});
  assert.match(skel, /\{\{NIGHT:/);
  assert.doesNotMatch(skel, /\(Watch\)/);
  assert.match(assemble(skel, {}), /You fell asleep around 2:10am, surfaced at 7:47am/);
  assert.match(assemble(skel, { night: "You were out by 2:10am and up for good at 8:05am." }), /You were out by 2:10am and up for good at 8:05am\./);
  assert.match(assemble(skel, { night: "You were out by 2:10am and up at 7:05am." }), /You fell asleep around 2:10am, surfaced/);
  assert.match(buildMarkdown(day, {}), /You fell asleep around 2:10am/);
  const m = buildManifest(day);
  assert.equal(m.night.fell_asleep, "2:10am");
  assert.equal(m.night.wakeups[1].at, "7:22am");
  assert.equal(m.night.asleep, "about 5¾ hours");
  // No Watch night: the one-line night stays.
  const { night, ...noWatch } = day;
  assert.match(buildSkeleton(noWatch, {}), /Fell asleep 2:10am \(Watch\) · Woke 8:05am \(Watch\) · 5h 43m asleep/);
});
