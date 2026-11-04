// calendar-conflict-check.test.mjs — the event lanes' calendar clash gate and
// the zone it reads an event's date/time in.
//
// A lane abroad once passed local show times with no zone and the tool read
// them in the home zone, so a 21:00 show was checked at the small hours local
// time: it "clashed" with an airport pickup and missed the show the user held
// tickets for. DAY below is a synthetic day of the same shape, abroad in Tokyo
// with the home zone in Chicago. A weekly call that overlaps late shows is a
// soft block (venue-watch config `soft_block`), the rule the lottery lanes
// applies too. A fake `gog` on PATH serves the fixtures, and the test points
// JORI_LOCAL_DIR at its own instance + venue config, so it reads the same with
// or without an installation's agent/local.
//
// Run: node --test tests/calendar-conflict-check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-"));
const LOCAL = path.join(tmp, "local");
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ tz: "America/Chicago" }));
fs.writeFileSync(path.join(LOCAL, "config", "venue-events.json"),
  JSON.stringify({ home_metro: "home_city", metro_tz: { far_city: "Asia/Tokyo" } }));
process.env.JORI_LOCAL_DIR = LOCAL;
delete process.env.JORI_TZ;

const { calendarClash, calendarGate, metroZone } = await import("../lib/venue-events/watch.mjs");

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/calendar-conflict-check");
const ev = (summary, start, end, over = {}) => ({ summary, start: { dateTime: start }, end: { dateTime: end }, ...over });
const DAY = [
  ev("Lunch with a friend", "2026-10-15T13:00:00+09:00", "2026-10-15T15:00:00+09:00"),
  ev("Relative lands (flight)", "2026-10-15T18:00:00+09:00", "2026-10-16T04:25:00+09:00", { transparency: "transparent" }),
  ev("Comedy show", "2026-10-15T21:00:00+09:00", "2026-10-15T23:30:00+09:00"),
  ev("Weekly sync <> Sam", "2026-10-15T23:00:00+09:00", "2026-10-15T23:30:00+09:00"),
  ev("Airport pickup", "2026-10-16T11:00:00+09:00", "2026-10-16T13:00:00+09:00"),
];

fs.mkdirSync(path.join(tmp, "bin"));
fs.writeFileSync(path.join(tmp, "bin/gog"),
  '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_GOG_ARGS"\n[ -n "$FAKE_GOG_FAIL" ] && exit 1\ncat "$FAKE_GOG_EVENTS"\n', { mode: 0o755 });
