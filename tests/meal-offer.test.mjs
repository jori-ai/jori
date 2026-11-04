import test from "node:test";
import assert from "node:assert/strict";
import { mealWindow, alreadyOffered, isHome } from "../agent/scripts/hum-harvesters/meal_offer.mjs";

test("meal windows", () => {
  assert.equal(mealWindow(9), null);
  assert.equal(mealWindow(12.5)?.meal, "lunch");
  assert.equal(mealWindow(19)?.meal, "dinner");
  assert.equal(mealWindow(16), null);
  assert.equal(mealWindow(23), null);
});

test("one offer per meal window per day", () => {
  const tz = "UTC";
  const rows = [{ lane: "meal_offer", sent_at: "2026-10-20T12:30:00Z", findings: [{ supporting_data: { meal: "lunch" } }] }];
  assert.equal(alreadyOffered(rows, { date: "2026-10-20", meal: "lunch", tz }), true);
  assert.equal(alreadyOffered(rows, { date: "2026-10-20", meal: "dinner", tz }), false);
  assert.equal(alreadyOffered(rows, { date: "2026-10-21", meal: "lunch", tz }), false);
});

test("home labels suppress the offer", () => {
  const labels = ["home (", "example cottage"];
  assert.equal(isHome("Home (Example Street)", labels), true);
  assert.equal(isHome("Example Cottage", labels), true);
  assert.equal(isHome("Some Bistro", labels), false);
  assert.equal(isHome("", labels), false);
  assert.equal(isHome("Home (x)", []), false);
});
