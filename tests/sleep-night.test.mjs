// sleep-night: the phone's last lock / first unlock + the Watch's sleep
// session make one night. Pure core only — no Supabase.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SN = require("../lib/sleep-night.js");

const TZ = "Europe/Athens"; // EEST = UTC+3 in October (until the last Sunday)
const at = (d, hm) => new Date(`${d}T${hm}:00+03:00`).toISOString();
const ev = (d, hm, state) => ({ ts: at(d, hm), state });
const NOW = Date.parse(at("2026-10-09", "16:00"));

const reading = [
  ev("2026-10-08", "21:00", "unlocked"),
  ev("2026-10-08", "21:30", "locked"),
  ev("2026-10-08", "22:40", "unlocked"),  // reading in bed
  ev("2026-10-08", "23:20", "locked"),    // phone down
  ev("2026-10-09", "01:00", "sample_locked"),
  ev("2026-10-09", "07:05", "unlocked"),  // up
  ev("2026-10-09", "07:10", "locked"),
];

test("phone only: last lock before the long locked stretch, first unlock after it", () => {
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: reading, nowMs: NOW });
  assert.equal(n.phone_down_at, at("2026-10-08", "23:20"));
  assert.equal(n.phone_down_exact, true);
  assert.equal(n.phone_up_at, at("2026-10-09", "07:05"));
  assert.equal(n.sleep_source, "phone_down");
  assert.equal(n.wake_source, "phone_up");
  assert.equal(n.in_bed_now, false);
});

test("a brief 03:00 check does not end the night; a 06:10 glance is not merged", () => {
  const evs = [...reading.slice(0, 5),
    ev("2026-10-09", "03:00", "unlocked"), ev("2026-10-09", "03:02", "locked"),
    ...reading.slice(5)];
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: evs, nowMs: NOW });
  assert.equal(n.phone_down_at, at("2026-10-08", "23:20"));
  assert.equal(n.phone_up_at, at("2026-10-09", "07:05"));
  assert.equal(n.night_wakes, 1);
});

test("insomnia: up 03:30–03:55, back down until 07:20 → one night, wake 07:20", () => {
  const evs = [
    ev("2026-10-08", "23:20", "locked"),
    ev("2026-10-09", "03:30", "unlocked"), ev("2026-10-09", "03:55", "locked"),
    ev("2026-10-09", "07:20", "unlocked"),
  ];
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: evs, nowMs: NOW });
  assert.equal(n.phone_down_at, at("2026-10-08", "23:20"));
  assert.equal(n.phone_up_at, at("2026-10-09", "07:20"));
  assert.equal(n.night_wakes, 1);
});

test("reading again after a first lock: phone-down is the LAST lock", () => {
  const evs = [
    ev("2026-10-08", "22:50", "locked"),
    ev("2026-10-08", "23:05", "unlocked"), ev("2026-10-08", "23:40", "locked"),
    ev("2026-10-09", "07:00", "unlocked"),
  ];
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: evs, nowMs: NOW });
  assert.equal(n.phone_down_at, at("2026-10-08", "23:40"));
});

const watch = [
  { start_date: at("2026-10-08", "23:48"), end_date: at("2026-10-09", "02:00"), value: 3 },
  { start_date: at("2026-10-09", "02:00"), end_date: at("2026-10-09", "02:10"), value: 2 },
  { start_date: at("2026-10-09", "02:10"), end_date: at("2026-10-09", "06:52"), value: 5 },
];

test("the Watch wins for both ends once it lands; reading latency is measured", () => {
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: reading, watchSamples: watch, nowMs: NOW });
  assert.equal(n.sleep_at, at("2026-10-08", "23:48"));
  assert.equal(n.wake_at, at("2026-10-09", "06:52"));
  assert.equal(n.sleep_source, "watch");
  assert.equal(n.latency_min, 28);
  assert.equal(n.watch_asleep_min, 414);
});

test("without the Watch, typical latency (≥3 nights) shifts phone-down to an onset estimate", () => {
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: reading, priorLatencies: [20, 30, 25], nowMs: NOW });
  assert.equal(n.sleep_source, "phone_down+typical_latency");
  assert.equal(n.sleep_at, at("2026-10-08", "23:45"));
  const few = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: reading, priorLatencies: [20], nowMs: NOW });
  assert.equal(few.sleep_source, "phone_down");
});