const argsFile = path.join(tmp, "gog-args.txt");
let n = 0;
function env(events, extra = {}) {
  const f = path.join(tmp, `events-${n++}.json`);
  fs.writeFileSync(f, JSON.stringify({ events }));
  return { ...process.env, PATH: `${tmp}/bin:${process.env.PATH}`, FAKE_GOG_EVENTS: f, FAKE_GOG_ARGS: argsFile, ...extra };
}
function run(args, events = DAY, extra = {}) {
  const r = spawnSync(BIN, [...args, "--json"], { encoding: "utf8", env: env(events, extra), timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* usage errors print no JSON */ }
  return { status: r.status, json, names: (json?.events || []).map((e) => e.summary).sort() };
}
// The watch.mjs helpers spawn the real binary with this process's env.
function withCalendar(events, fn) {
  const keys = ["PATH", "FAKE_GOG_EVENTS", "FAKE_GOG_ARGS"], saved = keys.map((k) => process.env[k]);
  Object.assign(process.env, env(events));
  try { return fn(); } finally { keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
}

test("a 21:00 show in Tokyo is checked at 21:00 Tokyo time: the comedy show clashes, the airport pickup does not", () => {
  fs.rmSync(argsFile, { force: true });
  const r = run(["2026-10-15", "--time", "21:00", "--tz", "Asia/Tokyo"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.tz, "Asia/Tokyo");
  assert.deepEqual(r.json.window, { from: "2026-10-15T12:00:00.000Z", to: "2026-10-15T14:30:00.000Z" });
  assert.deepEqual(r.names, ["Comedy show", "Weekly sync <> Sam"]);
  assert.match(fs.readFileSync(argsFile, "utf8"), /--from 2026-10-15T09:00:00\.000Z --to 2026-10-15T17:30:00\.000Z/); // padded 3h
});

test("no --tz reads the installation's home zone (instance tz)", () => {
  const r = run(["2026-10-15", "--time", "21:00"]);
  assert.equal(r.json.tz, "America/Chicago");
  assert.deepEqual(r.json.window, { from: "2026-10-16T02:00:00.000Z", to: "2026-10-16T04:30:00.000Z" });
  assert.deepEqual(r.names, ["Airport pickup"]); // read in the home zone: the old false clash
  assert.deepEqual(run(["2026-10-15"]).json.window, { from: "2026-10-15T23:00:00.000Z", to: "2026-10-16T04:00:00.000Z" });
  assert.deepEqual(run(["2026-10-15", "--time", "19:00", "--duration-hours", "3.5"], []).json.window,
    { from: "2026-10-16T00:00:00.000Z", to: "2026-10-16T03:30:00.000Z" });
});

test("no showtime → 18:00-23:00 in the event's zone; a late show keeps its own local date", () => {
  const r = run(["2026-10-15", "--tz", "Asia/Tokyo"]);
  assert.deepEqual(r.json.window, { from: "2026-10-15T09:00:00.000Z", to: "2026-10-15T14:00:00.000Z" });
  assert.deepEqual(r.names, ["Comedy show"]);
  const late = run(["2026-10-16", "--time", "01:00", "--tz", "Asia/Tokyo"]);
  assert.deepEqual(late.json.window, { from: "2026-10-15T16:00:00.000Z", to: "2026-10-15T18:30:00.000Z" });
  assert.equal(late.status, 0);
});

test("an all-day event is that day in the event's zone", () => {
  const allDay = (d, e) => ({ summary: `all day ${d}`, start: { date: d }, end: { date: e } });
  const args = ["2026-10-16", "--time", "01:00", "--tz", "Asia/Tokyo"]; // the 16th in Tokyo, not the 15th
  assert.equal(run(args, [allDay("2026-10-16", "2026-10-17")]).status, 1);
  assert.equal(run(args, [allDay("2026-10-15", "2026-10-16")]).status, 0);
});

test("offsets follow each zone's daylight saving: early March and November move by an hour (a correction)", () => {
  // Berlin leaves summer time on Oct 25, 2026; Chicago on Nov 1 and re-enters it on Mar 8.
  assert.equal(run(["2026-10-27", "--time", "21:00", "--tz", "Europe/Berlin"], []).json.window.from, "2026-10-27T20:00:00.000Z");
  assert.equal(run(["2026-11-05", "--time", "21:00"], []).json.window.from, "2026-11-06T03:00:00.000Z");
  assert.equal(run(["2026-03-05", "--time", "21:00"], []).json.window.from, "2026-03-06T03:00:00.000Z");
  assert.equal(run(["2026-03-09", "--time", "21:00"], []).json.window.from, "2026-03-10T02:00:00.000Z");
  assert.equal(run(["2026-10-15", "--time", "24:00"], []).json.window.from, "2026-10-16T05:00:00.000Z"); // still legal
});

test("a bad zone or time is a usage error (exit 2); a failed calendar read fails open", () => {
  assert.equal(run(["2026-10-15", "--tz", "Mars/Olympus"]).status, 2);
  assert.equal(run(["2026-10-15", "--time", "25:00"]).status, 2);
  const failed = run(["2026-10-15", "--time", "21:00", "--tz", "Asia/Tokyo"], DAY, { FAKE_GOG_FAIL: "1" });
  assert.equal(failed.status, 0);
  assert.deepEqual([failed.json.conflict, failed.json.tz], [false, "Asia/Tokyo"]);
});

test("venue lanes read each pick in its gate metro's zone: a far metro in its own time, home unchanged", () => {
  assert.equal(metroZone("far_city"), "Asia/Tokyo");
  assert.equal(metroZone("home_city"), "America/Chicago");
  assert.equal(metroZone("somewhere_unmapped"), null); // keeps the home default
  withCalendar(DAY.filter((e) => e.summary === "Comedy show"), () => {
    assert.equal(calendarGate({ date: "2026-10-15", time: "21:00" }, "far_city", null, { softBlock: null }).drop, true);
    assert.equal(calendarGate({ date: "2026-10-15", time: "21:00" }, "home_city", null, { softBlock: null }).drop, false); // the old home-zone reading missed it
  });
});

test("an overlap with only the soft-block call keeps the pick, tagged; the call plus anything else drops it", () => {
  const SB = { name: "sam", note: "may run into the weekly call" };
  const opts = { softBlock: SB, knownId: null };
  const call = (start, end, over) => ev("Weekly sync <> Sam", start, end, { id: "t34series_R1", recurringEventId: "t34series", ...over });
  const pick = (date, time, tag = null, o = opts) => calendarGate({ date, time }, "far_city", tag, o);
  // Oct 20 21:00 in Tokyo vs the 23:00 call.
  withCalendar([call("2026-10-20T23:00:00+09:00", "2026-10-20T23:30:00+09:00")], () => {
    assert.deepEqual(pick("2026-10-20", "21:00"), { drop: false, tag: SB.note });
    assert.deepEqual(pick("2026-10-20", "21:00", "worth the trip"), { drop: false, tag: "worth the trip" }); // tested by value downstream
    assert.deepEqual(calendarClash("2026-10-20", null, "Asia/Tokyo", opts), { conflict: false, softOnly: false }); // evening window ends at 23:00
  });
  // The call keeps its home-zone slot, so after the home zone leaves summer time it lands an hour later abroad.
  withCalendar([call("2026-11-02T21:00:00+09:00", "2026-11-02T21:30:00+09:00")], () => {
    assert.deepEqual(pick("2026-11-02", "20:00"), { drop: false, tag: SB.note });
  });
  // The stored series id identifies a renamed instance.
  withCalendar([call("2026-10-20T23:00:00+09:00", "2026-10-20T23:30:00+09:00", { summary: "Weekly sync" })], () => {
    assert.equal(pick("2026-10-20", "21:00", null, { softBlock: SB, knownId: "t34series" }).drop, false);
    assert.equal(pick("2026-10-20", "21:00").drop, true);
  });
  // The call stacked with another commitment: the other one gates.
  withCalendar(DAY, () => {
    assert.deepEqual(calendarClash("2026-10-15", "21:00", "Asia/Tokyo", opts), { conflict: true, softOnly: false });
    assert.equal(pick("2026-10-15", "21:00").drop, true);
  });
  withCalendar([], () => assert.deepEqual(pick("2026-10-20", "21:00"), { drop: false, tag: null }));
});
