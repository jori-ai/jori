// location-ask-drift-filter.test.mjs — which location questions are dropped before
// they are asked: GPS drift (a small radius and a short dwell), a stop already
// answered (joined by visit id, or an explicit window overlap; free-text rows
// never match), and the meal word from the start-time bucket. Synthetic rows.
// Run: node --test tests/location-ask-drift-filter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDriftStop, alreadyAnswered, dwellMinutes } from "../lib/location-ask-filter.mjs";
import { mealWord, promptFacts } from "../lib/location-enrich-compose.mjs";

const e = (over = {}) => ({ visit_id: "v1", stop_started_at: "2026-10-19T10:00:00Z", stop_ended_at: "2026-10-19T10:10:00Z", signals: { drift_m: 40 }, ...over });

test("drift: small radius and short dwell drops", () => assert.equal(isDriftStop(e()), true));
test("drift: long dwell or large radius keeps", () => {
  assert.equal(isDriftStop(e({ stop_ended_at: "2026-10-19T10:30:00Z" })), false);
  assert.equal(isDriftStop(e({ signals: { drift_m: 228 } })), false);
});
test("drift: missing fields fail open", () => {
  assert.equal(isDriftStop(e({ signals: {} })), false);
  assert.equal(isDriftStop({ visit_id: "x", signals: { drift_m: 10 } }), false);
  assert.equal(dwellMinutes({ signals: { duration_min: 5 } }), 5);
});
test("answered: joined by id", () => {
  assert.equal(alreadyAnswered(e(), [{ answered_at: "t", visit_id: "v1" }]), true);
  assert.equal(alreadyAnswered(e(), [{ answered_at: "t", visit_id: "v2" }]), false);
  assert.equal(alreadyAnswered(e(), [{ visit_id: "v1" }]), false);
});
test("answered: id-less free-text rows never match; explicit window overlap does", () => {
  assert.equal(alreadyAnswered(e(), [{ answered_at: "t", subject: "location-ask-lunch", answer: "lunch" }]), false);
  assert.equal(alreadyAnswered(e(), [{ answered_at: "t", kind: "location_ask", stop_started_at: "2026-10-19T10:05:00Z", stop_ended_at: "2026-10-19T10:20:00Z" }]), true);
});
test("meal word follows the start-time bucket only", () => {
  assert.equal(mealWord({ time_of_day: "lunch" }), "lunch");
  assert.equal(mealWord({ time_of_day: "errand_appointment_or_visit" }), null);
  assert.equal(promptFacts({ visit_id: "v", time_of_day: "dinner", candidates: [] }).meal_word, "dinner");
});