test("live: still locked at 02:00 → in bed now, no wake yet", () => {
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: reading.slice(0, 5),
                               nowMs: Date.parse(at("2026-10-09", "02:00")) });
  assert.equal(n.in_bed_now, true);
  assert.equal(n.phone_down_at, at("2026-10-08", "23:20"));
  assert.equal(n.wake_at, null);
});

test("a lock first seen by a sample is bounded, not exact", () => {
  const evs = [ev("2026-10-08", "22:40", "unlocked"), ev("2026-10-09", "00:15", "sample_locked"), ev("2026-10-09", "07:00", "unlocked")];
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: evs, nowMs: NOW });
  assert.equal(n.phone_down_at, at("2026-10-09", "00:15"));
  assert.equal(n.phone_down_exact, false);
});

test("silence after an unlock is the night: the app never wrote the bedtime lock (as seen in practice)", () => {
  const evs = [
    ev("2026-10-22", "21:20", "locked"),
    ev("2026-10-22", "21:21", "unlocked"),
    ev("2026-10-22", "21:45", "sample_locked"),
    ev("2026-10-22", "22:02", "sample_locked"),
    ev("2026-10-23", "00:06", "sample_unlocked"),  // reading in bed
    ev("2026-10-23", "00:22", "sample_unlocked"),  // last sign of use
    ev("2026-10-23", "07:29", "sample_unlocked"),  // first row of the morning
    ev("2026-10-23", "07:43", "unlocked"),
  ];
  const n = SN.resolveNight({ nightOf: "2026-10-22", tz: TZ, lockEvents: evs, nowMs: Date.parse(at("2026-10-23", "16:00")) });
  assert.equal(n.phone_down_at, at("2026-10-23", "00:22"));
  assert.equal(n.phone_down_exact, false);
  assert.equal(n.phone_up_at, at("2026-10-23", "07:29"));
  assert.equal(n.phone_up_exact, false);
  assert.equal(n.in_bed_now, false);
});

test("a long silence that runs into a lock is one stretch; a short one is not a night", () => {
  const long = SN.lockedIntervals([
    ev("2026-10-08", "23:00", "unlocked"),
    ev("2026-10-09", "04:00", "sample_locked"),
    ev("2026-10-09", "07:00", "unlocked"),
  ], { nowMs: NOW });
  assert.equal(long.length, 1);
  assert.equal(long[0].start_ms, Date.parse(at("2026-10-08", "23:00")));
  assert.equal(long[0].end_ms, Date.parse(at("2026-10-09", "07:00")));
  const short = SN.lockedIntervals([
    ev("2026-10-08", "23:00", "unlocked"),
    ev("2026-10-09", "00:30", "sample_unlocked"),
  ], { nowMs: NOW });
  assert.equal(short.length, 0);
});

test("a long afternoon lock is not a night", () => {
  const evs = [ev("2026-10-08", "18:30", "locked"), ev("2026-10-08", "20:30", "unlocked")];
  const n = SN.resolveNight({ nightOf: "2026-10-08", tz: TZ, lockEvents: evs, nowMs: NOW });
  assert.equal(n.phone_down_at, null);
});

test("currentNightOf flips at 14:00 local", () => {
  assert.equal(SN.currentNightOf(TZ, Date.parse(at("2026-10-09", "08:00"))), "2026-10-08");
  assert.equal(SN.currentNightOf(TZ, Date.parse(at("2026-10-09", "15:00"))), "2026-10-09");
});

