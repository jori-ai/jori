// weekly/monthly summary: windows on the local calendar, exact stats,
// home/away nights from the travel timeline, schema-checked model reply.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PS = require("../lib/period-summary.js");

test("weekly window is the Mon..Sun before a Monday", () => {
  assert.deepEqual(PS.windows("weekly", "2026-10-05"), { kind: "weekly", start: "2026-09-28", end: "2026-10-04" });
});

test("monthly window is the whole prior month, incl. leap Feb", () => {
  assert.deepEqual(PS.windows("monthly", "2026-10-01"), { kind: "monthly", start: "2026-09-01", end: "2026-09-30" });
  assert.deepEqual(PS.windows("monthly", "2028-03-01"), { kind: "monthly", start: "2028-02-01", end: "2028-02-29" });
});

test("stats: medians handle sleep after midnight, places dedupe, gaps listed", () => {
  const win = { kind: "weekly", start: "2026-09-28", end: "2026-09-30" };
  const rows = [
    { date: "2026-09-28", wake_at: "07:00", sleep_at: "23:30", commits_count: 3, key_events: [{ place: "Cafe One" }, { place: "Cafe One" }] },
    { date: "2026-09-30", wake_at: "08:00", sleep_at: "00:30", commits_count: 2, key_events: [{ place: "Bistro Two" }, "text event"] },
  ];
  const s = PS.stats(rows, win);
  assert.equal(s.days_with_data, 2);
  assert.deepEqual(s.missing_dates, ["2026-09-29"]);
  assert.equal(s.median_wake, "07:30");
  assert.equal(s.median_sleep, "00:00");
  assert.equal(s.total_commits, 5);
  assert.equal(s.distinct_named_places, 2);
});

test("nights: home metros vs away vs unknown", async () => {
  const win = { kind: "weekly", start: "2026-09-01", end: "2026-09-04" };
  const map = { "2026-09-01": { metro: "home-a" }, "2026-09-02": { metro: "away-c" }, "2026-09-03": { ambiguous: true, candidates: ["home-a", "home-b"] }, "2026-09-04": { metro: null } };
  const n = await PS.nights(win, async (w) => map[w.slice(0, 10)], new Set(["home-a", "home-b"]));
  assert.deepEqual(n, { home: 2, away: 1, unknown: 1, away_metros: { "away-c": 1 } });
});

test("validate enforces schema and size, not content", () => {
  const words = (n) => Array.from({ length: n }, () => "word").join(" ");
  assert.equal(PS.validate("weekly", { narrative: words(500), themes: ["a", "b", "c"] }).ok, true);
  assert.equal(PS.validate("weekly", { narrative: words(50), themes: ["a", "b", "c"] }).ok, false);
  assert.equal(PS.validate("monthly", { narrative: words(800), themes: ["a"] }).ok, false);
  assert.equal(PS.validate("weekly", null).ok, false);
});

test("html escapes and includes stats only for monthly", () => {
  const v = { narrative: "One <b>para</b>.\n\nTwo.", themes: ["x & y"] };
  const st = PS.stats([], { start: "2026-09-01", end: "2026-09-01" });
  const nt = { home: 0, away: 0, unknown: 1 };
  const w = PS.renderHtml({ kind: "weekly", start: "2026-09-28", end: "2026-10-04" }, st, nt, v);
  assert.ok(w.includes("&lt;b&gt;") && !w.includes("Nights home"));
  assert.ok(w.includes("Week of September 28–October 4 2026"));
  const m = PS.renderHtml({ kind: "monthly", start: "2026-09-01", end: "2026-09-30" }, st, nt, v);
  assert.ok(m.includes("Nights home / away") && m.includes("x &amp; y"));
});
