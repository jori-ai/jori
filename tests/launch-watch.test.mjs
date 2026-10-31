// launch-watch.test.mjs — pins the reconcile / calendar-window / cadence logic
// of bin/launch-watch-run (lib/launch-watch.mjs). Synthetic fixtures only.
// Run: node --test tests/launch-watch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl, normalize, reconcile, calendarWorthy, holdWindow, pingLines, launchKey, localRfc3339, shouldRun } from "../lib/launch-watch.mjs";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const TZ = "Australia/Sydney";
const api = (o) => ({
  name: "Rocket | Flight 15", net: "2026-10-20T23:30:00Z", net_precision: { name: "Minute" },
  window_start: "2026-10-20T23:30:00Z", window_end: "2026-10-21T01:00:00Z",
  status: { abbrev: "Go" }, pad: { name: "Pad-1", location: { name: "Test Launch Site, USA" } },
  url: "https://ll.thespacedevs.com/2.3.0/launches/abc/", ...o,
});

test("apiUrl: encodes the configured search", () => {
  assert.equal(apiUrl("Big Rocket", 10), "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?search=Big%20Rocket&limit=10");
});

test("normalize: collapses the name, maps precision, drops stale entries", () => {
  const [l, ...rest] = normalize([api(), api({ net: "2026-09-01T00:00:00Z" }), api({ name: "Rocket | Flight 16", net_precision: { name: "Quarter" } })], NOW, { vehicle: "Rocket" });
  assert.equal(l.mission, "Rocket Flight 15");
  assert.equal(l.vehicle, "Rocket");
  assert.equal(l.net_precision, "minute");
  assert.equal(l.site, "Test Launch Site, USA");
  assert.equal(rest.length, 1);
  assert.equal(rest[0].net_precision, "month");
  assert.equal(calendarWorthy(rest[0], NOW), false, "month precision is track-only");
  assert.equal(calendarWorthy(normalize([api({ net: "2027-09-01T00:00:00Z" })], NOW)[0], NOW), false, ">180d out is track-only");
});

test("reconcile: create, touch, move, two-run cancel, archive", () => {
  const f = normalize([api()], NOW)[0];
  assert.deepEqual(reconcile({}, [f], NOW).map((a) => a.action), ["create"]);

  const state = { [launchKey(f)]: { ...f, calendar_event_id: "ev1", status: "scheduled" } };
  assert.deepEqual(reconcile(state, [f], NOW).map((a) => a.action), ["touch"]);

  const moved = { ...f, net_iso: "2026-10-22T23:30:00Z" };
  const up = reconcile(state, [moved], NOW);
  assert.equal(up[0].action, "update");
  assert.equal(up[0].prev.calendar_event_id, "ev1");

  assert.deepEqual(reconcile(state, [], NOW).map((a) => a.action), ["miss"], "one missing run is tolerated");
  const missedOnce = { [launchKey(f)]: { ...state[launchKey(f)], missing_runs: 1 } };
  assert.deepEqual(reconcile(missedOnce, [], NOW).map((a) => a.action), ["cancel"]);

  const past = { k: { ...f, net_iso: "2026-10-01T00:00:00Z" } };
  assert.deepEqual(reconcile(past, [], NOW).map((a) => a.action), ["archive"]);
});

test("reconcile: a month-precision launch firming to a day gets its event", () => {
  const coarse = normalize([api({ net_precision: { name: "Month" } })], NOW)[0];
  const state = { [launchKey(coarse)]: { ...coarse, calendar_event_id: null, status: "scheduled" } };
  const firm = normalize([api({ net_precision: { name: "Day" } })], NOW)[0];
  assert.equal(reconcile(state, [firm], NOW)[0].action, "update");
});

test("hold window: real launch window in the given zone, DST-aware", () => {
  const l = normalize([api()], NOW)[0];
  assert.deepEqual(holdWindow(l, TZ), { from: "2026-10-21T10:30:00+11:00", to: "2026-10-21T12:00:00+11:00" });
  assert.equal(localRfc3339(Date.parse("2026-06-01T17:00:00Z"), TZ), "2026-06-02T03:00:00+10:00");
  assert.equal(localRfc3339(Date.parse("2026-12-01T17:00:00Z")), "2026-12-01T17:00:00+00:00", "UTC when no zone is given");
});

test("ping lines: only creates, >6h moves and cancels", () => {
  const f = normalize([api()], NOW)[0];
  const small = { ...f, net_iso: "2026-10-21T01:30:00Z" };
  const big = { ...f, net_iso: "2026-10-23T23:30:00Z" };
  const lines = pingLines([
    { action: "create", launch: f },
    { action: "update", launch: small, prev: f },
    { action: "update", launch: big, prev: f },
    { action: "cancel", prev: f },
  ], TZ);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^• ADDED Rocket Flight 15 — 2026-10-21 10:30 Sydney Time/);
  assert.match(lines[1], /^• MOVED/);
  assert.match(lines[2], /^• REMOVED/);
});

test("cadence gate: imminent launch, stale check, fresh check, no state", () => {
  const day = 86400_000;
  assert.equal(shouldRun(null, NOW), true, "first run");
  assert.equal(shouldRun({ last_check_at: new Date(NOW - day).toISOString(), launches: {} }, NOW), false);
  assert.equal(shouldRun({ last_check_at: new Date(NOW - 7 * day).toISOString(), launches: {} }, NOW), true);
  const soon = { a: { net_iso: new Date(NOW + 3 * day).toISOString(), status: "scheduled" } };
  assert.equal(shouldRun({ last_check_at: new Date(NOW - day).toISOString(), launches: soon }, NOW), true);
  const gone = { a: { net_iso: new Date(NOW + 3 * day).toISOString(), status: "removed" } };
  assert.equal(shouldRun({ last_check_at: new Date(NOW - day).toISOString(), launches: gone }, NOW), false);
});