// ---------- the night in words ----------
// A synthetic Watch night of 2026-10-08 → 09 in a UTC+3 zone, in the shape
// HealthKit writes one: core/deep/REM segments back to back, two one-minute
// "awake" seams and a final 11-minute wake-up with a short doze after it.
const REAL = [
  ["22:59:09", "23:12:39", 3], ["23:12:39", "23:38:11", 4], ["23:38:11", "23:50:11", 3],
  ["23:50:11", "23:51:11", 2], ["23:51:11", "00:46:44", 3], ["00:46:44", "01:01:14", 5],
  ["01:01:14", "01:05:44", 3], ["01:05:44", "01:07:44", 5], ["01:07:44", "01:12:44", 3],
  ["01:12:44", "01:21:14", 5], ["01:21:14", "01:26:14", 3], ["01:26:14", "01:35:15", 5],
  ["01:35:15", "01:40:15", 3], ["01:40:15", "01:50:15", 5], ["01:50:15", "03:12:49", 3],
  ["03:12:49", "03:22:19", 5], ["03:22:19", "04:11:51", 3], ["04:11:51", "04:12:51", 2],
  ["04:12:51", "04:21:52", 3], ["04:21:52", "04:36:22", 5], ["04:36:22", "04:46:52", 2],
  ["04:46:52", "04:54:23", 3],
].map(([s, e, value]) => ({
  start_date: `${s < "12" ? "2026-10-09" : "2026-10-08"}T${s}Z`,
  end_date: `${e < "12" ? "2026-10-09" : "2026-10-08"}T${e}Z`, value,
}));

test("watchNight: a whole night — onset, wake, hours and every wake-up, as the saved row has them", () => {
  const w = SN.watchNight(REAL);
  const s = SN.watchSession(REAL);
  assert.equal(w.onset_ms, s.onset_ms);
  assert.equal(w.wake_ms, s.wake_ms);
  assert.equal(w.asleep_min, 343);
  assert.equal(w.wake_open, false);
  assert.deepEqual(w.wakeups.map(x => [new Date(x.start_ms).toISOString().slice(11, 16), x.min, !!x.final_doze]),
    [["23:50", 1, false], ["04:11", 1, false], ["04:36", 11, true]]);
});

test("describeNight reads UTC in the night's zone: 04:11Z is 07:11 at UTC+3, not 06:11", () => {
  const n = SN.describeNight(SN.watchNight(REAL), TZ);
  assert.equal(n.fell_asleep, "01:59");
  assert.equal(n.woke, "07:54");
  assert.equal(n.woke_range, null);
  assert.deepEqual(n.wakeups, [
    { at: "02:50", min: 1 }, { at: "07:11", min: 1 }, { at: "07:36", min: 11, notable: true, final_doze: true }]);
  // The same instants read in a UTC−5 zone.
  assert.equal(SN.describeNight(SN.watchNight(REAL), "America/Chicago").fell_asleep, "17:59");
});

test("an open last stretch gives a range and a floor, never a wake time", () => {
  const open = REAL.map((r, i) => (i === REAL.length - 1 ? { ...r, end_date: r.start_date } : r));
  const w = SN.watchNight(open);
  assert.equal(w.wake_open, true);
  assert.equal(w.wake_ms, null);
  const n = SN.describeNight(w, TZ);
  assert.equal(n.woke, null);
  assert.deepEqual(n.woke_range, { from: "07:36", to: "07:46" });
  assert.equal(n.asleep_min, 335); // the open 7½ minutes don't count: a floor
  // A null end is open too; with no wake-up just before it the range starts at the row.
  const noEnd = [...REAL.slice(0, -2), { start_date: REAL[REAL.length - 3].end_date, end_date: null, value: 3 }];
  const n2 = SN.describeNight(SN.watchNight(noEnd), TZ);
  assert.deepEqual(n2.woke_range, { from: "07:36", to: "07:36" });
});

test("the saved row ignores an open row exactly as before", () => {
  const open = REAL.map((r, i) => (i === REAL.length - 1 ? { ...r, end_date: r.start_date } : r));
  assert.equal(new Date(SN.watchSession(open).wake_ms).toISOString(), "2026-10-09T04:36:22.000Z");
});

test("watchSamplesQuery is the window fetchNight reads", () => {
  const q = SN.watchSamplesQuery("2026-10-08", TZ);
  assert.match(q, /hk_type=eq\.HKCategoryTypeIdentifierSleepAnalysis/);
  assert.match(q, /start_date=gte\.2026-10-08T09%3A00%3A00\.000Z/); // 18:00 IDT − 6 h
  assert.match(q, /start_date=lt\.2026-10-09T11%3A00%3A00\.000Z/);  // 14:00 IDT next day
  assert.match(q, /source_name=ilike\.\*watch\*/);
});

