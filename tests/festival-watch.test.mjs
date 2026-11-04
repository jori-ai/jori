// festival-watch.test.mjs — presence windows, the monthly deep-band marker,
// and the cap/defer split that used to be done by hand in an agent turn.
//
// Run: node --test tests/festival-watch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseWindows, deepDue, scanWindows, festKey, capAndDefer, pruneSeen, metroCity, festivalConfig } from "../lib/festival-watch.mjs";

const day = (date, metro) => ({ date, metro, label: metro });

test("windows: consecutive same-metro days collapse; a one-day blip between the same metro is absorbed", () => {
  const w = collapseWindows([
    day("2026-10-04", "home"), day("2026-10-05", "home"), day("2026-10-06", "airport"), day("2026-10-07", "home"),
    day("2026-10-08", "coast"), day("2026-10-09", "coast"),
  ]);
  assert.deepEqual(w.map((x) => [x.metro, x.start, x.end]), [["home", "2026-10-04", "2026-10-07"], ["coast", "2026-10-08", "2026-10-09"]]);
});

test("windows: a lone travel day between two different metros is dropped", () => {
  const w = collapseWindows([day("2026-10-04", "home"), day("2026-10-05", "hub"), day("2026-10-06", "abroad"), day("2026-10-07", "abroad")]);
  assert.deepEqual(w.map((x) => x.metro), ["home", "abroad"]);
});

test("deep band: decided by last_deep_sweep_month; migration falls back to last_run's month", () => {
  assert.equal(deepDue({ last_deep_sweep_month: "2026-10" }, "2026-10"), false);
  assert.equal(deepDue({ last_deep_sweep_month: "2026-09" }, "2026-10"), true);
  assert.equal(deepDue({ last_run: "2026-10-01T09:00:00Z" }, "2026-10"), false);
  assert.equal(deepDue({}, "2026-10"), true);
});

test("scan windows: weekly trims to 30 days, deep reaches 90", () => {
  const w = [{ metro: "home", start: "2026-10-01", end: "2027-03-01" }];
  assert.equal(scanWindows(w, "2026-10-04", false)[0].end, "2026-11-03");
  assert.equal(scanWindows(w, "2026-10-04", true)[0].end, "2027-01-02");
  assert.equal(scanWindows([{ metro: "x", start: "2026-12-01", end: "2026-12-05" }], "2026-10-04", false).length, 0);
});

test("dedup key, cap/defer, prune", () => {
  assert.equal(festKey({ metro: "coast", name: "Harbour Art Fair Beach", start: "2026-12-04" }), "coast|harbour-art-fair-beach|2026-12-04");
  const evs = Array.from({ length: 12 }, (_, i) => ({ name: `e${i}`, start: `2026-10-${String(10 + i).padStart(2, "0")}` }));
  const { emailed, deferred } = capAndDefer(evs.reverse(), 10);
  assert.equal(emailed.length, 10);
  assert.deepEqual(deferred.map((e) => e.name), ["e10", "e11"]);
  assert.deepEqual(pruneSeen([{ start: "2026-09-01" }, { start: "2026-09-30" }, { start: "2026-09-01", end: "2026-10-01" }], "2026-10-04").length, 2);
  assert.equal(metroCity("far_city", {}), "Far City");
  assert.equal(metroCity("hc", { hc: "Home City" }), "Home City");
});

test("config: off by default (a fresh install scans nothing)", () => {
  const prev = process.env.JORI_LOCAL_DIR;
  process.env.JORI_LOCAL_DIR = "/nonexistent-jori-local";
  try {
    const c = festivalConfig();
    assert.equal(c.enabled, false);
    assert.deepEqual(c.fallback_metros, []);
  } finally { if (prev === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = prev; }
});
