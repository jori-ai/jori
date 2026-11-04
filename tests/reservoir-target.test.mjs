// reservoir-target — stay length → entry target.
// Run: node tests/reservoir-target.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { reservoirTarget, stayDays } = require("../lib/reservoir-target.js");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

t("same-day visit is one day", () => {
  assert.equal(stayDays("2026-10-05", "2026-10-05"), 1);
  assert.equal(stayDays("2026-10-05", "2026-10-08"), 3);
});

t("no or inverted window → no target", () => {
  assert.equal(reservoirTarget(null, "2026-10-05"), null);
  assert.equal(reservoirTarget("2026-10-08", "2026-10-05"), null);
});

t("one day lands in 10–15", () => {
  const r = reservoirTarget("2026-10-05", "2026-10-06");
  assert.ok(r.total >= 10 && r.total <= 15, `got ${r.total}`);
});

t("thirty days lands around 120", () => {
  const r = reservoirTarget("2026-10-01", "2026-10-31");
  assert.ok(Math.abs(r.total - 120) <= 3, `got ${r.total}`);
});

t("total grows with the stay but per-day density falls", () => {
  let prevTotal = 0, prevPerDay = Infinity;
  for (const d of [1, 2, 3, 5, 7, 10, 14, 21, 30, 45]) {
    const to = new Date(Date.UTC(2026, 9, 1) + d * 86400000).toISOString().slice(0, 10);
    const r = reservoirTarget("2026-10-01", to);
    assert.ok(r.total > prevTotal, `total not increasing at ${d}d`);
    assert.ok(r.total / d < prevPerDay, `per-day not decreasing at ${d}d`);
    prevTotal = r.total; prevPerDay = r.total / d;
  }
});

t("range brackets the total", () => {
  const r = reservoirTarget("2026-10-01", "2026-10-08");
  assert.ok(r.low < r.total && r.total < r.high);
});

console.log(`reservoir-target: ${pass} passed`);
